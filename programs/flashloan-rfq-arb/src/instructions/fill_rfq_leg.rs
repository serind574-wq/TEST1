use crate::errors::ArbError;
use crate::events::LegFilled;
use crate::state::{ArbSession, SessionStage, SESSION_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use fixed_market_maker::program::FixedMarketMaker;
use fixed_market_maker::state::{MakerAccount, MmConfig, Quote};
use fixed_market_maker::cpi::accounts::SettleQuote as MmSettleQuote;

/// One RFQ leg. Called twice: `leg = 1` (borrowed mint -> intermediate) and `leg = 2`
/// (intermediate -> borrowed mint, i.e. back to the flash-borrowed token).
///
/// The instruction does not carry amounts: the price is whatever the maker signed into the
/// `Quote` account, and the session (written by `quote_arbitrage`) pins which quote is allowed
/// for which leg. That removes an entire class of "argument disagrees with account" bugs.
#[derive(Accounts)]
pub struct FillRfqLeg<'info> {
    #[account(
        mut,
        seeds = [SESSION_SEED, session.rfq.as_ref()],
        bump = session.bump
    )]
    pub session: Account<'info, ArbSession>,

    pub taker: Signer<'info>,

    #[account(mut)]
    pub quote: Account<'info, Quote>,

    pub maker_account: Account<'info, MakerAccount>,

    pub mm_config: Account<'info, MmConfig>,

    #[account(mut)]
    pub taker_input_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub taker_output_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub maker_input_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub maker_output_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority of `maker_input_vault`; re-derived by the market-maker program.
    pub maker_input_vault_authority: UncheckedAccount<'info>,

    /// CHECK: PDA authority of `maker_output_vault`; re-derived by the market-maker program.
    pub maker_output_vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    pub mm_program: Program<'info, FixedMarketMaker>,
}

pub fn handle_fill_rfq_leg(ctx: Context<FillRfqLeg>, leg: u8) -> Result<()> {
    let clock = Clock::get()?;

    // ---------------------------------------------------------------- session pinning
    let (
        session_taker,
        session_rfq,
        session_stage,
        session_quote1,
        session_quote2,
        session_mm1,
        session_mm2,
        session_borrow_ata,
        session_intermediate_ata,
        session_borrow_mint,
        session_intermediate_mint,
        leg1_filled,
        leg2_filled,
    ) = {
        let s = &ctx.accounts.session;
        (
            s.taker,
            s.rfq,
            s.stage,
            s.quote1,
            s.quote2,
            s.mm1,
            s.mm2,
            s.borrow_ata,
            s.intermediate_ata,
            s.borrow_mint,
            s.intermediate_mint,
            s.leg1_filled,
            s.leg2_filled,
        )
    };

    require_keys_eq!(
        session_taker,
        ctx.accounts.taker.key(),
        ArbError::Unauthorized
    );
    require!(session_stage == SessionStage::Quoted, ArbError::SessionNotOpen);

    let (expected_quote, expected_maker, expected_input, expected_output, expected_in_mint) = match leg {
        1 => (
            session_quote1,
            session_mm1,
            session_borrow_ata,
            session_intermediate_ata,
            session_borrow_mint,
        ),
        2 => (
            session_quote2,
            session_mm2,
            session_intermediate_ata,
            session_borrow_ata,
            session_intermediate_mint,
        ),
        _ => return err!(ArbError::InvalidConfig),
    };

    // Strict ordering: leg 2 may not run before leg 1, and neither may run twice.
    match leg {
        1 => require!(!leg1_filled, ArbError::QuoteAlreadyFilled),
        _ => {
            require!(leg1_filled, ArbError::LegOutOfOrder);
            require!(!leg2_filled, ArbError::QuoteAlreadyFilled);
        }
    }

    // ---------------------------------------------------------------- quote pinning
    let (quote_rfq, quote_maker, quote_filled, quote_expiry, quote_in, quote_out, quote_in_mint) = {
        let q = &ctx.accounts.quote;
        (
            q.rfq,
            q.maker,
            q.filled,
            q.expiry_slot,
            q.input_amount,
            q.output_amount,
            q.input_mint,
        )
    };
    require_keys_eq!(
        ctx.accounts.quote.key(),
        expected_quote,
        ArbError::SessionAccountMismatch
    );
    require_keys_eq!(quote_maker, expected_maker, ArbError::MakerMismatch);
    require_keys_eq!(quote_rfq, session_rfq, ArbError::QuoteRfqMismatch);
    require!(!quote_filled, ArbError::QuoteAlreadyFilled);
    require!(clock.slot <= quote_expiry, ArbError::QuoteExpired);
    require_keys_eq!(quote_in_mint, expected_in_mint, ArbError::TokenAccountMismatch);

    require_keys_eq!(
        ctx.accounts.taker_input_account.key(),
        expected_input,
        ArbError::SessionAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.taker_output_account.key(),
        expected_output,
        ArbError::SessionAccountMismatch
    );

    // ---------------------------------------------------------------- settle with the maker
    // Exactly quote_in in, exactly quote_out out: the arbitrage was priced on these numbers.
    let cpi_accounts = MmSettleQuote {
        config: ctx.accounts.mm_config.to_account_info(),
        quote: ctx.accounts.quote.to_account_info(),
        maker_account: ctx.accounts.maker_account.to_account_info(),
        taker: ctx.accounts.taker.to_account_info(),
        taker_input_account: ctx.accounts.taker_input_account.to_account_info(),
        taker_output_account: ctx.accounts.taker_output_account.to_account_info(),
        maker_input_vault: ctx.accounts.maker_input_vault.to_account_info(),
        maker_output_vault: ctx.accounts.maker_output_vault.to_account_info(),
        maker_input_vault_authority: ctx.accounts.maker_input_vault_authority.to_account_info(),
        maker_output_vault_authority: ctx.accounts.maker_output_vault_authority.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    fixed_market_maker::cpi::settle_quote(
        CpiContext::new(ctx.accounts.mm_program.to_account_info(), cpi_accounts),
        quote_in,
        quote_out,
    )?;

    ctx.accounts.quote.reload()?;
    require!(ctx.accounts.quote.filled, ArbError::QuoteAlreadyFilled);
    ctx.accounts.taker_output_account.reload()?;

    // ---------------------------------------------------------------- book-keeping
    let session_key = ctx.accounts.session.key();
    let quote_key = ctx.accounts.quote.key();
    let session = &mut ctx.accounts.session;
    if leg == 1 {
        session.leg1_filled = true;
        session.realized_leg1_out = quote_out;
    } else {
        session.leg2_filled = true;
        session.realized_leg2_out = quote_out;
    }

    emit!(LegFilled {
        session: session_key,
        leg,
        quote: quote_key,
        maker: quote_maker,
        amount_in: quote_in,
        amount_out: quote_out,
    });
    Ok(())
}
