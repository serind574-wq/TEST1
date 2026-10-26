use crate::errors::MmError;
use crate::events::{InventoryChanged, MakerRegistered, VaultInitialized};
use crate::state::{
    MakerAccount, MmConfig, MAKER_SEED, MM_CONFIG_SEED, VAULT_AUTHORITY_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct RegisterMaker<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(seeds = [MM_CONFIG_SEED], bump = mm_config.bump)]
    pub mm_config: Account<'info, MmConfig>,

    #[account(
        init,
        payer = maker,
        space = 8 + MakerAccount::LEN,
        seeds = [MAKER_SEED, maker.key().as_ref()],
        bump
    )]
    pub maker_account: Account<'info, MakerAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handle_register_maker(ctx: Context<RegisterMaker>) -> Result<()> {
    let maker_account = &mut ctx.accounts.maker_account;
    maker_account.authority = ctx.accounts.maker.key();
    maker_account.active = true;
    maker_account.quotes_posted = 0;
    maker_account.bump = ctx.bumps.maker_account;

    emit!(MakerRegistered {
        maker: maker_account.authority,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [MAKER_SEED, maker.key().as_ref()],
        bump = maker_account.bump,
        constraint = maker_account.authority == maker.key() @ MmError::Unauthorized
    )]
    pub maker_account: Account<'info, MakerAccount>,

    pub mint: Account<'info, Mint>,

    /// CHECK: PDA that owns the inventory vault. Verified by seeds.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, maker.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = maker,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_vault(ctx: Context<InitVault>) -> Result<()> {
    emit!(VaultInitialized {
        maker: ctx.accounts.maker.key(),
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.vault.key(),
        vault_authority: ctx.accounts.vault_authority.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DepositInventory<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [MAKER_SEED, maker.key().as_ref()],
        bump = maker_account.bump,
        constraint = maker_account.authority == maker.key() @ MmError::Unauthorized
    )]
    pub maker_account: Account<'info, MakerAccount>,

    #[account(mut)]
    pub maker_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority of `vault`, verified by seeds below.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, maker.key().as_ref(), vault.mint.as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_deposit_inventory(ctx: Context<DepositInventory>, amount: u64) -> Result<()> {
    require!(amount > 0, MmError::InvalidAmount);
    require_keys_eq!(
        ctx.accounts.maker_token_account.mint,
        ctx.accounts.vault.mint,
        MmError::TokenMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.maker_token_account.owner,
        ctx.accounts.maker.key(),
        MmError::TokenAuthorityMismatch
    );
    require_keys_eq!(
        ctx.accounts.vault.owner,
        ctx.accounts.vault_authority.key(),
        MmError::InvalidVault
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.maker_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.maker.to_account_info(),
            },
        ),
        amount,
    )?;
    // The cached `TokenAccount` is stale after the CPI: refresh it before reporting the balance.
    ctx.accounts.vault.reload()?;

    emit!(InventoryChanged {
        maker: ctx.accounts.maker.key(),
        mint: ctx.accounts.vault.mint,
        vault: ctx.accounts.vault.key(),
        amount,
        balance_after: ctx.accounts.vault.amount,
        deposit: true,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawInventory<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [MAKER_SEED, maker.key().as_ref()],
        bump = maker_account.bump,
        constraint = maker_account.authority == maker.key() @ MmError::Unauthorized
    )]
    pub maker_account: Account<'info, MakerAccount>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub maker_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA authority of `vault`, verified by seeds below.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, maker.key().as_ref(), vault.mint.as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw_inventory(ctx: Context<WithdrawInventory>, amount: u64) -> Result<()> {
    require!(amount > 0, MmError::InvalidAmount);
    require_keys_eq!(
        ctx.accounts.maker_token_account.mint,
        ctx.accounts.vault.mint,
        MmError::TokenMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.maker_token_account.owner,
        ctx.accounts.maker.key(),
        MmError::TokenAuthorityMismatch
    );
    require_keys_eq!(
        ctx.accounts.vault.owner,
        ctx.accounts.vault_authority.key(),
        MmError::InvalidVault
    );

    let maker_key = ctx.accounts.maker.key();
    let mint_key = ctx.accounts.vault.mint;
    let bump_array = [ctx.bumps.vault_authority];
    let seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        maker_key.as_ref(),
        mint_key.as_ref(),
        &bump_array,
    ];
    let signer: &[&[&[u8]]] = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.maker_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;
    ctx.accounts.vault.reload()?;

    emit!(InventoryChanged {
        maker: maker_key,
        mint: mint_key,
        vault: ctx.accounts.vault.key(),
        amount,
        balance_after: ctx.accounts.vault.amount,
        deposit: false,
    });
    Ok(())
}
