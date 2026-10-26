/**
 * Anchor-equivalent validation helpers for the transcribed handlers.
 *
 * `requireTrue(ctx, cond, 'SomeError')` resolves the error code from the *Rust* `#[error_code]`
 * enum, so an unknown variant is a harness bug, not a silent pass.
 */
import { Ctx, ProgramError, TOKEN_ERRORS, Vm } from './vm';
import { PROGRAMS } from './constants';
import { encodeTokenAccount, TOKEN_ACCOUNT_LEN } from './token';

export function fail(ctx: Ctx, errorName: string): never {
  const code = ctx.program.errors.get(errorName);
  if (code === undefined) {
    throw new Error(
      `harness bug: ${ctx.program.name} has no error variant "${errorName}" (check errors.rs)`,
    );
  }
  throw new ProgramError(ctx.program.name, errorName, code);
}

export function requireTrue(ctx: Ctx, condition: boolean, errorName: string): void {
  if (!condition) fail(ctx, errorName);
}

export function requireKeysEqual(ctx: Ctx, left: string, right: string, errorName: string): void {
  if (left !== right) fail(ctx, errorName);
}

export function requireKeysNotEqual(ctx: Ctx, left: string, right: string, errorName: string): void {
  if (left === right) fail(ctx, errorName);
}

export function requireEq(ctx: Ctx, left: bigint | number, right: bigint | number, errorName: string): void {
  if (BigInt(left) !== BigInt(right)) fail(ctx, errorName);
}

export function accountOf(ctx: Ctx, name: string): string {
  const account = ctx.accounts.get(name);
  if (!account) throw new Error(`account ${name} missing from context`);
  return account.key;
}

/** `Account<'info, TokenAccount>` equivalent: owner + length + decoded fields. */
export function tokenAccountOf(ctx: Ctx, name: string) {
  const account = ctx.accounts.get(name);
  if (!account) throw new Error(`account ${name} missing from context`);
  if (account.owner !== PROGRAMS.token || account.data.length !== TOKEN_ACCOUNT_LEN) {
    throw new ProgramError(
      ctx.program.name,
      `account \`${name}\` is not an SPL token account`,
      TOKEN_ERRORS.InvalidMint,
    );
  }
  return ctx.vm.tokenAccountState(account.key);
}

export function tokenAmountOf(ctx: Ctx, name: string): bigint {
  return tokenAccountOf(ctx, name).amount;
}

/** PDA re-derivation helper mirroring Anchor's `seeds = [...]` constraint. */
export function requirePda(
  ctx: Ctx,
  name: string,
  expectedAddress: string,
  errorName = 'InvalidConfig',
): void {
  requireKeysEqual(ctx, accountOf(ctx, name), expectedAddress, errorName);
}

export function expectProgramError(
  vm: Vm,
  action: () => void,
  expected: string,
): ProgramError {
  try {
    action();
  } catch (error) {
    if (!(error instanceof ProgramError)) throw error;
    if (error.errorName !== expected) {
      throw new Error(`expected ${expected}, got ${error.errorName} (${error.code})`);
    }
    return error;
  }
  throw new Error(`expected ${expected}, but the instruction succeeded`);
}

/** Anchor `seeds = [...]` constraint failure. */
export function requireSeeds(ctx: Ctx, name: string, expectedAddress: string): void {
  if (accountOf(ctx, name) !== expectedAddress) {
    throw new ProgramError(ctx.program.name, 'ConstraintSeeds', 2006);
  }
}

/** Anchor `init` with seeds: the address must be the PDA, and the account must be empty. */
export function initProgramAccount(
  ctx: Ctx,
  name: string,
  layout: import('./state').AccountLayout,
  expectedAddress: string,
  value: Record<string, unknown>,
  lamports = 1_500_000n,
): void {
  requireSeeds(ctx, name, expectedAddress);
  ctx.vm.createAccount(ctx, name, layout, value, lamports);
}

/** Anchor `init` of an associated token account owned by a PDA. */
export function initAta(
  ctx: Ctx,
  name: string,
  expectedAddress: string,
  mint: string,
  owner: string,
  amount = 0n,
  lamports = 2_039_280n,
): void {
  requireSeeds(ctx, name, expectedAddress);
  const state = ctx.accounts.get(name);
  if (!state) throw new Error(`account ${name} missing from context`);
  if (state.lamports > 0n || state.data.length > 0) {
    throw new ProgramError(ctx.program.name, 'account already in use', 0);
  }
  state.owner = PROGRAMS.token;
  state.lamports = lamports;
  state.data = encodeTokenAccount({ mint, owner, amount, state: 1 });
}
