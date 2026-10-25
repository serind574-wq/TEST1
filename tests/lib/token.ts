/** SPL Token account / mint byte layouts (165 and 82 bytes), used by the local VM. */
import { base58ToBytes, bytesToBase58 } from './anchor';

export const TOKEN_ACCOUNT_LEN = 165;
export const MINT_LEN = 82;

export const TOKEN_ACCOUNT_OFFSET = {
  mint: 0,
  owner: 32,
  amount: 64,
  delegate: 72,
  state: 108,
  isNative: 109,
  delegatedAmount: 121,
  closeAuthority: 129,
} as const;

export const MINT_OFFSET = {
  mintAuthority: 0,
  supply: 36,
  decimals: 44,
  isInitialized: 45,
  freezeAuthority: 46,
} as const;

export interface TokenAccountState {
  mint: string;
  owner: string;
  amount: bigint;
  state: number;
}

export function encodeTokenAccount(state: TokenAccountState): Buffer {
  const data = Buffer.alloc(TOKEN_ACCOUNT_LEN);
  base58ToBytes(state.mint).copy(data, TOKEN_ACCOUNT_OFFSET.mint);
  base58ToBytes(state.owner).copy(data, TOKEN_ACCOUNT_OFFSET.owner);
  data.writeBigUInt64LE(state.amount, TOKEN_ACCOUNT_OFFSET.amount);
  // COption<Pubkey> delegate: tag u32 = 0 (None)
  data.writeUInt32LE(0, TOKEN_ACCOUNT_OFFSET.delegate);
  data.writeUInt8(state.state, TOKEN_ACCOUNT_OFFSET.state);
  // COption is_native: 0, delegated_amount: 0, COption close_authority: 0
  data.writeUInt32LE(0, TOKEN_ACCOUNT_OFFSET.isNative);
  data.writeBigUInt64LE(0n, TOKEN_ACCOUNT_OFFSET.delegatedAmount);
  data.writeUInt32LE(0, TOKEN_ACCOUNT_OFFSET.closeAuthority);
  return data;
}

export function decodeTokenAccount(data: Buffer): TokenAccountState {
  if (data.length !== TOKEN_ACCOUNT_LEN) {
    throw new Error(`token account must be ${TOKEN_ACCOUNT_LEN} bytes, got ${data.length}`);
  }
  return {
    mint: bytesToBase58(data.subarray(TOKEN_ACCOUNT_OFFSET.mint, TOKEN_ACCOUNT_OFFSET.mint + 32)),
    owner: bytesToBase58(
      data.subarray(TOKEN_ACCOUNT_OFFSET.owner, TOKEN_ACCOUNT_OFFSET.owner + 32),
    ),
    amount: data.readBigUInt64LE(TOKEN_ACCOUNT_OFFSET.amount),
    state: data.readUInt8(TOKEN_ACCOUNT_OFFSET.state),
  };
}

export function setTokenAmount(data: Buffer, amount: bigint): void {
  if (amount < 0n) throw new Error('negative token amount');
  data.writeBigUInt64LE(amount, TOKEN_ACCOUNT_OFFSET.amount);
}

export interface MintState {
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
}

export function encodeMint(state: MintState): Buffer {
  const data = Buffer.alloc(MINT_LEN);
  if (state.mintAuthority) {
    data.writeUInt32LE(1, MINT_OFFSET.mintAuthority);
    base58ToBytes(state.mintAuthority).copy(data, MINT_OFFSET.mintAuthority + 4);
  }
  data.writeBigUInt64LE(state.supply, MINT_OFFSET.supply);
  data.writeUInt8(state.decimals, MINT_OFFSET.decimals);
  data.writeUInt8(1, MINT_OFFSET.isInitialized);
  data.writeUInt32LE(0, MINT_OFFSET.freezeAuthority);
  return data;
}

export function decodeMint(data: Buffer): MintState {
  if (data.length !== MINT_LEN) throw new Error(`mint must be ${MINT_LEN} bytes`);
  const hasAuthority = data.readUInt32LE(MINT_OFFSET.mintAuthority) === 1;
  return {
    mintAuthority: hasAuthority
      ? bytesToBase58(data.subarray(MINT_OFFSET.mintAuthority + 4, MINT_OFFSET.mintAuthority + 36))
      : null,
    supply: data.readBigUInt64LE(MINT_OFFSET.supply),
    decimals: data.readUInt8(MINT_OFFSET.decimals),
  };
}
