use crate::errors::ArbError;
use crate::events::{RfqClosed, RfqCreated};
use crate::state::{ArbConfig, RfqRequest, RfqStatus, CONFIG_SEED, RFQ_SEED};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CreateRfqArgs {
    /// Token the taker pays (the token that will be flash borrowed).
    pub input_mint: Pubkey,
    /// Token the taker wants (the intermediate token).
    pub output_mint: Pubkey,
    pub exact_input_amount: u64,
    pub min_output_amount: u64,
    pub expiry_slot: u64,
    /// `Pubkey::default()` = open to any maker; otherwise leg 1 is restricted to this maker.
    pub fixed_maker: Pubkey,
    pub nonce: u64,
}

#[derive(Accounts)]
#[instruction(args: CreateRfqArgs)]
pub struct CreateRfq<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ArbConfig>,

    #[account(
        init,
        payer = taker,
        space = 8 + RfqRequest::LEN,
        seeds = [RFQ_SEED, taker.key().as_ref(), args.nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub rfq: Account<'info, RfqRequest>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_rfq(ctx: Context<CreateRfq>, args: CreateRfqArgs) -> Result<()> {
    let clock = Clock::get()?;

    require!(args.exact_input_amount > 0, ArbError::InvalidBorrowAmount);
    require!(args.min_output_amount > 0, ArbError::InvalidRfqMints);
    require!(args.expiry_slot > clock.slot, ArbError::RfqExpired);
    require_keys_neq!(args.input_mint, args.output_mint, ArbError::InvalidRfqMints);
    require_keys_eq!(
        args.input_mint,
        ctx.accounts.config.borrow_mint,
        ArbError::InvalidBorrowMint
    );
    require_keys_eq!(
        args.output_mint,
        ctx.accounts.config.intermediate_mint,
        ArbError::InvalidIntermediateMint
    );

    let rfq_key = ctx.accounts.rfq.key();
    let rfq = &mut ctx.accounts.rfq;
    rfq.taker = ctx.accounts.taker.key();
    rfq.fixed_maker = args.fixed_maker;
    rfq.input_mint = args.input_mint;
    rfq.output_mint = args.output_mint;
    rfq.exact_input_amount = args.exact_input_amount;
    rfq.min_output_amount = args.min_output_amount;
    rfq.expiry_slot = args.expiry_slot;
    rfq.nonce = args.nonce;
    rfq.status = RfqStatus::Open;
    rfq.bump = ctx.bumps.rfq;

    emit!(RfqCreated {
        rfq: rfq_key,
        taker: rfq.taker,
        fixed_maker: rfq.fixed_maker,
        input_mint: rfq.input_mint,
        output_mint: rfq.output_mint,
        exact_input_amount: rfq.exact_input_amount,
        min_output_amount: rfq.min_output_amount,
        expiry_slot: rfq.expiry_slot,
        nonce: rfq.nonce,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseRfq<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(mut, close = taker, has_one = taker @ ArbError::Unauthorized)]
    pub rfq: Account<'info, RfqRequest>,
}

pub fn handle_close_rfq(ctx: Context<CloseRfq>) -> Result<()> {
    // A filled RFQ is historical record; only open/cancelled ones are reclaimable.
    require!(
        ctx.accounts.rfq.status != RfqStatus::Filled,
        ArbError::RfqNotOpen
    );
    emit!(RfqClosed {
        rfq: ctx.accounts.rfq.key(),
        taker: ctx.accounts.taker.key(),
        status: RfqStatus::Cancelled as u8,
    });
    Ok(())
}
