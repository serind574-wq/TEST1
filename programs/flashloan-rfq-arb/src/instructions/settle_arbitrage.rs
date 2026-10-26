use crate::errors::ArbError;
use crate::events::ArbSettled;
use crate::state::{
    ArbConfig, ArbSession, RfqRequest, RfqStatus, SessionStage, CONFIG_SEED, SESSION_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

/// Post-trade proof, executed *before* the Jupiter Lend payback instruction:
///
/// 1. both RFQ legs must have settled inside this transaction,
/// 2. the taker's borrowed-mint account must hold `pre_loan_balance + repayment + profit`,
/// 3. the intermediate token must be flat again (no stranded inventory),
/// 4. the session is closed and its rent is refunded to the taker.
///
/// Because the whole transaction is atomic, a failure here reverts the loan as well - which is
/// what makes an under-collateralised flash loan impossible rather than merely unlikely.
#[derive(Accounts)]
pub struct SettleArbitrage<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ArbConfig>,

    #[account(mut, has_one = taker @ ArbError::Unauthorized)]
    pub rfq: Account<'info, RfqRequest>,

    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        mut,
        close = taker,
        seeds = [SESSION_SEED, session.rfq.as_ref()],
        bump = session.bump
    )]
    pub session: Account<'info, ArbSession>,

    #[account(mut)]
    pub borrow_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub intermediate_ata: Account<'info, TokenAccount>,
}

pub fn handle_settle_arbitrage(ctx: Context<SettleArbitrage>) -> Result<()> {
    let clock = Clock::get()?;
    let max_dust = ctx.accounts.config.max_intermediate_dust;

    let (
        session_key,
        session_rfq,
        session_taker,
        session_stage,
        leg1_filled,
        leg2_filled,
        borrow_mint,
        borrow_ata_key,
        intermediate_ata_key,
        required_repayment,
        min_profit,
        pre_borrow,
        pre_intermediate,
        projected_profit,
    ) = {
        let s = &ctx.accounts.session;
        (
            ctx.accounts.session.key(),
            s.rfq,
            s.taker,
            s.stage,
            s.leg1_filled,
            s.leg2_filled,
            s.borrow_mint,
            s.borrow_ata,
            s.intermediate_ata,
            s.required_repayment,
            s.min_profit_amount,
            s.pre_loan_borrow_balance,
            s.pre_loan_intermediate_balance,
            s.projected_net_profit,
        )
    };

    require_keys_eq!(session_taker, ctx.accounts.taker.key(), ArbError::Unauthorized);
    require_keys_eq!(session_rfq, ctx.accounts.rfq.key(), ArbError::SessionAccountMismatch);
    require!(session_stage == SessionStage::Quoted, ArbError::SessionNotOpen);
    require!(leg1_filled && leg2_filled, ArbError::LegsNotFilled);
    require!(ctx.accounts.rfq.status == RfqStatus::Open, ArbError::RfqNotOpen);

    require_keys_eq!(
        ctx.accounts.borrow_ata.key(),
        borrow_ata_key,
        ArbError::SessionAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.intermediate_ata.key(),
        intermediate_ata_key,
        ArbError::SessionAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.borrow_ata.mint,
        borrow_mint,
        ArbError::TokenAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.borrow_ata.owner,
        session_taker,
        ArbError::TokenAccountMismatch
    );

    // Repayment + profit, measured against the pre-loan balance so that a taker's pre-existing
    // funds can never be mistaken for trading profit.
    let min_balance = pre_borrow
        .checked_add(required_repayment)
        .and_then(|v| v.checked_add(min_profit))
        .ok_or_else(|| error!(ArbError::MathOverflow))?;
    let borrow_balance = ctx.accounts.borrow_ata.amount;
    require!(
        borrow_balance >= min_balance,
        ArbError::InsufficientRepaymentBalance
    );
    let realized_profit = borrow_balance
        .checked_sub(pre_borrow)
        .and_then(|v| v.checked_sub(required_repayment))
        .ok_or_else(|| error!(ArbError::MathOverflow))?;

    // The round trip must be flat in the intermediate token.
    let dust = ctx
        .accounts
        .intermediate_ata
        .amount
        .saturating_sub(pre_intermediate);
    require!(dust <= max_dust, ArbError::IntermediateDustTooHigh);

    ctx.accounts.rfq.status = RfqStatus::Filled;
    ctx.accounts.session.stage = SessionStage::Settled;

    emit!(ArbSettled {
        session: session_key,
        rfq: session_rfq,
        taker: session_taker,
        borrow_balance_after: borrow_balance,
        required_repayment,
        realized_net_profit: realized_profit,
        intermediate_dust: dust,
        slot: clock.slot,
    });
    let _ = projected_profit;
    Ok(())
}
