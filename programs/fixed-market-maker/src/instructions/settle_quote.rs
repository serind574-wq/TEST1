use crate::errors::MmError;
use crate::events::QuoteSettled;
use crate::state::{
    MakerAccount, MmConfig, Quote, MAKER_SEED, MM_CONFIG_SEED, QUOTE_SEED, VAULT_AUTHORITY_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

/// Settlement needs **no maker signature**:
///
/// * input leg  - `taker` signs (it is the outer transaction signer, and signature privileges
///   propagate through CPI),
/// * output leg - signed by the `["mm_vault", maker, mint]` PDA, whose seeds are derived from
///   the quote's own `maker` field.
///
/// Everything a maker cares about (which taker, which price, until when, only-once) is pinned
/// in the `Quote` account that the maker itself signed into existence.
#[derive(Accounts)]
pub struct SettleQuote<'info> {
    #[account(seeds = [MM_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MmConfig>,

    #[account(
        mut,
        seeds = [QUOTE_SEED, quote.rfq.as_ref(), quote.maker.as_ref()],
        bump = quote.bump,
        constraint = !quote.filled @ MmError::QuoteAlreadyFilled
    )]
    pub quote: Account<'info, Quote>,

    #[account(
        seeds = [MAKER_SEED, quote.maker.as_ref()],
        bump = maker_account.bump,
        constraint = maker_account.authority == quote.maker @ MmError::Unauthorized,
        constraint = maker_account.active @ MmError::MakerInactive
    )]
    pub maker_account: Account<'info, MakerAccount>,

    pub taker: Signer<'info>,

    #[account(mut)]
    pub taker_input_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub taker_output_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub maker_input_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub maker_output_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA that owns `maker_input_vault`. Seeds pin it to this quote's maker and mint.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, quote.maker.as_ref(), quote.input_mint.as_ref()],
        bump
    )]
    pub maker_input_vault_authority: UncheckedAccount<'info>,

    /// CHECK: PDA that owns `maker_output_vault`. Signs the deliver leg via CPI.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, quote.maker.as_ref(), quote.output_mint.as_ref()],
        bump
    )]
    pub maker_output_vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_settle_quote(
    ctx: Context<SettleQuote>,
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let taker = ctx.accounts.taker.key();

    // Copy the quote's fields out (all `Copy`) so the account can be borrowed mutably at the end
    // to flip `filled`, without holding a borrow across the CPI token transfers.
    let quote_key = ctx.accounts.quote.key();
    let quote_rfq = ctx.accounts.quote.rfq;
    let quote_maker = ctx.accounts.quote.maker;
    let quote_designated_taker = ctx.accounts.quote.designated_taker;
    let quote_input_mint = ctx.accounts.quote.input_mint;
    let quote_output_mint = ctx.accounts.quote.output_mint;
    let quote_input_amount = ctx.accounts.quote.input_amount;
    let quote_output_amount = ctx.accounts.quote.output_amount;
    let quote_expiry_slot = ctx.accounts.quote.expiry_slot;

    require!(!ctx.accounts.config.paused, MmError::Paused);
    require!(clock.slot <= quote_expiry_slot, MmError::QuoteExpired);
    require!(!ctx.accounts.quote.filled, MmError::QuoteAlreadyFilled);
    require_keys_eq!(taker, quote_designated_taker, MmError::QuoteNotForTaker);

    // The RFQ program asks for *exactly* the quoted price: the arbitrage was priced on it, so
    // slippage protection here is "no slippage".
    require_eq!(amount_in, quote_input_amount, MmError::AmountMismatch);
    require!(
        min_amount_out <= quote_output_amount,
        MmError::AmountMismatch
    );

    // Vaults must be program-owned PDAs of *this* maker.
    require_keys_eq!(
        ctx.accounts.maker_input_vault.owner,
        ctx.accounts.maker_input_vault_authority.key(),
        MmError::InvalidVault
    );
    require_keys_eq!(
        ctx.accounts.maker_output_vault.owner,
        ctx.accounts.maker_output_vault_authority.key(),
        MmError::InvalidVault
    );
    require_keys_eq!(
        ctx.accounts.maker_input_vault.mint,
        quote_input_mint,
        MmError::TokenMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.maker_output_vault.mint,
        quote_output_mint,
        MmError::TokenMintMismatch
    );
    require!(
        ctx.accounts.maker_output_vault.amount >= quote_output_amount,
        MmError::MakerInventoryInsufficient
    );

    require_keys_eq!(
        ctx.accounts.taker_input_account.mint,
        quote_input_mint,
        MmError::TokenMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.taker_output_account.mint,
        quote_output_mint,
        MmError::TokenMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.taker_input_account.owner,
        taker,
        MmError::TokenAuthorityMismatch
    );
    require_keys_eq!(
        ctx.accounts.taker_output_account.owner,
        taker,
        MmError::TokenAuthorityMismatch
    );

    // Leg A: taker pays -> maker inventory vault (signed by the taker).
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.taker_input_account.to_account_info(),
                to: ctx.accounts.maker_input_vault.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        amount_in,
    )?;

    // Leg B: maker inventory vault -> taker (signed by the vault PDA, no maker signature).
    let maker_key = quote_maker;
    let output_mint_key = quote_output_mint;
    let bump_array = [ctx.bumps.maker_output_vault_authority];
    let vault_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        maker_key.as_ref(),
        output_mint_key.as_ref(),
        &bump_array,
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.maker_output_vault.to_account_info(),
                to: ctx.accounts.taker_output_account.to_account_info(),
                authority: ctx.accounts.maker_output_vault_authority.to_account_info(),
            },
            &[vault_seeds],
        ),
        quote_output_amount,
    )?;

    ctx.accounts.quote.filled = true;
    ctx.accounts.maker_input_vault.reload()?;
    ctx.accounts.maker_output_vault.reload()?;
    ctx.accounts.taker_output_account.reload()?;

    emit!(QuoteSettled {
        rfq: quote_rfq,
        quote: quote_key,
        maker: quote_maker,
        taker,
        amount_in,
        amount_out: quote_output_amount,
        slot: clock.slot,
    });
    Ok(())
}
