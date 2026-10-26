use anchor_lang::prelude::*;

/// Singleton program config: `["config"]`.
pub const CONFIG_SEED: &[u8] = b"config";
/// One RFQ per `(taker, nonce)`: `["rfq", taker, nonce_le]`.
pub const RFQ_SEED: &[u8] = b"rfq";
/// Transient per-transaction arbitrage session: `["session", rfq]`.
pub const SESSION_SEED: &[u8] = b"session";

#[account]
pub struct ArbConfig {
    pub admin: Pubkey,
    /// Fixed market maker venue that holds the inventory vaults and the signed quotes.
    pub mm_program: Pubkey,
    /// Jupiter Lend flashloan program (`jupgf...`).
    pub flashloan_program: Pubkey,
    /// Jupiter Lend liquidity program, as advertised by the flashloan admin account.
    pub liquidity_program: Pubkey,
    /// Jupiter Lend `["flashloan_admin"]` PDA under `flashloan_program`.
    pub flashloan_admin: Pubkey,
    /// Token that is flash borrowed (token A) and that the round trip must end in.
    pub borrow_mint: Pubkey,
    /// Intermediate token (token B) traded in both legs.
    pub intermediate_mint: Pubkey,
    /// Hard ceiling on the on-chain flashloan fee we are willing to price in.
    pub max_flashloan_fee_bps: u16,
    /// Absolute floor for realised profit, in `borrow_mint` base units.
    pub min_profit_amount: u64,
    /// Tolerated leftover of `intermediate_mint` after the round trip.
    pub max_intermediate_dust: u64,
    pub paused: bool,
    /// Enforce the instruction-sysvar check that a matching Jupiter Lend borrow exists earlier
    /// in this transaction and exactly one payback closes it.
    pub enforce_flashloan_pipeline: bool,
    pub bump: u8,
}

impl ArbConfig {
    pub const LEN: usize = 32 * 7 + 2 + 8 + 8 + 1 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RfqStatus {
    Open,
    Filled,
    Cancelled,
}

/// Taker's request for quote. Stored at `["rfq", taker, nonce]`.
#[account]
pub struct RfqRequest {
    pub taker: Pubkey,
    /// `Pubkey::default()` means "open to any maker"; otherwise leg 1 is restricted to it.
    pub fixed_maker: Pubkey,
    /// Token the taker gives (== flash borrowed mint).
    pub input_mint: Pubkey,
    /// Token the taker wants (== intermediate mint).
    pub output_mint: Pubkey,
    pub exact_input_amount: u64,
    pub min_output_amount: u64,
    pub expiry_slot: u64,
    pub nonce: u64,
    pub status: RfqStatus,
    pub bump: u8,
}

impl RfqRequest {
    pub const LEN: usize = 32 * 4 + 8 * 4 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SessionStage {
    Quoted,
    Settled,
}

/// Everything the pre-quote instruction proved, captured so the fill/settle instructions can
/// re-check it without trusting instruction arguments. Closed at settlement (rent -> taker),
/// which also makes the session re-initialisable and therefore replay-safe.
#[account]
pub struct ArbSession {
    pub rfq: Pubkey,
    pub taker: Pubkey,
    pub borrow_mint: Pubkey,
    pub intermediate_mint: Pubkey,
    pub mm1: Pubkey,
    pub mm2: Pubkey,
    pub quote1: Pubkey,
    pub quote2: Pubkey,
    pub borrow_ata: Pubkey,
    pub intermediate_ata: Pubkey,
    pub borrow_amount: u64,
    pub flashloan_fee: u64,
    pub required_repayment: u64,
    pub min_profit_amount: u64,
    pub projected_final_amount: u64,
    pub projected_net_profit: u64,
    pub pre_loan_borrow_balance: u64,
    pub pre_loan_intermediate_balance: u64,
    pub realized_leg1_out: u64,
    pub realized_leg2_out: u64,
    pub quote_slot: u64,
    pub leg1_filled: bool,
    pub leg2_filled: bool,
    pub stage: SessionStage,
    pub bump: u8,
}

impl ArbSession {
    pub const LEN: usize = 32 * 10 + 8 * 11 + 1 + 1 + 1 + 1;
}
