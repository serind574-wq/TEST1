/**
 * Jupiter Lend flashloan model, driven by the official IDL (`fixtures/idl/flashloan.json`).
 *
 * The account list, the instruction discriminators, the `FlashloanAdmin` byte layout and the
 * error codes are all read from that file / fixed by the real program, so the model enforces
 * the same interface the deployed program does:
 *
 * * `FLASHLOAN_CPICALL_NOT_ALLOWED` (6012) when the instruction is reached through CPI,
 * * `FLASHLOAN_PAYBACK_NOT_FOUND` (6009) / `FLASHLOAN_MULTIPLE_PAYBACKS_FOUND` (6013) via
 *   instruction-sysvar introspection,
 * * `FLASHLOAN_PAUSED` (6011), `FLASHLOAN_ALREADY_ACTIVE` (6003), `FLASHLOAN_INVALID_PARAMS`
 *   (6002) for protocol state,
 * * a fee of `ceil(amount * flashloan_fee / 10_000)` pulled at payback.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ProgramError, ProgramSpec, InstructionSpec, Ctx, ProgramSpec as Spec } from './vm';
import { fail, requireEq, requireKeysEqual, requireTrue, tokenAccountOf } from './validation';
import { base58ToBytes } from './anchor';
import { PROGRAMS, JUPITER_FLASHLOAN_ADMIN, JUPITER_LIQUIDITY_ACCOUNTS } from './constants';
import { ceilDiv } from './math';
import { ROOT_DIR } from './rustsrc';

export interface FlashloanAdminState {
  authority: string;
  liquidity_program: string;
  status: boolean;
  flashloan_fee_bps: number;
  flashloan_timestamp: bigint;
  is_flashloan_active: boolean;
  active_flashloan_amount: bigint;
  bump: number;
}

export const FLASHLOAN_ADMIN_LEN = 93;
export const FLASHLOAN_ADMIN_OFFSET = {
  authority: 8,
  liquidityProgram: 40,
  status: 72,
  flashloanFee: 73,
  flashloanTimestamp: 75,
  isFlashloanActive: 83,
  activeFlashloanAmount: 84,
  bump: 92,
} as const;

/**
 * The 8-byte account discriminator from the IDL. `account:FlashloanAdmin` hashes to exactly
 * these bytes (`tests/run_encoding_checks.ts` proves it).
 */
export const FLASHLOAN_ADMIN_DISCRIMINATOR = Buffer.from([162, 161, 45, 28, 131, 91, 202, 88]);

export function encodeFlashloanAdmin(state: FlashloanAdminState): Buffer {
  const data = Buffer.alloc(FLASHLOAN_ADMIN_LEN);
  FLASHLOAN_ADMIN_DISCRIMINATOR.copy(data, 0);
  base58ToBytes(state.authority).copy(data, FLASHLOAN_ADMIN_OFFSET.authority);
  base58ToBytes(state.liquidity_program).copy(data, FLASHLOAN_ADMIN_OFFSET.liquidityProgram);
  data.writeUInt8(state.status ? 1 : 0, FLASHLOAN_ADMIN_OFFSET.status);
  data.writeUInt16LE(state.flashloan_fee_bps, FLASHLOAN_ADMIN_OFFSET.flashloanFee);
  data.writeBigUInt64LE(state.flashloan_timestamp, FLASHLOAN_ADMIN_OFFSET.flashloanTimestamp);
  data.writeUInt8(state.is_flashloan_active ? 1 : 0, FLASHLOAN_ADMIN_OFFSET.isFlashloanActive);
  data.writeBigUInt64LE(state.active_flashloan_amount, FLASHLOAN_ADMIN_OFFSET.activeFlashloanAmount);
  data.writeUInt8(state.bump, FLASHLOAN_ADMIN_OFFSET.bump);
  return data;
}

export function decodeFlashloanAdmin(data: Buffer): FlashloanAdminState {
  if (data.length !== FLASHLOAN_ADMIN_LEN) {
    throw new Error(`FlashloanAdmin must be ${FLASHLOAN_ADMIN_LEN} bytes, got ${data.length}`);
  }
  const pubkey = (at: number): string => {
    const { bytesToBase58 } = require('./anchor') as typeof import('./anchor');
    return bytesToBase58(data.subarray(at, at + 32));
  };
  return {
    authority: pubkey(FLASHLOAN_ADMIN_OFFSET.authority),
    liquidity_program: pubkey(FLASHLOAN_ADMIN_OFFSET.liquidityProgram),
    status: data.readUInt8(FLASHLOAN_ADMIN_OFFSET.status) !== 0,
    flashloan_fee_bps: data.readUInt16LE(FLASHLOAN_ADMIN_OFFSET.flashloanFee),
    flashloan_timestamp: data.readBigUInt64LE(FLASHLOAN_ADMIN_OFFSET.flashloanTimestamp),
    is_flashloan_active: data.readUInt8(FLASHLOAN_ADMIN_OFFSET.isFlashloanActive) !== 0,
    active_flashloan_amount: data.readBigUInt64LE(FLASHLOAN_ADMIN_OFFSET.activeFlashloanAmount),
    bump: data.readUInt8(FLASHLOAN_ADMIN_OFFSET.bump),
  };
}

// ------------------------------------------------------------------------------- official IDL

export interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: { name: string; writable?: boolean; signer?: boolean }[];
  args: { name: string; type: string }[];
}

export interface FlashloanIdl {
  address: string;
  metadata: { name: string; version: string; spec: string };
  instructions: IdlInstruction[];
  errors: { code: number; name: string; msg: string }[];
}

export const FLASHLOAN_IDL: FlashloanIdl = JSON.parse(
  readFileSync(join(ROOT_DIR, 'fixtures', 'idl', 'flashloan.json'), 'utf8'),
);

export function idlInstruction(name: string): IdlInstruction {
  const instruction = FLASHLOAN_IDL.instructions.find((candidate) => candidate.name === name);
  if (!instruction) throw new Error(`flashloan IDL has no instruction ${name}`);
  return instruction;
}

export const IX_FLASHLOAN_BORROW = Buffer.from(idlInstruction('flashloan_borrow').discriminator);
export const IX_FLASHLOAN_PAYBACK = Buffer.from(idlInstruction('flashloan_payback').discriminator);

// ------------------------------------------------------------------------------- model handlers

function adminAccount(ctx: Ctx) {
  const account = ctx.accounts.get('flashloan_admin')!;
  if (account.owner !== PROGRAMS.jupiterFlashloan) {
    throw new ProgramError(ctx.program.name, 'FlashloanInvalidParams', 6002);
  }
  return decodeFlashloanAdmin(account.data);
}

function assertNoCpi(ctx: Ctx): void {
  // `get_stack_height() > 1` in the real program: a CPI caller never reaches the body.
  if (ctx.stackHeight !== 1) fail(ctx, 'FlashloanCPICallNotAllowed');
}

function assertPaybackScheduled(ctx: Ctx, amount: bigint): void {
  const paybacks: { index: number; instruction: (typeof ctx.vm.instructionList)[number] }[] = [];
  ctx.vm.instructionList.forEach((instruction, index) => {
    if (instruction.programId !== PROGRAMS.jupiterFlashloan) return;
    if (!instruction.data.subarray(0, 8).equals(IX_FLASHLOAN_PAYBACK)) return;
    if (instruction.data.length !== 16) fail(ctx, 'FlashloanInvalidInstructionData');
    paybacks.push({ index, instruction });
  });
  if (paybacks.length === 0) fail(ctx, 'FlashloanPaybackNotFound');
  if (paybacks.length > 1) fail(ctx, 'FlashloanMultiplePaybacksFound');

  const payback = paybacks[0];
  if (payback.index <= ctx.currentIndex) fail(ctx, 'FlashloanPaybackNotFound');
  const sameAccounts =
    payback.instruction.accounts.length === ctx.instruction.accounts.length &&
    payback.instruction.accounts.every(
      (meta, i) => meta.pubkey === ctx.instruction.accounts[i].pubkey,
    );
  if (!sameAccounts) fail(ctx, 'FlashloanInvalidInstruction');
  if (payback.instruction.data.readBigUInt64LE(8) !== amount) {
    fail(ctx, 'FlashloanInvalidInstructionData');
  }
}

const flashloanBorrow = (ctx: Ctx): void => {
  assertNoCpi(ctx);
  if (ctx.instruction.data.length !== 16) fail(ctx, 'FlashloanInvalidInstructionData');
  const amount = ctx.instruction.data.readBigUInt64LE(8);
  if (amount <= 0n) fail(ctx, 'FlashloanInvalidParams');

  const admin = adminAccount(ctx);
  if (!admin.status) fail(ctx, 'FlashloanPaused');
  if (admin.is_flashloan_active) fail(ctx, 'FlashloanAlreadyActive');

  const signer = ctx.accounts.get('signer')!.key;
  const tokenAccount = tokenAccountOf(ctx, 'signer_borrow_token_account');
  requireKeysEqual(ctx, tokenAccount.owner, signer, 'FlashloanInvalidParams');
  requireKeysEqual(ctx, tokenAccount.mint, ctx.accounts.get('mint')!.key, 'FlashloanInvalidParams');

  assertPaybackScheduled(ctx, amount);

  // Liquidity layer moves the funds: reserve vault -> borrower. The reserve vault is a PDA of
  // the liquidity program, so that program signs as the vault authority (modelled here).
  ctx.signers.add(JUPITER_LIQUIDITY_ACCOUNTS.vault);
  ctx.vm.transferTokens(
    ctx,
    JUPITER_LIQUIDITY_ACCOUNTS.vault,
    ctx.accounts.get('signer_borrow_token_account')!.key,
    JUPITER_LIQUIDITY_ACCOUNTS.vault,
    amount,
  );

  const updated = {
    ...admin,
    is_flashloan_active: true,
    active_flashloan_amount: amount,
    flashloan_timestamp: ctx.vm.clock.unixTimestamp,
  };
  ctx.accounts.get('flashloan_admin')!.data = encodeFlashloanAdmin(updated);
};

const flashloanPayback = (ctx: Ctx): void => {
  assertNoCpi(ctx);
  if (ctx.instruction.data.length !== 16) fail(ctx, 'FlashloanInvalidInstructionData');
  const amount = ctx.instruction.data.readBigUInt64LE(8);

  const admin = adminAccount(ctx);
  if (!admin.is_flashloan_active) fail(ctx, 'FlashloanInvalidInstruction');
  requireEq(ctx, amount, admin.active_flashloan_amount, 'FlashloanInvalidInstruction');

  // The loan is repaid plus the (rounded-up) fee.
  const fee = ceilDiv(amount * BigInt(admin.flashloan_fee_bps), 10_000n);
  ctx.vm.transferTokens(
    ctx,
    ctx.accounts.get('signer_borrow_token_account')!.key,
    JUPITER_LIQUIDITY_ACCOUNTS.vault,
    ctx.accounts.get('signer')!.key,
    amount + fee,
  );

  const updated = {
    ...admin,
    is_flashloan_active: false,
    active_flashloan_amount: 0n,
    flashloan_timestamp: ctx.vm.clock.unixTimestamp,
  };
  ctx.accounts.get('flashloan_admin')!.data = encodeFlashloanAdmin(updated);
};

function toArgFields(instruction: IdlInstruction) {
  return instruction.args.map((arg) => ({ name: arg.name, type: arg.type as never }));
}

export function buildJupiterProgram(): Spec {
  const errors = new Map<string, number>();
  for (const error of FLASHLOAN_IDL.errors) errors.set(error.name, error.code);

  const instructions = new Map<string, InstructionSpec>();
  const add = (name: string, handler: (ctx: Ctx) => void) => {
    const idl = idlInstruction(name);
    instructions.set(Buffer.from(idl.discriminator).toString('hex'), {
      name,
      accounts: idl.accounts.map((account) => ({
        name: account.name,
        rustType: 'UncheckedAccount',
        writable: Boolean(account.writable),
        signer: Boolean(account.signer),
        init: false,
      })),
      argFields: toArgFields(idl),
      handler,
    });
  };
  add('flashloan_borrow', flashloanBorrow);
  add('flashloan_payback', flashloanPayback);

  return {
    name: 'jupiter_lend_flashloan',
    id: PROGRAMS.jupiterFlashloan,
    instructions,
    errors,
  };
}

// --------------------------------------------------------------------- our own introspection

export interface FlashloanPipelineCheck {
  currentIndex: number;
  borrowIndex: number;
  paybackIndex: number;
  instructionCount: number;
  amount: bigint;
}

export type PipelineResult =
  | { ok: true; value: FlashloanPipelineCheck }
  | { ok: false; error: string };

/**
 * Port of `jupiter_lend::inspect_flashloan_pipeline` (the RFQ program's own guard): prove the
 * transaction really opens *this* loan for *this* taker and closes it as the last instruction.
 */
export function inspectFlashloanPipeline(
  vm: import('./vm').Vm,
  currentIndex: number,
  flashloanProgram: string,
  amount: bigint,
  signer: string,
  borrowTokenAccount: string,
  mint: string,
): PipelineResult {
  const borrowIndices: number[] = [];
  const paybackIndices: number[] = [];
  const instructions = vm.instructionList;

  instructions.forEach((instruction, index) => {
    if (instruction.programId !== flashloanProgram) return;
    const discriminator = instruction.data.subarray(0, 8);
    const isBorrow = discriminator.equals(IX_FLASHLOAN_BORROW);
    const isPayback = discriminator.equals(IX_FLASHLOAN_PAYBACK);
    if (!isBorrow && !isPayback) return;
    if (instruction.data.length !== 16) return; // malformed: ignored here, caught by the model
    if (instruction.accounts.length < 11) return;
    if (instruction.accounts[0].pubkey !== signer) return;
    if (instruction.accounts[2].pubkey !== borrowTokenAccount) return;
    if (instruction.accounts[3].pubkey !== mint) return;
    if (instruction.data.readBigUInt64LE(8) !== amount) return;
    if (isBorrow) borrowIndices.push(index);
    else paybackIndices.push(index);
  });

  if (borrowIndices.length === 0) return { ok: false, error: 'FlashloanBorrowNotFound' };
  if (paybackIndices.length === 0) return { ok: false, error: 'FlashloanPaybackNotFound' };
  if (borrowIndices.length !== 1 || paybackIndices.length !== 1) {
    return { ok: false, error: 'FlashloanDuplicateInstruction' };
  }
  if (borrowIndices[0] >= currentIndex) return { ok: false, error: 'FlashloanBorrowNotFirst' };
  if (paybackIndices[0] + 1 !== instructions.length) {
    return { ok: false, error: 'FlashloanPaybackNotLast' };
  }
  return {
    ok: true,
    value: {
      currentIndex,
      borrowIndex: borrowIndices[0],
      paybackIndex: paybackIndices[0],
      instructionCount: instructions.length,
      amount,
    },
  };
}

export const JUPITER_ADMIN_ADDRESS = JUPITER_FLASHLOAN_ADMIN;
