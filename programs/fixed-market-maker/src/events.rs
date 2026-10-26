use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub arb_program: Pubkey,
}

#[event]
pub struct ProtocolPaused {
    pub paused: bool,
}

#[event]
pub struct MakerRegistered {
    pub maker: Pubkey,
}

#[event]
pub struct VaultInitialized {
    pub maker: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub vault_authority: Pubkey,
}

#[event]
pub struct InventoryChanged {
    pub maker: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub balance_after: u64,
    pub deposit: bool,
}

#[event]
pub struct QuotePosted {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub maker: Pubkey,
    pub designated_taker: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_amount: u64,
    pub output_amount: u64,
    pub expiry_slot: u64,
}

#[event]
pub struct QuoteRevoked {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub maker: Pubkey,
}

#[event]
pub struct QuoteSettled {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub slot: u64,
}
