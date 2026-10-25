/** Real PDA / ATA derivation (ed25519 on-curve checks included, via @solana/web3.js). */
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SEP } from './constants';

export interface Pda {
  address: string;
  bump: number;
}

function find(seeds: (Buffer | Uint8Array)[], programId: string): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, new PublicKey(programId));
  return { address: address.toBase58(), bump };
}

export function u64Le(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

export const seedBuffer = (value: string): Buffer => Buffer.from(value, 'utf8');

export const pda = {
  config: (arbProgram: string): Pda => find([seedBuffer(SEP.config)], arbProgram),
  rfq: (arbProgram: string, taker: string, nonce: bigint): Pda =>
    find([seedBuffer(SEP.rfq), new PublicKey(taker).toBuffer(), u64Le(nonce)], arbProgram),
  session: (arbProgram: string, rfq: string): Pda =>
    find([seedBuffer(SEP.session), new PublicKey(rfq).toBuffer()], arbProgram),
  mmConfig: (mmProgram: string): Pda => find([seedBuffer(SEP.mmConfig)], mmProgram),
  maker: (mmProgram: string, maker: string): Pda =>
    find([seedBuffer(SEP.maker), new PublicKey(maker).toBuffer()], mmProgram),
  vaultAuthority: (mmProgram: string, maker: string, mint: string): Pda =>
    find(
      [seedBuffer(SEP.vaultAuthority), new PublicKey(maker).toBuffer(), new PublicKey(mint).toBuffer()],
      mmProgram,
    ),
  quote: (mmProgram: string, rfq: string, maker: string): Pda =>
    find([seedBuffer(SEP.quote), new PublicKey(rfq).toBuffer(), new PublicKey(maker).toBuffer()], mmProgram),
  flashloanAdmin: (flashloanProgram: string): Pda =>
    find([seedBuffer(SEP.flashloanAdmin)], flashloanProgram),
};

export function ata(mint: string, owner: string): string {
  // `allowOwnerOffCurve`: inventory vaults are owned by program PDAs.
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    true,
  ).toBase58();
}
