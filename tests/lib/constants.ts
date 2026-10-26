/** Fixed addresses used across the harness. All program ids come from the Rust `declare_id!`s. */
import { PublicKey } from '@solana/web3.js';

export const SEP = {
  config: 'config',
  rfq: 'rfq',
  session: 'session',
  mmConfig: 'mm_config',
  maker: 'maker',
  vaultAuthority: 'mm_vault',
  quote: 'quote',
  flashloanAdmin: 'flashloan_admin',
} as const;

export const PROGRAMS = {
  /** Jupiter Lend flashloan program (mainnet). */
  jupiterFlashloan: 'jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS',
  /** Jupiter Lend liquidity layer (mainnet). */
  jupiterLiquidity: 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system: '11111111111111111111111111111111',
  instructionSysvar: 'Sysvar1nstructions1111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
} as const;

export const MINTS = {
  /** Real mainnet USDC mint. */
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  /** Real mainnet wrapped SOL mint. */
  wsol: 'So11111111111111111111111111111111111111112',
} as const;

export const DECIMALS = { usdc: 6, wsol: 9 } as const;

export const USDC = (amount: number): bigint => BigInt(Math.round(amount * 1e6));
export const SOL = (amount: number): bigint => BigInt(Math.round(amount * 1e9));

/** Jupiter Lend's live `["flashloan_admin"]` PDA (derived, and matching the published fixture). */
export const JUPITER_FLASHLOAN_ADMIN = PublicKey.findProgramAddressSync(
  [Buffer.from(SEP.flashloanAdmin)],
  new PublicKey(PROGRAMS.jupiterFlashloan),
)[0].toBase58();

/**
 * Accounts 4/5/7/8 of Jupiter Lend's borrow/payback (reserve, borrow position, rate model,
 * reserve vault) are seeds of its *liquidity layer*, which is not part of the published IDL.
 * The reserve PDA below uses the documented `["reserve", mint]` seed; the rest are stable
 * stand-ins so the account *list* is exercised end to end.
 */
export const JUPITER_LIQUIDITY_ACCOUNTS = {
  reservesLiquidity: PublicKey.findProgramAddressSync(
    [Buffer.from('reserve'), new PublicKey(MINTS.usdc).toBuffer()],
    new PublicKey(PROGRAMS.jupiterLiquidity),
  )[0].toBase58(),
  borrowPosition: PublicKey.findProgramAddressSync(
    [Buffer.from('user_borrow'), Buffer.from('flashloan'), new PublicKey(MINTS.usdc).toBuffer()],
    new PublicKey(PROGRAMS.jupiterLiquidity),
  )[0].toBase58(),
  rateModel: PublicKey.findProgramAddressSync(
    [Buffer.from('rate_model'), new PublicKey(MINTS.usdc).toBuffer()],
    new PublicKey(PROGRAMS.jupiterLiquidity),
  )[0].toBase58(),
  vault: PublicKey.findProgramAddressSync(
    [Buffer.from('reserve_vault'), new PublicKey(MINTS.usdc).toBuffer()],
    new PublicKey(PROGRAMS.jupiterLiquidity),
  )[0].toBase58(),
  liquidity: PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_admin')],
    new PublicKey(PROGRAMS.jupiterLiquidity),
  )[0].toBase58(),
} as const;
