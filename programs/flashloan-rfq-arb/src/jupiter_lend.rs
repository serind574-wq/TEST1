//! Adapter for Jupiter Lend's flashloan program (`jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`).
//!
//! Jupiter Lend does **not** expose a CPI callback interface: `flashloan_borrow` and
//! `flashloan_payback` must be top-level instructions in the same transaction, and `borrow`
//! refuses to run when it is reached through CPI (the program compares the stack height to the
//! transaction level and returns `FLASHLOAN_CPICALL_NOT_ALLOWED`, error 6012). `borrow` then
//! introspects the instruction sysvar and reverts with `FLASHLOAN_PAYBACK_NOT_FOUND` (6009) if
//! it cannot find exactly one matching `payback` later in the transaction.
//!
//! Consequences for this program, and how it is designed around them:
//!
//! * We never CPI into Jupiter Lend. The two flashloan instructions are scheduled directly by
//!   the transaction builder (`tests/lib/pipeline.ts` / `client/`), and our own instructions sit
//!   *between* them.
//! * Because a loan can only be opened this way, the RFQ must be priced **before** the loan is
//!   opened. That is `quote_arbitrage`: it reads the firm on-chain quotes, the on-chain fee from
//!   the `FlashloanAdmin` account, the on-chain clock, and the transaction's own instruction
//!   list, and reverts if the round trip cannot repay the loan plus the profit floor.
//! * We re-implement the same sysvar introspection for our own guarantee: the taker must have
//!   scheduled `borrow` earlier in the transaction and exactly one `payback` as the last
//!   instruction. If that structure is missing we abort before any capital moves.
//!
//! All layout knowledge below is taken from the official IDL
//! (`fixtures/idl/flashloan.json`, `flashloan` program v0.1.4).

use crate::errors::ArbError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

/// Seed of the singleton admin PDA: `["flashloan_admin"]` under the flashloan program.
pub const FLASHLOAN_ADMIN_SEED: &[u8] = b"flashloan_admin";

/// 8-byte discriminator + 85 bytes of Borsh fields (40 bytes of keys, no padding).
pub const FLASHLOAN_ADMIN_LEN: usize = 93;

/// `flashloan_borrow(u64)` instruction discriminator.
pub const IX_FLASHLOAN_BORROW: [u8; 8] = [103, 19, 78, 24, 240, 9, 135, 63];
/// `flashloan_payback(u64)` instruction discriminator.
pub const IX_FLASHLOAN_PAYBACK: [u8; 8] = [213, 47, 153, 137, 84, 243, 94, 232];

/// Account indices inside `flashloan_borrow` / `flashloan_payback` (from the IDL).
pub mod flashloan_ix_accounts {
    /// 0: signer (the taker / borrower)
    pub const SIGNER: usize = 0;
    /// 1: flashloan admin PDA
    pub const ADMIN: usize = 1;
    /// 2: the borrower's token account for `mint`
    pub const SIGNER_BORROW_TOKEN_ACCOUNT: usize = 2;
    /// 3: the borrowed mint
    pub const MINT: usize = 3;
    /// 10: Token program
    pub const TOKEN_PROGRAM: usize = 10;
    /// Highest account index we read.
    pub const MAX_INDEXED: usize = 10;
}

/// Byte offsets inside the `FlashloanAdmin` account (Borsh, unaligned).
pub mod flashloan_admin_offset {
    pub const AUTHORITY: usize = 8;
    pub const LIQUIDITY_PROGRAM: usize = 40;
    pub const STATUS: usize = 72;
    pub const FLASHLOAN_FEE: usize = 73;
    pub const FLASHLOAN_TIMESTAMP: usize = 75;
    pub const IS_FLASHLOAN_ACTIVE: usize = 83;
    pub const ACTIVE_FLASHLOAN_AMOUNT: usize = 84;
    pub const BUMP: usize = 92;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlashloanAdminState {
    pub authority: Pubkey,
    pub liquidity_program: Pubkey,
    pub status: bool,
    pub flashloan_fee_bps: u16,
    pub flashloan_timestamp: u64,
    pub is_flashloan_active: bool,
    pub active_flashloan_amount: u64,
    pub bump: u8,
}

fn read_pubkey(data: &[u8], at: usize) -> Pubkey {
    let mut out = [0u8; 32];
    out.copy_from_slice(&data[at..at + 32]);
    Pubkey::new_from_array(out)
}

fn read_u16(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

fn read_u64(data: &[u8], at: usize) -> u64 {
    let mut out = [0u8; 8];
    out.copy_from_slice(&data[at..at + 8]);
    u64::from_le_bytes(out)
}

impl FlashloanAdminState {
    /// Decode the live Jupiter Lend admin account.
    ///
    /// Deliberately manual: the account is a foreign account, so we pin the exact layout we
    /// verified against the published IDL instead of trusting a Borsh derive.
    pub fn decode(data: &[u8]) -> Result<Self> {
        require!(
            data.len() == FLASHLOAN_ADMIN_LEN,
            ArbError::FlashloanAdminInvalidSize
        );
        Ok(Self {
            authority: read_pubkey(data, flashloan_admin_offset::AUTHORITY),
            liquidity_program: read_pubkey(data, flashloan_admin_offset::LIQUIDITY_PROGRAM),
            status: data[flashloan_admin_offset::STATUS] != 0,
            flashloan_fee_bps: read_u16(data, flashloan_admin_offset::FLASHLOAN_FEE),
            flashloan_timestamp: read_u64(data, flashloan_admin_offset::FLASHLOAN_TIMESTAMP),
            is_flashloan_active: data[flashloan_admin_offset::IS_FLASHLOAN_ACTIVE] != 0,
            active_flashloan_amount: read_u64(
                data,
                flashloan_admin_offset::ACTIVE_FLASHLOAN_AMOUNT,
            ),
            bump: data[flashloan_admin_offset::BUMP],
        })
    }
}

/// Where the flashloan instructions sit in the transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlashloanPipeline {
    pub current_index: usize,
    pub borrow_index: usize,
    pub payback_index: usize,
    pub instruction_count: usize,
}

fn parse_amount(data: &[u8]) -> Option<u64> {
    if data.len() != 16 {
        return None;
    }
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&data[8..16]);
    Some(u64::from_le_bytes(raw))
}

fn discriminator(data: &[u8]) -> Option<[u8; 8]> {
    if data.len() < 8 {
        return None;
    }
    let mut out = [0u8; 8];
    out.copy_from_slice(&data[..8]);
    Some(out)
}

/// Scan the whole transaction from the instruction sysvar and locate the Jupiter Lend legs.
///
/// This is the same trick Jupiter Lend itself uses to prove that a payback exists; doing it in
/// reverse lets the RFQ program prove that the taker actually opened (and will close) the loan it
/// priced, before spending a single compute unit on the trade.
pub fn inspect_flashloan_pipeline(
    instruction_sysvar: &AccountInfo,
    flashloan_program: &Pubkey,
    amount: u64,
    signer: &Pubkey,
    borrow_token_account: &Pubkey,
    mint: &Pubkey,
) -> Result<FlashloanPipeline> {
    let current_index = load_current_index_checked(instruction_sysvar)
        .map_err(|_| error!(ArbError::InstructionSysvarUnavailable))? as usize;

    let mut borrow_index: Option<usize> = None;
    let mut payback_index: Option<usize> = None;
    let mut borrow_count = 0u32;
    let mut payback_count = 0u32;
    let mut index = 0usize;

    loop {
        let ix = match load_instruction_at_checked(index, instruction_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };

        if ix.program_id == *flashloan_program {
            let data = ix.data.as_slice();
            let disc = discriminator(data);
            let is_borrow = disc == Some(IX_FLASHLOAN_BORROW);
            let is_payback = disc == Some(IX_FLASHLOAN_PAYBACK);

            if is_borrow || is_payback {
                // Structure: exactly the accounts we expect, and exactly the amount we priced.
                require!(
                    ix.accounts.len() > flashloan_ix_accounts::MAX_INDEXED,
                    ArbError::FlashloanAccountMismatch
                );
                require_keys_eq!(
                    ix.accounts[flashloan_ix_accounts::SIGNER],
                    *signer,
                    ArbError::FlashloanAccountMismatch
                );
                require_keys_eq!(
                    ix.accounts[flashloan_ix_accounts::SIGNER_BORROW_TOKEN_ACCOUNT],
                    *borrow_token_account,
                    ArbError::FlashloanAccountMismatch
                );
                require_keys_eq!(
                    ix.accounts[flashloan_ix_accounts::MINT],
                    *mint,
                    ArbError::FlashloanAccountMismatch
                );
                require_eq!(
                    parse_amount(data).ok_or_else(|| error!(ArbError::FlashloanAmountMismatch))?,
                    amount,
                    ArbError::FlashloanAmountMismatch
                );

                if is_borrow {
                    borrow_count = borrow_count.saturating_add(1);
                    borrow_index = Some(index);
                } else {
                    payback_count = payback_count.saturating_add(1);
                    payback_index = Some(index);
                }
            }
        }

        index = index.saturating_add(1);
        // Bounded scan: a transaction can hold at most 64 instructions today.
        if index >= 64 {
            break;
        }
    }

    let instruction_count = index;
    require!(borrow_count > 0, ArbError::FlashloanBorrowNotFound);
    require!(payback_count > 0, ArbError::FlashloanPaybackNotFound);
    require!(
        borrow_count == 1 && payback_count == 1,
        ArbError::FlashloanDuplicateInstruction
    );

    let borrow_index = borrow_index.ok_or_else(|| error!(ArbError::FlashloanBorrowNotFound))?;
    let payback_index = payback_index.ok_or_else(|| error!(ArbError::FlashloanPaybackNotFound))?;

    // The loan must already be open when we price it, and the payback must close the transaction.
    require!(borrow_index < current_index, ArbError::FlashloanBorrowNotFirst);
    require!(
        payback_index + 1 == instruction_count,
        ArbError::FlashloanPaybackNotLast
    );

    Ok(FlashloanPipeline {
        current_index,
        borrow_index,
        payback_index,
        instruction_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_layout_is_93_bytes() {
        assert_eq!(flashloan_admin_offset::BUMP + 1, FLASHLOAN_ADMIN_LEN);
        assert_eq!(
            flashloan_admin_offset::ACTIVE_FLASHLOAN_AMOUNT + 8,
            flashloan_admin_offset::BUMP
        );
    }
}
