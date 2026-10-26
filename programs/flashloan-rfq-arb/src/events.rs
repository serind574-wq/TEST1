use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub mm_program: Pubkey,
    pub flashloan_program: Pubkey,
    pub borrow_mint: Pubkey,
    pub intermediate_mint: Pubkey,
}

#[event]
pub struct ProtocolPaused {
    pub paused: bool,
}

#[event]
pub struct RfqCreated {
    pub rfq: Pubkey,
    pub taker: Pubkey,
    pub fixed_maker: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub exact_input_amount: u64,
    pub min_output_amount: u64,
    pub expiry_slot: u64,
    pub nonce: u64,
}

#[event]
pub struct RfqClosed {
    pub rfq: Pubkey,
    pub taker: Pubkey,
    pub status: u8,
}

/// Emitted by the on-chain pre-quote. Everything else in the pipeline re-reads the session
/// instead of trusting instruction arguments, so this event is the auditable record of the
/// exact numbers the loan was opened against.
#[event]
pub struct ArbQuoted {
    pub session: Pubkey,
    pub rfq: Pubkey,
    pub taker: Pubkey,
    pub borrow_mint: Pubkey,
    pub intermediate_mint: Pubkey,
    pub mm1: Pubkey,
    pub mm2: Pubkey,
    pub borrow_amount: u64,
    pub leg1_output: u64,
    pub leg2_output: u64,
    pub flashloan_fee: u64,
    pub flashloan_fee_bps: u16,
    pub required_repayment: u64,
    pub projected_net_profit: u64,
    pub slot: u64,
}

#[event]
pub struct LegFilled {
    pub session: Pubkey,
    pub leg: u8,
    pub quote: Pubkey,
    pub maker: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct ArbSettled {
    pub session: Pubkey,
    pub rfq: Pubkey,
    pub taker: Pubkey,
    pub borrow_balance_after: u64,
    pub required_repayment: u64,
    pub realized_net_profit: u64,
    pub intermediate_dust: u64,
    pub slot: u64,
}
