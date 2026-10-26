use anchor_lang::prelude::*;

#[error_code]
pub enum MmError {
    #[msg("Only the venue authority may call this instruction")]
    Unauthorized,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Maker is not registered or has been deactivated")]
    MakerInactive,
    #[msg("Quote has expired")]
    QuoteExpired,
    #[msg("Quote expiry must be strictly in the future")]
    InvalidExpiry,
    #[msg("Quote has already been filled")]
    QuoteAlreadyFilled,
    #[msg("Quote is not designated to this taker")]
    QuoteNotForTaker,
    #[msg("Quote amounts are invalid")]
    InvalidAmount,
    #[msg("Instruction amount does not match the quoted amount")]
    AmountMismatch,
    #[msg("Input and output mint must differ")]
    SameMint,
    #[msg("Token account mint mismatch")]
    TokenMintMismatch,
    #[msg("Token account authority mismatch")]
    TokenAuthorityMismatch,
    #[msg("Vault is not owned by the expected PDA authority")]
    InvalidVault,
    #[msg("Maker inventory is insufficient for the quoted output amount")]
    MakerInventoryInsufficient,
    #[msg("Invalid configuration")]
    InvalidConfig,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
