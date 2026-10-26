use anchor_lang::prelude::*;

#[error_code]
pub enum ArbError {
    #[msg("Borrow amount must be greater than zero")]
    InvalidBorrowAmount,
    #[msg("RFQ has expired")]
    RfqExpired,
    #[msg("RFQ is not open")]
    RfqNotOpen,
    #[msg("RFQ input mint does not match the configured borrow mint")]
    InvalidBorrowMint,
    #[msg("RFQ output mint does not match the configured intermediate mint")]
    InvalidIntermediateMint,
    #[msg("RFQ mints are invalid")]
    InvalidRfqMints,
    #[msg("Quote does not belong to this RFQ")]
    QuoteRfqMismatch,
    #[msg("The two legs must be quoted by two distinct market makers")]
    MakerMismatch,
    #[msg("Leg 1 is not quoted by the RFQ's fixed maker")]
    UnauthorizedMaker,
    #[msg("Quote was not designated to this taker")]
    QuoteTakerMismatch,
    #[msg("Quote has expired")]
    QuoteExpired,
    #[msg("Quote has already been filled")]
    QuoteAlreadyFilled,
    #[msg("Leg 1 input amount must equal the borrowed amount exactly")]
    Leg1InputNotEqualBorrow,
    #[msg("Leg 1 output does not satisfy the RFQ minimum output")]
    Leg1OutputBelowRfqMinimum,
    #[msg("Leg 2 input must equal leg 1 output exactly")]
    IntermediateAmountMismatch,
    #[msg("Leg 2 output mint must be the borrowed mint (round trip)")]
    RoundTripMismatch,
    #[msg("Projected net profit is below the required threshold")]
    Unprofitable,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Flashloan fee is above the configured maximum")]
    FlashloanFeeTooHigh,
    #[msg("Flashloan admin account is not owned by the flashloan program")]
    FlashloanAdminOwnerMismatch,
    #[msg("Flashloan admin address is not the flashloan program's admin PDA")]
    FlashloanAdminPdaMismatch,
    #[msg("Flashloan admin account has an unexpected size")]
    FlashloanAdminInvalidSize,
    #[msg("Flashloan protocol is not active")]
    FlashloanProtocolInactive,
    #[msg("Flashloan admin advertises a different liquidity program")]
    FlashloanLiquidityProgramMismatch,
    #[msg("Flashloan borrow instruction not found in this transaction")]
    FlashloanBorrowNotFound,
    #[msg("Flashloan payback instruction not found in this transaction")]
    FlashloanPaybackNotFound,
    #[msg("Multiple flashloan borrow/payback instructions found")]
    FlashloanDuplicateInstruction,
    #[msg("Flashloan payback must be the last instruction in the transaction")]
    FlashloanPaybackNotLast,
    #[msg("Flashloan borrow must precede the RFQ quote instruction")]
    FlashloanBorrowNotFirst,
    #[msg("Flashloan instruction amount does not match")]
    FlashloanAmountMismatch,
    #[msg("Flashloan instruction references unexpected accounts")]
    FlashloanAccountMismatch,
    #[msg("Instruction sysvar could not be read")]
    InstructionSysvarUnavailable,
    #[msg("Arbitrage session is already settled")]
    SessionNotOpen,
    #[msg("Leg 2 cannot be filled before leg 1")]
    LegOutOfOrder,
    #[msg("Both legs must be filled before settlement")]
    LegsNotFilled,
    #[msg("Token account does not match the session")]
    SessionAccountMismatch,
    #[msg("Post-trade balance does not cover repayment plus minimum profit")]
    InsufficientRepaymentBalance,
    #[msg("Intermediate token dust exceeds the configured tolerance")]
    IntermediateDustTooHigh,
    #[msg("Token account mint or authority mismatch")]
    TokenAccountMismatch,
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Invalid configuration")]
    InvalidConfig,
}
