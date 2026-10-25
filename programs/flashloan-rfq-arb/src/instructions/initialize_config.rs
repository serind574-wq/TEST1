use crate::errors::ArbError;
use crate::events::{ConfigInitialized, ProtocolPaused};
use crate::jupiter_lend::FLASHLOAN_ADMIN_SEED;
use crate::math::BPS_DENOMINATOR;
use crate::state::{ArbConfig, CONFIG_SEED};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ConfigArgs {
    pub mm_program: Pubkey,
    pub flashloan_program: Pubkey,
    pub liquidity_program: Pubkey,
    pub borrow_mint: Pubkey,
    pub intermediate_mint: Pubkey,
    pub max_flashloan_fee_bps: u16,
    pub min_profit_amount: u64,
    pub max_intermediate_dust: u64,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(init, payer = admin, space = 8 + ArbConfig::LEN, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ArbConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
    require_keys_neq!(args.mm_program, Pubkey::default(), ArbError::InvalidConfig);
    require_keys_neq!(
        args.flashloan_program,
        Pubkey::default(),
        ArbError::InvalidConfig
    );
    require_keys_neq!(args.borrow_mint, args.intermediate_mint, ArbError::InvalidRfqMints);
    require!(
        args.max_flashloan_fee_bps <= BPS_DENOMINATOR as u16,
        ArbError::FlashloanFeeTooHigh
    );

    // The admin account is fully derived from the flashloan program: no trusted input.
    let (flashloan_admin, _) =
        Pubkey::find_program_address(&[FLASHLOAN_ADMIN_SEED], &args.flashloan_program);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.mm_program = args.mm_program;
    config.flashloan_program = args.flashloan_program;
    config.liquidity_program = args.liquidity_program;
    config.flashloan_admin = flashloan_admin;
    config.borrow_mint = args.borrow_mint;
    config.intermediate_mint = args.intermediate_mint;
    config.max_flashloan_fee_bps = args.max_flashloan_fee_bps;
    config.min_profit_amount = args.min_profit_amount;
    config.max_intermediate_dust = args.max_intermediate_dust;
    config.paused = false;
    config.enforce_flashloan_pipeline = true;
    config.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        admin: config.admin,
        mm_program: config.mm_program,
        flashloan_program: config.flashloan_program,
        borrow_mint: config.borrow_mint,
        intermediate_mint: config.intermediate_mint,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArbError::Unauthorized
    )]
    pub config: Account<'info, ArbConfig>,

    pub admin: Signer<'info>,
}

pub fn handle_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(ProtocolPaused { paused });
    Ok(())
}
