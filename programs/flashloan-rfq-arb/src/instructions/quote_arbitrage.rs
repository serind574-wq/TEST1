use crate::errors::ArbError;
use crate::events::ArbQuoted;
use crate::jupiter_lend::{
    inspect_flashloan_pipeline, FlashloanAdminState, FLASHLOAN_ADMIN_SEED,
};
use crate::math::{evaluate_round_trip, RoundTrip, BPS_DENOMINATOR};
use crate::state::{
    ArbConfig, ArbSession, RfqRequest, RfqStatus, SessionStage, CONFIG_SEED, SESSION_SEED,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::TokenAccount;
use fixed_market_maker::state::Quote;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct QuoteArbitrageArgs {
    /// Amount to flash borrow. Must equal the RFQ's `exact_input_amount`.
    pub borrow_amount: u64,
    /// Profit floor for this arbitrage, on top of the config floor.
    pub min_profit_amount: u64,
}

/// Accounts for the on-chain pre-quote. Everything the quote depends on is read from chain:
///
/// * `quote1` / `quote2` - firm quotes the makers already signed into existence,
/// * `quote1_output_vault` / `quote2_output_vault` - live inventory, so the quote cannot be
///   priced against liquidity that is not there,
/// * `flashloan_admin` - live Jupiter Lend fee + protocol status,
/// * `instruction_sysvar` - the transaction's own instruction list,
/// * `Clock` - the current slot.
///
/// No price, fee, or expiry is taken from instruction arguments or from an off-chain API.
#[derive(Accounts)]
pub struct QuoteArbitrage<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ArbConfig>,

    #[account(mut, has_one = taker @ ArbError::Unauthorized)]
    pub rfq: Account<'info, RfqRequest>,

    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        init,
        payer = taker,
        space = 8 + ArbSession::LEN,
        seeds = [SESSION_SEED, rfq.key().as_ref()],
        bump
    )]
    pub session: Account<'info, ArbSession>,

    /// Taker's token account for the borrowed mint (the one Jupiter Lend funds).
    #[account(mut)]
    pub borrow_ata: Account<'info, TokenAccount>,

    /// Taker's token account for the intermediate mint.
    #[account(mut)]
    pub intermediate_ata: Account<'info, TokenAccount>,

    /// Leg 1: borrowed mint -> intermediate mint.
    pub quote1: Account<'info, Quote>,
    /// Leg 2: intermediate mint -> borrowed mint.
    pub quote2: Account<'info, Quote>,

    /// Inventory that leg 1 will draw from (maker's intermediate mint vault).
    pub quote1_output_vault: Account<'info, TokenAccount>,
    /// Inventory that leg 2 will draw from (maker's borrowed mint vault).
    pub quote2_output_vault: Account<'info, TokenAccount>,

    /// CHECK: foreign Jupiter Lend account. Owned by the flashloan program, layout and PDA are
    /// validated in the handler.
    pub flashloan_admin: UncheckedAccount<'info>,

    /// CHECK: must be the instructions sysvar.
    #[account(address = ix_sysvar::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_quote_arbitrage(
    ctx: Context<QuoteArbitrage>,
    args: QuoteArbitrageArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    // Borrow the accounts through references (never `Clone`): the state account types stay
    // free of extra derives, and field-disjoint borrows keep the compiler happy while the
    // session is written at the end.
    let config = &ctx.accounts.config;
    let rfq = &ctx.accounts.rfq;
    let quote1 = &ctx.accounts.quote1;
    let quote2 = &ctx.accounts.quote2;
    let taker = ctx.accounts.taker.key();

    // ---------------------------------------------------------------- 1. request sanity
    require!(!config.paused, ArbError::Paused);
    require!(args.borrow_amount > 0, ArbError::InvalidBorrowAmount);
    require_keys_eq!(taker, rfq.taker, ArbError::Unauthorized);
    require!(rfq.status == RfqStatus::Open, ArbError::RfqNotOpen);
    require!(clock.slot <= rfq.expiry_slot, ArbError::RfqExpired);
    require_keys_eq!(
        rfq.input_mint,
        config.borrow_mint,
        ArbError::InvalidBorrowMint
    );
    require_keys_eq!(
        rfq.output_mint,
        config.intermediate_mint,
        ArbError::InvalidIntermediateMint
    );
    require_eq!(
        args.borrow_amount,
        rfq.exact_input_amount,
        ArbError::Leg1InputNotEqualBorrow
    );

    // ---------------------------------------------------------------- 2. quote identity
    // Both quotes must be quotes *for this RFQ*, signed by two distinct makers.
    require_keys_eq!(quote1.rfq, ctx.accounts.rfq.key(), ArbError::QuoteRfqMismatch);
    require_keys_eq!(quote2.rfq, ctx.accounts.rfq.key(), ArbError::QuoteRfqMismatch);
    require_keys_neq!(quote1.maker, quote2.maker, ArbError::MakerMismatch);
    if rfq.fixed_maker != Pubkey::default() {
        require_keys_eq!(quote1.maker, rfq.fixed_maker, ArbError::UnauthorizedMaker);
    }
    require_keys_eq!(
        quote1.designated_taker,
        rfq.taker,
        ArbError::QuoteTakerMismatch
    );
    require_keys_eq!(
        quote2.designated_taker,
        rfq.taker,
        ArbError::QuoteTakerMismatch
    );
    require!(!quote1.filled, ArbError::QuoteAlreadyFilled);
    require!(!quote2.filled, ArbError::QuoteAlreadyFilled);
    require!(clock.slot <= quote1.expiry_slot, ArbError::QuoteExpired);
    require!(clock.slot <= quote2.expiry_slot, ArbError::QuoteExpired);

    // ---------------------------------------------------------------- 3. round-trip route
    require_keys_eq!(
        quote1.input_mint,
        config.borrow_mint,
        ArbError::InvalidBorrowMint
    );
    require_keys_eq!(
        quote1.output_mint,
        config.intermediate_mint,
        ArbError::InvalidIntermediateMint
    );
    require_keys_eq!(
        quote2.input_mint,
        config.intermediate_mint,
        ArbError::InvalidIntermediateMint
    );
    require_keys_eq!(
        quote2.output_mint,
        config.borrow_mint,
        ArbError::RoundTripMismatch
    );
    require!(
        quote1.output_amount >= rfq.min_output_amount,
        ArbError::Leg1OutputBelowRfqMinimum
    );

    // The taker's token accounts must be the ones the maker settlements will touch.
    require_keys_eq!(
        ctx.accounts.borrow_ata.mint,
        config.borrow_mint,
        ArbError::TokenAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.borrow_ata.owner,
        rfq.taker,
        ArbError::TokenAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.intermediate_ata.mint,
        config.intermediate_mint,
        ArbError::TokenAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.intermediate_ata.owner,
        rfq.taker,
        ArbError::TokenAccountMismatch
    );

    // ---------------------------------------------------------------- 4. live inventory
    require_keys_eq!(
        ctx.accounts.quote1_output_vault.mint,
        quote1.output_mint,
        ArbError::TokenAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.quote2_output_vault.mint,
        quote2.output_mint,
        ArbError::TokenAccountMismatch
    );
    // Vault authorities must be the market-maker venue's PDAs for that maker and mint.
    let (expected_vault1_authority, _) = Pubkey::find_program_address(
        &[
            fixed_market_maker::state::VAULT_AUTHORITY_SEED,
            quote1.maker.as_ref(),
            quote1.output_mint.as_ref(),
        ],
        &config.mm_program,
    );
    let (expected_vault2_authority, _) = Pubkey::find_program_address(
        &[
            fixed_market_maker::state::VAULT_AUTHORITY_SEED,
            quote2.maker.as_ref(),
            quote2.output_mint.as_ref(),
        ],
        &config.mm_program,
    );
    require_keys_eq!(
        ctx.accounts.quote1_output_vault.owner,
        expected_vault1_authority,
        ArbError::TokenAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.quote2_output_vault.owner,
        expected_vault2_authority,
        ArbError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.quote1_output_vault.amount >= quote1.output_amount,
        ArbError::Unprofitable
    );
    require!(
        ctx.accounts.quote2_output_vault.amount >= quote2.output_amount,
        ArbError::Unprofitable
    );

    // ---------------------------------------------------------------- 5. on-chain loan terms
    // Jupiter Lend's fee and protocol status come from its own admin account, never from args.
    let admin_info = &ctx.accounts.flashloan_admin;
    require_keys_eq!(
        ctx.accounts.flashloan_admin.key(),
        config.flashloan_admin,
        ArbError::FlashloanAdminPdaMismatch
    );
    let (expected_admin, _) =
        Pubkey::find_program_address(&[FLASHLOAN_ADMIN_SEED], &config.flashloan_program);
    require_keys_eq!(
        ctx.accounts.flashloan_admin.key(),
        expected_admin,
        ArbError::FlashloanAdminPdaMismatch
    );
    require_keys_eq!(
        *admin_info.owner,
        config.flashloan_program,
        ArbError::FlashloanAdminOwnerMismatch
    );

    let admin = {
        let data = admin_info.try_borrow_data()?;
        FlashloanAdminState::decode(&data)?
    };
    require!(admin.status, ArbError::FlashloanProtocolInactive);
    require_keys_eq!(
        admin.liquidity_program,
        config.liquidity_program,
        ArbError::FlashloanLiquidityProgramMismatch
    );
    require!(
        admin.flashloan_fee_bps <= config.max_flashloan_fee_bps,
        ArbError::FlashloanFeeTooHigh
    );
    require!(
        (admin.flashloan_fee_bps as u64) <= BPS_DENOMINATOR,
        ArbError::FlashloanFeeTooHigh
    );
    let fee_bps = admin.flashloan_fee_bps;

    // ---------------------------------------------------------------- 6. price the round trip
    let rt: RoundTrip = evaluate_round_trip(
        args.borrow_amount,
        fee_bps,
        quote1.input_amount,
        quote1.output_amount,
        quote2.input_amount,
        quote2.output_amount,
    )?;

    require!(rt.profitable, ArbError::Unprofitable);
    require!(
        rt.net_profit >= args.min_profit_amount,
        ArbError::Unprofitable
    );
    require!(
        rt.net_profit >= config.min_profit_amount,
        ArbError::Unprofitable
    );

    // ---------------------------------------------------------------- 7. loan <-> trade wiring
    //
    // The borrow instruction precedes this one (Jupiter Lend requires a matching payback later in
    // the transaction, and this program requires the borrow earlier), so the principal is already
    // sitting in the taker's token account. The *pre-loan* balance - the baseline settlement is
    // measured against - is therefore the current balance minus the principal.
    let mut pre_loan_borrow_balance = ctx.accounts.borrow_ata.amount;
    if config.enforce_flashloan_pipeline {
        inspect_flashloan_pipeline(
            &ctx.accounts.instruction_sysvar,
            &config.flashloan_program,
            args.borrow_amount,
            &taker,
            &ctx.accounts.borrow_ata.key(),
            &config.borrow_mint,
        )?;
        require!(
            ctx.accounts.borrow_ata.amount >= args.borrow_amount,
            ArbError::FlashloanAccountMismatch
        );
        pre_loan_borrow_balance = ctx.accounts.borrow_ata.amount - args.borrow_amount;
    }

    // ---------------------------------------------------------------- 8. record the session
    let session_key = ctx.accounts.session.key();
    let session = &mut ctx.accounts.session;
    session.rfq = ctx.accounts.rfq.key();
    session.taker = rfq.taker;
    session.borrow_mint = config.borrow_mint;
    session.intermediate_mint = config.intermediate_mint;
    session.mm1 = quote1.maker;
    session.mm2 = quote2.maker;
    session.quote1 = ctx.accounts.quote1.key();
    session.quote2 = ctx.accounts.quote2.key();
    session.borrow_ata = ctx.accounts.borrow_ata.key();
    session.intermediate_ata = ctx.accounts.intermediate_ata.key();
    session.borrow_amount = args.borrow_amount;
    session.flashloan_fee = rt.flashloan_fee;
    session.required_repayment = rt.required_repayment;
    session.min_profit_amount = core::cmp::max(args.min_profit_amount, config.min_profit_amount);
    session.projected_final_amount = rt.leg2_output;
    session.projected_net_profit = rt.net_profit;
    // Balances *before* the loan, so settlement can measure deltas instead of absolutes and a
    // taker's pre-existing inventory can never be booked as trading profit.
    session.pre_loan_borrow_balance = pre_loan_borrow_balance;
    session.pre_loan_intermediate_balance = ctx.accounts.intermediate_ata.amount;
    session.realized_leg1_out = 0;
    session.realized_leg2_out = 0;
    session.quote_slot = clock.slot;
    session.leg1_filled = false;
    session.leg2_filled = false;
    session.stage = SessionStage::Quoted;
    session.bump = ctx.bumps.session;

    emit!(ArbQuoted {
        session: session_key,
        rfq: session.rfq,
        taker: session.taker,
        borrow_mint: session.borrow_mint,
        intermediate_mint: session.intermediate_mint,
        mm1: session.mm1,
        mm2: session.mm2,
        borrow_amount: session.borrow_amount,
        leg1_output: quote1.output_amount,
        leg2_output: quote2.output_amount,
        flashloan_fee: session.flashloan_fee,
        flashloan_fee_bps: fee_bps,
        required_repayment: session.required_repayment,
        projected_net_profit: session.projected_net_profit,
        slot: clock.slot,
    });
    Ok(())
}
