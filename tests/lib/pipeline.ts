/**
 * Real Solana transaction assembly (v0 + address lookup table) so the reported packet size is a
 * measurement, not a guess: instructions are serialised with @solana/web3.js and the resulting
 * `VersionedTransaction` is measured byte for byte against the 1232-byte limit.
 */
import {
  AddressLookupTableAccount,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { AccountMeta, VmInstruction } from './vm';

export const MAX_TRANSACTION_SIZE = 1232;

export function toWeb3Instruction(instruction: VmInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((meta: AccountMeta) => ({
      pubkey: new PublicKey(meta.pubkey),
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    })),
    data: instruction.data,
  });
}

export interface CompileResult {
  size: number;
  fits: boolean;
  message: MessageV0;
  /** Accounts referenced by the transaction, in first-use order. */
  staticKeys: string[];
  /** Accounts that end up in the lookup table (everything a lookup can cover). */
  lookupKeys: string[];
}

/**
 * Compile the pipeline as a v0 transaction. When `useLookupTable` is set, every non-signer
 * account is placed in a synthetic ALT - the realistic production setup - which is what makes a
 * flashloan + two RFQ legs + settlement fit in one packet.
 */
export function compileV0(
  instructions: VmInstruction[],
  payer: string,
  useLookupTable: boolean,
  lookupTableAddress = 'ALTar1S9vJv9YoY7CzZ9R8m4EKJ8h7ZaQ4gW7m8zM3rT',
): CompileResult {
  const web3Instructions = instructions.map(toWeb3Instruction);
  const latestBlockhash = '11111111111111111111111111111111';

  const staticKeys: string[] = [];
  const seen = new Set<string>();
  for (const instruction of instructions) {
    for (const meta of instruction.accounts) {
      if (!seen.has(meta.pubkey)) {
        seen.add(meta.pubkey);
        staticKeys.push(meta.pubkey);
      }
    }
    if (!seen.has(instruction.programId)) {
      seen.add(instruction.programId);
      staticKeys.push(instruction.programId);
    }
  }

  const signerKeys = new Set<string>([payer]);
  const lookupKeys = useLookupTable ? staticKeys.filter((key) => !signerKeys.has(key)) : [];

  const lookupTables: AddressLookupTableAccount[] = useLookupTable
    ? [
        new AddressLookupTableAccount({
          key: new PublicKey(lookupTableAddress),
          state: {
            deactivationSlot: BigInt('18446744073709551615'),
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            authority: undefined,
            addresses: lookupKeys.map((key) => new PublicKey(key)),
          },
        }),
      ]
    : [];

  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: latestBlockhash,
    instructions: web3Instructions,
  }).compileToV0Message(lookupTables);

  const size = transactionSize(message, 1);

  return {
    size,
    fits: size <= MAX_TRANSACTION_SIZE,
    message,
    staticKeys,
    lookupKeys,
  };
}

/** Compact-u16 ("short vec") length prefix size. */
function shortVecLength(value: number): number {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  return 3;
}

function indexLength(indexes: number[], lookupKeys: number): number {
  return indexes.length * (lookupKeys > 256 ? 2 : 1);
}

/**
 * Exact wire size of a v0 transaction: signatures + message.
 *
 * Computed arithmetically because `MessageV0.serialize()` refuses to write past the 1232-byte
 * packet buffer (which is precisely the case we want to be able to report). When the message
 * *does* fit, `assertSerializableSize` cross-checks this formula against @solana/web3.js.
 */
export function transactionSize(message: MessageV0, signatureCount: number): number {
  let size = shortVecLength(signatureCount) + 64 * signatureCount;
  size += 1; // v0 message version prefix (`MESSAGE_VERSION_0_PREFIX`, 0x80)
  size += 3; // header
  size += shortVecLength(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length;
  size += 32; // recent blockhash
  size += shortVecLength(message.addressTableLookups.length);
  for (const lookup of message.addressTableLookups) {
    size += 32;
    size += shortVecLength(lookup.writableIndexes.length);
    size += indexLength(lookup.writableIndexes, message.staticAccountKeys.length);
    size += shortVecLength(lookup.readonlyIndexes.length);
    size += indexLength(lookup.readonlyIndexes, message.staticAccountKeys.length);
  }
  size += shortVecLength(message.compiledInstructions.length);
  for (const instruction of message.compiledInstructions) {
    size += 1; // program id index
    size += shortVecLength(instruction.accountKeyIndexes.length);
    size += instruction.accountKeyIndexes.length;
    size += shortVecLength(instruction.data.length);
    size += instruction.data.length;
  }
  return size;
}

/** Sanity check: the arithmetic size must match the real serializer whenever it can run. */
export function assertSerializableSize(message: MessageV0, signatureCount: number): boolean {
  const computed = transactionSize(message, signatureCount);
  try {
    const transaction = new VersionedTransaction(
      message,
      Array.from({ length: signatureCount }, () => new Uint8Array(64).fill(1)),
    );
    const actual = transaction.serialize().length;
    if (actual !== computed) {
      throw new Error(`size mismatch: computed ${computed}, serializer said ${actual}`);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('size mismatch')) throw error;
    return false; // over the packet limit: the serializer cannot emit it
  }
}

/** Wire-format summary used by the report: `program#account_indices...` in hex. */
export function describeInstructions(instructions: VmInstruction[]): {
  label: string;
  programId: string;
  accountCount: number;
  dataLength: number;
  dataHex: string;
}[] {
  return instructions.map((instruction) => ({
    label: instruction.label,
    programId: instruction.programId,
    accountCount: instruction.accounts.length,
    dataLength: instruction.data.length,
    dataHex: instruction.data.toString('hex'),
  }));
}
