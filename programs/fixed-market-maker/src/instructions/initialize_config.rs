use crate::errors::MmError;
use crate::events::{ConfigInitialized, ProtocolPaused};
use crate::state::{MmConfig, MM_CONFIG_SEED};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(init, payer = authority, space = 8 + MmConfig::LEN, seeds = [MM_CONFIG_SEED], bump)]
    pub config: Account<'info, MmConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, arb_program: Pubkey) -> Result<()> {
    require_keys_neq!(arb_program, Pubkey::default(), MmError::InvalidConfig);

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.arb_program = arb_program;
    config.paused = false;
    config.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        authority: config.authority,
        arb_program,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        seeds = [MM_CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ MmError::Unauthorized
    )]
    pub config: Account<'info, MmConfig>,

    pub authority: Signer<'info>,
}

pub fn handle_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(ProtocolPaused { paused });
    Ok(())
}
