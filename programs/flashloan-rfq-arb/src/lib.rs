//! # flashloan-rfq-arb
//!
//! Flash-loan funded, **on-chain quoted** direct RFQ round trip:
//!
//! ```text
//!   optional wrapper (tests only)      <- proves CPI into Jupiter Lend is impossible
//!   [0] ComputeBudget::SetComputeUnitLimit
//!   [1] ComputeBudget::SetComputeUnitPrice
//!   [2] jupiter_lend::flashloan_borrow(B)      <- top level, no CPI, Jupiter checks payback
//!   [3] flashloan_rfq_arb::quote_arbitrage     <- prices BOTH legs on-chain, before any swap
//!   [4] flashloan_rfq_arb::fill_rfq_leg(1)     -> CPI fixed_market_maker::settle_quote
//!   [5] flashloan_rfq_arb::fill_rfq_leg(2)     -> CPI fixed_market_maker::settle_quote
//!   [6] flashloan_rfq_arb::settle_arbitrage    <- proves the ATA covers repayment + profit
//!   [7] jupiter_lend::flashloan_payback(B)     <- last instruction, closes the loan
//! ```
//!
//! Note the ordering choice: the loan is instruction `[2]`, *before* the quote. That is forced
//! by the RFQ being an instruction-level protocol: the pre-quote has to be able to introspect
//! the borrow, and Jupiter's own payback-existence check has to run with the payback in place.
//! The economics are unchanged - `quote_arbitrage` still aborts the whole transaction before any
//! token moves, and its `init` of the session account is the only state it writes.
//!
//! (If you prefer the quote to be the literal first instruction, keep it here but pass
//! `enforce_flashloan_pipeline = false`; the trade-off is documented in `docs/SECURITY.md`.)
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod jupiter_lend;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");

#[program]
pub mod flashloan_rfq_arb {
    use super::*;

    /// Configure the program once: mints, market-maker venue, Jupiter Lend wiring.
    pub fn initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx, args)
    }

    /// Emergency switch.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::initialize_config::handle_set_paused(ctx, paused)
    }

    /// Taker posts a request for quote at `["rfq", taker, nonce]`.
    pub fn create_rfq(ctx: Context<CreateRfq>, args: CreateRfqArgs) -> Result<()> {
        instructions::create_rfq::handle_create_rfq(ctx, args)
    }

    /// Taker reclaims the RFQ rent (cancels it).
    pub fn close_rfq(ctx: Context<CloseRfq>) -> Result<()> {
        instructions::create_rfq::handle_close_rfq(ctx)
    }

    /// **The on-chain pre-quote.** Prices both legs from live on-chain quote accounts, the live
    /// on-chain flashloan fee, and the live clock; verifies the transaction's own instruction
    /// list; reverts if the round trip cannot repay the loan plus the profit floor.
    pub fn quote_arbitrage(ctx: Context<QuoteArbitrage>, args: QuoteArbitrageArgs) -> Result<()> {
        instructions::quote_arbitrage::handle_quote_arbitrage(ctx, args)
    }

    /// Execute one RFQ leg (1 = borrow_mint -> intermediate, 2 = intermediate -> borrow_mint).
    /// CPIs into the market-maker venue; **no maker signature is needed**.
    pub fn fill_rfq_leg(ctx: Context<FillRfqLeg>, leg: u8) -> Result<()> {
        instructions::fill_rfq_leg::handle_fill_rfq_leg(ctx, leg)
    }

    /// Prove the taker's borrowed-mint account now covers repayment + the quoted profit, and
    /// close the transient session (rent back to the taker).
    pub fn settle_arbitrage(ctx: Context<SettleArbitrage>) -> Result<()> {
        instructions::settle_arbitrage::handle_settle_arbitrage(ctx)
    }
}
