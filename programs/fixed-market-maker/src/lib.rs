//! # fixed-market-maker
//!
//! A minimal, auditable **direct RFQ venue** shared by a small set of *fixed* market makers.
//!
//! The design goal is to make a maker quote **executable without the maker co-signing the
//! taker's transaction**, which is exactly what a flash-loan arbitrage requires (an atomic
//! transaction cannot wait for an off-chain MM to add its signature).
//!
//! Three primitives make that work:
//!
//! 1. `MakerAccount` - registry entry, one per maker authority.
//! 2. Inventory vaults - SPL token accounts whose **authority is the program PDA**
//!    `["mm_vault", maker, mint]`. The maker moves funds in/out with its own signature; once
//!    the funds are in the vault, the *program* (not the maker) is the token authority.
//! 3. `Quote` - a firm, signed, expiring quote for a specific RFQ and a specific taker.
//!    `post_quote` requires the maker's signature, so the quote is provably authorised by the
//!    maker. `settle_quote` then needs **only the taker's signature**, because both transfers
//!    are authorised either by the taker (input side) or by the vault PDA (output side).
//!
//! The program never routes through an aggregator and never holds an order book: RFQ
//! matching happens off-chain, attestation of the agreed price happens on-chain.
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf");

#[program]
pub mod fixed_market_maker {
    use super::*;

    /// Create the singleton config and bind the RFQ program that is allowed to consume quotes.
    pub fn initialize_config(ctx: Context<InitializeConfig>, arb_program: Pubkey) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx, arb_program)
    }

    /// Emergency switch. Pausing blocks new quotes and new settlements.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::initialize_config::handle_set_paused(ctx, paused)
    }

    /// Register `maker` as a fixed market maker.
    pub fn register_maker(ctx: Context<RegisterMaker>) -> Result<()> {
        instructions::maker::handle_register_maker(ctx)
    }

    /// Create the PDA-owned inventory vault for `mint` (ATA of the `["mm_vault", maker, mint]` PDA).
    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        instructions::maker::handle_init_vault(ctx)
    }

    /// Maker -> vault. Requires the maker's signature.
    pub fn deposit_inventory(ctx: Context<DepositInventory>, amount: u64) -> Result<()> {
        instructions::maker::handle_deposit_inventory(ctx, amount)
    }

    /// Vault -> maker. Signed by the vault PDA, so it also requires the maker's signature.
    pub fn withdraw_inventory(ctx: Context<WithdrawInventory>, amount: u64) -> Result<()> {
        instructions::maker::handle_withdraw_inventory(ctx, amount)
    }

    /// Publish a firm quote. **The maker's signature is the authorisation** of the price.
    pub fn post_quote(ctx: Context<PostQuote>, args: PostQuoteArgs) -> Result<()> {
        instructions::quote::handle_post_quote(ctx, args)
    }

    /// Cancel a quote that has not been filled yet (rent is refunded to the maker).
    pub fn revoke_quote(ctx: Context<RevokeQuote>) -> Result<()> {
        instructions::quote::handle_revoke_quote(ctx)
    }

    /// Atomic settlement of one quote leg. Callable directly by a taker, or via CPI from the
    /// RFQ arbitrage program. Only the taker signs - never the maker.
    pub fn settle_quote(
        ctx: Context<SettleQuote>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::settle_quote::handle_settle_quote(ctx, amount_in, min_amount_out)
    }
}
