use anchor_lang::prelude::*;

/// Wallet that controls the venue (may pause, may rebind the RFQ program).
pub const MM_CONFIG_SEED: &[u8] = b"mm_config";
/// One `MakerAccount` per maker authority.
pub const MAKER_SEED: &[u8] = b"maker";
/// Inventory vault authority: `["mm_vault", maker, mint]`.
pub const VAULT_AUTHORITY_SEED: &[u8] = b"mm_vault";
/// One `Quote` per `(rfq, maker)` pair: `["quote", rfq, maker]`.
pub const QUOTE_SEED: &[u8] = b"quote";

#[account]
pub struct MmConfig {
    pub authority: Pubkey,
    /// RFQ program expected to consume these quotes (informational: quotes are public and
    /// self-describing, so the venue does not need to parse foreign account layouts).
    pub arb_program: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl MmConfig {
    pub const LEN: usize = 32 + 32 + 1 + 1;
}

#[account]
pub struct MakerAccount {
    pub authority: Pubkey,
    pub active: bool,
    pub quotes_posted: u64,
    pub bump: u8,
}

impl MakerAccount {
    pub const LEN: usize = 32 + 1 + 8 + 1;
}

/// A firm, directional, expiring quote.
///
/// * `input_mint`  - what the maker **receives** (the taker pays this).
/// * `output_mint` - what the maker **delivers** (the taker receives this), funded from the
///   maker's PDA-owned inventory vault for `output_mint`.
/// * `designated_taker` - the only wallet allowed to settle the quote. This is what stops a
///   third party from sniping a quote that was priced for a specific arbitrage.
#[account]
pub struct Quote {
    pub rfq: Pubkey,
    pub maker: Pubkey,
    pub designated_taker: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_amount: u64,
    pub output_amount: u64,
    /// Slot based expiry (Solana slots, not wall-clock time).
    pub expiry_slot: u64,
    pub created_slot: u64,
    pub filled: bool,
    pub bump: u8,
}

impl Quote {
    pub const LEN: usize = 32 * 5 + 8 * 4 + 1 + 1;
}
