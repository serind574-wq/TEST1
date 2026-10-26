use crate::errors::MmError;
use crate::events::{QuotePosted, QuoteRevoked};
use crate::state::{
    MakerAccount, MmConfig, Quote, MAKER_SEED, MM_CONFIG_SEED, QUOTE_SEED, VAULT_AUTHORITY_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PostQuoteArgs {
    /// RFQ this quote answers. Only used as a PDA seed + a informational link: the venue does
    /// not need to deserialize the (foreign) RFQ account to be safe.
    pub rfq: Pubkey,
    /// Wallet allowed to settle. Use the RFQ taker - this prevents quote sniping.
    pub designated_taker: Pubkey,
    /// Mint the maker receives.
    pub input_mint: Pubkey,
    /// Mint the maker delivers from its PDA-owned inventory vault.
    pub output_mint: Pubkey,
    pub input_amount: u64,
    pub output_amount: u64,
    pub expiry_slot: u64,
}

#[derive(Accounts)]
#[instruction(args: PostQuoteArgs)]
pub struct PostQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [MM_CONFIG_SEED],
        bump = mm_config.bump,
        constraint = !mm_config.paused @ MmError::Paused
    )]
    pub mm_config: Account<'info, MmConfig>,

    #[account(
        mut,
        seeds = [MAKER_SEED, maker.key().as_ref()],
        bump = maker_account.bump,
        constraint = maker_account.authority == maker.key() @ MmError::Unauthorized,
        constraint = maker_account.active @ MmError::MakerInactive
    )]
    pub maker_account: Account<'info, MakerAccount>,

    #[account(
        init,
        payer = maker,
        space = 8 + Quote::LEN,
        seeds = [QUOTE_SEED, args.rfq.as_ref(), maker.key().as_ref()],
        bump
    )]
    pub quote: Account<'info, Quote>,

    /// Inventory vault that will fund `output_amount`. Checked here so a maker cannot post a
    /// quote it cannot honour; re-checked at settlement.
    #[account(mut, token::mint = args.output_mint)]
    pub maker_output_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority of `maker_output_vault`, verified by seeds.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, maker.key().as_ref(), args.output_mint.as_ref()],
        bump
    )]
    pub maker_output_vault_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_post_quote(ctx: Context<PostQuote>, args: PostQuoteArgs) -> Result<()> {
    let clock = Clock::get()?;

    require_keys_neq!(args.rfq, Pubkey::default(), MmError::InvalidConfig);
    require_keys_neq!(
        args.designated_taker,
        Pubkey::default(),
        MmError::QuoteNotForTaker
    );
    require_keys_neq!(args.input_mint, args.output_mint, MmError::SameMint);
    require!(args.input_amount > 0, MmError::InvalidAmount);
    require!(args.output_amount > 0, MmError::InvalidAmount);
    require!(args.expiry_slot > clock.slot, MmError::InvalidExpiry);
    require_keys_eq!(
        ctx.accounts.maker_output_vault.owner,
        ctx.accounts.maker_output_vault_authority.key(),
        MmError::InvalidVault
    );
    require!(
        ctx.accounts.maker_output_vault.amount >= args.output_amount,
        MmError::MakerInventoryInsufficient
    );

    let quote_key = ctx.accounts.quote.key();
    let quote = &mut ctx.accounts.quote;
    quote.rfq = args.rfq;
    quote.maker = ctx.accounts.maker.key();
    quote.designated_taker = args.designated_taker;
    quote.input_mint = args.input_mint;
    quote.output_mint = args.output_mint;
    quote.input_amount = args.input_amount;
    quote.output_amount = args.output_amount;
    quote.expiry_slot = args.expiry_slot;
    quote.created_slot = clock.slot;
    quote.filled = false;
    quote.bump = ctx.bumps.quote;

    let maker_account = &mut ctx.accounts.maker_account;
    maker_account.quotes_posted = maker_account
        .quotes_posted
        .checked_add(1)
        .ok_or(MmError::MathOverflow)?;

    emit!(QuotePosted {
        rfq: quote.rfq,
        quote: quote_key,
        maker: quote.maker,
        designated_taker: quote.designated_taker,
        input_mint: quote.input_mint,
        output_mint: quote.output_mint,
        input_amount: quote.input_amount,
        output_amount: quote.output_amount,
        expiry_slot: quote.expiry_slot,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        close = maker,
        seeds = [QUOTE_SEED, quote.rfq.as_ref(), maker.key().as_ref()],
        bump = quote.bump,
        has_one = maker @ MmError::Unauthorized,
        constraint = !quote.filled @ MmError::QuoteAlreadyFilled
    )]
    pub quote: Account<'info, Quote>,
}

pub fn handle_revoke_quote(ctx: Context<RevokeQuote>) -> Result<()> {
    emit!(QuoteRevoked {
        rfq: ctx.accounts.quote.rfq,
        quote: ctx.accounts.quote.key(),
        maker: ctx.accounts.maker.key(),
    });
    Ok(())
}
