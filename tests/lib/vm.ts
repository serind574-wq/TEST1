/**
 * A deterministic in-memory execution model ("mini-SVM") for the two programs in this repo.
 *
 * Scope, stated honestly:
 *
 * * It runs the *same* account layouts, discriminators, PDAs and error codes as the Rust code,
 *   because all of those are derived from the Rust sources (`tests/lib/rustsrc.ts`).
 * * It enforces the runtime-level rules that matter for this design: signer privileges (and their
 *   propagation through CPI), writable flags, account ownership, transaction atomicity (state is
 *   rolled back when any instruction fails), the instructions sysvar, and program stack height.
 * * It is **not** a BPF interpreter: the handlers in `tests/programs/*` are transcriptions of the
 *   Rust instruction handlers. That makes it a fast, auditable specification/regression harness,
 *   not a substitute for `anchor test` on a real validator.
 */
import { ProgramDef, FieldDef, AccountMetaDef } from './rustsrc';
import { decodeFields, discriminator, encodeFields } from './anchor';
import { AccountLayout, decodeAccount, encodeAccount } from './state';
import { decodeTokenAccount, setTokenAmount, TOKEN_ACCOUNT_LEN } from './token';
import { PROGRAMS } from './constants';

export interface AccountState {
  key: string;
  owner: string;
  lamports: bigint;
  data: Buffer;
  executable: boolean;
}

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface VmInstruction {
  programId: string;
  accounts: AccountMeta[];
  data: Buffer;
  /** Human readable label used in the report / logs. */
  label: string;
}

export interface VmEvent {
  program: string;
  name: string;
  data: Record<string, unknown>;
  /** `event:<Name>` discriminator followed by the Borsh body (what a real `emit!` logs). */
  payload: Buffer;
}

export class ProgramError extends Error {
  constructor(
    readonly programName: string,
    readonly errorName: string,
    readonly code: number,
  ) {
    super(`${programName}::${errorName}`);
    this.name = 'ProgramError';
  }

  toString(): string {
    return `${this.programName}::${this.errorName} (error ${this.code})`;
  }
}

/** Anchor framework error codes used by the model (real values from anchor-lang's `error.rs`). */
export const ANCHOR_ERRORS = {
  AccountDiscriminatorMismatch: 3012,
  AccountOwnedByWrongProgram: 3007,
  AccountNotSigner: 3010,
  InvalidProgramId: 3008,
  ConstraintSeeds: 2006,
  ConstraintHasOne: 2001,
  AccountNotEnoughKeys: 3005,
  RequireFailed: 2500,
} as const;

export interface Ctx {
  readonly vm: Vm;
  readonly program: ProgramSpec;
  readonly instruction: VmInstruction;
  /** Account state by the Rust struct's field name, in declaration order. */
  readonly accounts: Map<string, AccountState>;
  readonly args: Record<string, unknown>;
  readonly signers: Set<string>;
  readonly stackHeight: number;
  /** Instruction index currently executing (the instructions sysvar's `current_index`). */
  readonly currentIndex: number;
}

export type Handler = (ctx: Ctx) => void;

export interface InstructionSpec {
  name: string;
  accounts: AccountMetaDef[];
  argFields: FieldDef[];
  handler: Handler;
}

export interface ProgramSpec {
  name: string;
  id: string;
  instructions: Map<string, InstructionSpec>;
  /** Error variant name -> Anchor error code. */
  errors: Map<string, number>;
}

export const TOKEN_ERRORS = {
  NotRentExempt: 0,
  InsufficientFunds: 1,
  InvalidMint: 2,
  MintMismatch: 3,
  OwnerMismatch: 4,
  FixedSupply: 5,
  AccountFrozen: 8,
  MissingRequiredSignature: 10,
  UninitializedState: 13,
} as const;

export class Vm {
  readonly accounts = new Map<string, AccountState>();
  readonly programs = new Map<string, ProgramSpec>();
  clock = { slot: 1_000n, unixTimestamp: 1_792_876_000n };
  instructionList: VmInstruction[] = [];
  events: VmEvent[] = [];
  logs: string[] = [];
  /** Programs that exist on-chain but are irrelevant to the model (e.g. ComputeBudget). */
  readonly noopPrograms = new Set<string>();
  private cpiDepth = 0;

  mount(spec: ProgramSpec): void {
    this.programs.set(spec.id, spec);
  }

  program(id: string): ProgramSpec {
    const spec = this.programs.get(id);
    if (!spec) throw new Error(`program ${id} is not loaded in the VM`);
    return spec;
  }

  setAccount(account: AccountState): void {
    this.accounts.set(account.key, account);
  }

  account(key: string): AccountState {
    const account = this.accounts.get(key);
    if (!account) throw new Error(`account ${key} does not exist`);
    return account;
  }

  tryAccount(key: string): AccountState | undefined {
    return this.accounts.get(key);
  }

  /** Deep copy used for transaction-level rollback. */
  snapshot(): Map<string, AccountState> {
    const copy = new Map<string, AccountState>();
    for (const [key, account] of this.accounts) {
      copy.set(key, { ...account, data: Buffer.from(account.data) });
    }
    return copy;
  }

  restore(snapshot: Map<string, AccountState>): void {
    this.accounts.clear();
    for (const [key, account] of snapshot) this.accounts.set(key, account);
  }

  /** Execute one transaction atomically: any failure rolls every account back. */
  execute(instructions: VmInstruction[]): void {
    const snapshot = this.snapshot();
    const eventsLength = this.events.length;
    this.instructionList = instructions;
    try {
      for (let i = 0; i < instructions.length; i++) {
        this.dispatch(instructions[i], i, 1, new Set(instructions[i].accounts.filter((a) => a.isSigner).map((a) => a.pubkey)), new Set());
      }
    } catch (error) {
      this.restore(snapshot);
      this.events.length = eventsLength;
      throw error;
    }
  }

  /** Execute a single instruction outside of a full transaction (setup helpers). */
  executeOne(instruction: VmInstruction): void {
    this.execute([instruction]);
  }

  // ------------------------------------------------------------------ instructions sysvar

  loadInstructionAt(index: number): VmInstruction | undefined {
    return this.instructionList[index];
  }

  get instructionCount(): number {
    return this.instructionList.length;
  }

  emit(program: ProgramSpec, name: string, fields: FieldDef[], value: Record<string, unknown>): void {
    const payload = Buffer.concat([
      discriminator('event', name),
      encodeFields(fields, value, new Map()),
    ]);
    this.events.push({ program: program.id, name, data: value, payload });
    this.logs.push(`Program ${program.id} invoke [${this.cpiDepth + 1}]`);
    this.logs.push(`Program log: ${name} ${JSON.stringify(serialiseForLog(value))}`);
    this.logs.push(`Program data: ${payload.toString('base64')}`);
  }

  // ------------------------------------------------------------------ lifecycle

  private dispatch(
    instruction: VmInstruction,
    index: number,
    stackHeight: number,
    inheritedSigners: Set<string>,
    inheritedPdaSigners: Set<string>,
  ): void {
    if (this.noopPrograms.has(instruction.programId)) {
      this.logs.push(`Program ${instruction.programId} invoke [${stackHeight}] (no-op)`);
      return;
    }
    const program = this.program(instruction.programId);
    const spec = program.instructions.get(instruction.data.subarray(0, 8).toString('hex'));
    if (!spec) {
      throw new ProgramError(program.name, 'InstructionFallbackNotFound', 101);
    }

    if (instruction.accounts.length !== spec.accounts.length) {
      throw new ProgramError(
        program.name,
        `AccountNotEnoughKeys (expected ${spec.accounts.length}, got ${instruction.accounts.length})`,
        ANCHOR_ERRORS.AccountNotEnoughKeys,
      );
    }

    const accountMap = new Map<string, AccountState>();
    spec.accounts.forEach((meta, i) => {
      const provided = instruction.accounts[i];
      const state = this.account(provided.pubkey);
      if (meta.signer && !provided.isSigner) {
        throw new ProgramError(program.name, `account \`${meta.name}\` must be a signer`, ANCHOR_ERRORS.AccountNotSigner);
      }
      if (meta.signer && !inheritedSigners.has(provided.pubkey)) {
        throw new ProgramError(
          program.name,
          `account \`${meta.name}\` is marked as signer but did not sign`,
          ANCHOR_ERRORS.AccountNotSigner,
        );
      }
      if ((meta.writable || meta.init) && !provided.isWritable) {
        throw new ProgramError(program.name, `account \`${meta.name}\` must be writable`, ANCHOR_ERRORS.AccountNotEnoughKeys);
      }
      if (accountMap.has(meta.name)) {
        throw new ProgramError(program.name, 'duplicate account', ANCHOR_ERRORS.AccountNotEnoughKeys);
      }
      accountMap.set(meta.name, state);
    });

    const argBuffer = instruction.data.subarray(8);
    const args =
      spec.argFields.length === 0 ? {} : decodeFields(spec.argFields, argBuffer, new Map());

    const ctx: Ctx = {
      vm: this,
      program,
      instruction,
      accounts: accountMap,
      args,
      signers: new Set([...inheritedSigners, ...inheritedPdaSigners]),
      stackHeight,
      currentIndex: index,
    };

    this.cpiDepth = stackHeight - 1;
    spec.handler(ctx);
    this.cpiDepth = 0;
  }

  /** CPI entry point used by the transcribed handlers. */
  invoke(
    caller: Ctx,
    programId: string,
    instructionName: string,
    accountsInOrder: AccountState[],
    args: Record<string, unknown> = {},
    pdaSigners: string[] = [],
    label = '',
  ): void {
    const program = this.program(programId);
    const spec = this.findInstruction(program, instructionName);
    if (accountsInOrder.length !== spec.accounts.length) {
      throw new Error(
        `CPI ${program.name}::${instructionName} expects ${spec.accounts.length} accounts, got ${accountsInOrder.length}`,
      );
    }
    const data = Buffer.concat([
      discriminator('global', instructionName),
      encodeFields(spec.argFields, args, new Map()),
    ]);
    const metas: AccountMeta[] = spec.accounts.map((meta, i) => ({
      pubkey: accountsInOrder[i].key,
      isSigner: meta.signer,
      isWritable: meta.writable || meta.init,
    }));
    const instruction: VmInstruction = {
      programId,
      accounts: metas,
      data,
      label: label || `${program.name}.${instructionName}`,
    };
    this.logs.push(
      `Program ${caller.program.id} invoke [${caller.stackHeight}] -> CPI ${program.name}.${instructionName}`,
    );
    this.dispatch(
      instruction,
      caller.currentIndex,
      caller.stackHeight + 1,
      caller.signers,
      new Set(pdaSigners),
    );
  }

  findInstruction(program: ProgramSpec, rustName: string): InstructionSpec {
    const byName = program.instructions.get(discriminator('global', rustName).toString('hex'));
    if (!byName) throw new Error(`unknown instruction ${rustName} on ${program.name}`);
    return byName;
  }

  // ------------------------------------------------------------------ token helper

  transferTokens(
    ctx: Ctx,
    fromKey: string,
    toKey: string,
    authority: string,
    amount: bigint,
  ): void {
    const from = this.account(fromKey);
    const to = this.account(toKey);
    if (from.owner !== PROGRAMS.token || to.owner !== PROGRAMS.token) {
      throw new ProgramError('spl_token', 'InvalidAccountOwner', TOKEN_ERRORS.InvalidMint);
    }
    const fromState = decodeTokenAccount(from.data);
    const toState = decodeTokenAccount(to.data);
    if (fromState.mint !== toState.mint) {
      throw new ProgramError('spl_token', 'MintMismatch', TOKEN_ERRORS.MintMismatch);
    }
    if (!ctx.signers.has(authority)) {
      throw new ProgramError(
        'spl_token',
        'MissingRequiredSignature',
        TOKEN_ERRORS.MissingRequiredSignature,
      );
    }
    if (fromState.owner !== authority) {
      throw new ProgramError('spl_token', 'OwnerMismatch', TOKEN_ERRORS.OwnerMismatch);
    }
    if (fromState.amount < amount) {
      throw new ProgramError('spl_token', 'InsufficientFunds', TOKEN_ERRORS.InsufficientFunds);
    }
    setTokenAmount(from.data, fromState.amount - amount);
    setTokenAmount(to.data, toState.amount + amount);
  }

  tokenAmount(key: string): bigint {
    const account = this.account(key);
    if (account.owner !== PROGRAMS.token || account.data.length !== TOKEN_ACCOUNT_LEN) {
      throw new Error(`${key} is not an SPL token account`);
    }
    return decodeTokenAccount(account.data).amount;
  }

  setTokenAmount(key: string, amount: bigint): void {
    setTokenAmount(this.account(key).data, amount);
  }

  // ------------------------------------------------------------------ account helpers

  loadAccount<T = Record<string, unknown>>(ctx: Ctx, accountName: string, layout: AccountLayout): T {
    const state = ctx.accounts.get(accountName);
    if (!state) throw new Error(`account ${accountName} not in context`);
    if (state.owner !== layout.owner) {
      throw new ProgramError(
        ctx.program.name,
        `account \`${accountName}\` is owned by ${state.owner}, expected ${layout.owner}`,
        ANCHOR_ERRORS.AccountOwnedByWrongProgram,
      );
    }
    try {
      return decodeAccount(layout, state.data) as T;
    } catch (error) {
      throw new ProgramError(
        ctx.program.name,
        `cannot deserialize \`${accountName}\`: ${(error as Error).message}`,
        ANCHOR_ERRORS.AccountDiscriminatorMismatch,
      );
    }
  }

  saveAccount(ctx: Ctx, accountName: string, layout: AccountLayout, value: Record<string, unknown>): void {
    const state = ctx.accounts.get(accountName);
    if (!state) throw new Error(`account ${accountName} not in context`);
    state.data = encodeAccount(layout, value);
  }

  createAccount(ctx: Ctx, accountName: string, layout: AccountLayout, value: Record<string, unknown>, lamports = 1_000_000n): void {
    const state = ctx.accounts.get(accountName);
    if (!state) throw new Error(`account ${accountName} not in context`);
    if (state.lamports > 0n || state.data.length > 0) {
      throw new ProgramError(ctx.program.name, 'account already in use', 0);
    }
    state.owner = layout.owner;
    state.lamports = lamports;
    state.data = encodeAccount(layout, value);
  }

  closeAccount(accountName: string, destination: string): void {
    const account = this.account(accountName);
    const dest = this.account(destination);
    dest.lamports += account.lamports;
    account.lamports = 0n;
    account.owner = PROGRAMS.system;
    account.data = Buffer.alloc(0);
  }

  tokenAccountState(key: string) {
    return decodeTokenAccount(this.account(key).data);
  }
}

function serialiseForLog(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = typeof raw === 'bigint' ? raw.toString() : raw;
  }
  return out;
}

// ------------------------------------------------------------------------------ program builders

export function buildProgramSpec(program: ProgramDef, handlers: Record<string, Handler>): ProgramSpec {
  const instructions = new Map<string, InstructionSpec>();
  for (const instruction of program.instructions) {
    const handler = handlers[instruction.name];
    if (!handler) throw new Error(`no handler for ${program.crateName}::${instruction.name}`);
    const accountsStruct = program.accountsStructs.get(instruction.accounts);
    if (!accountsStruct) {
      throw new Error(`no #[derive(Accounts)] struct ${instruction.accounts} for ${instruction.name}`);
    }
    instructions.set(
      discriminator('global', instruction.name).toString('hex'),
      {
        name: instruction.name,
        accounts: accountsStruct.accounts,
        argFields: instruction.args,
        handler,
      },
    );
  }
  const errors = new Map<string, number>();
  program.errors.forEach((name, index) => errors.set(name, 6000 + index));
  return { name: program.idlName, id: program.programId, instructions, errors };
}

export function instructionSpec(program: ProgramSpec, rustName: string): InstructionSpec {
  const spec = program.instructions.get(discriminator('global', rustName).toString('hex'));
  if (!spec) throw new Error(`unknown instruction ${rustName} on ${program.name}`);
  return spec;
}

/** Build the on-chain instruction data for a program instruction (discriminator + Borsh args). */
export function encodeInstructionData(
  program: ProgramSpec,
  rustName: string,
  args: Record<string, unknown> = {},
): Buffer {
  const spec = instructionSpec(program, rustName);
  return Buffer.concat([
    discriminator('global', rustName),
    encodeFields(spec.argFields, args, new Map()),
  ]);
}

/** Build a full instruction with metas derived from the Rust `#[derive(Accounts)]` struct. */
export function buildInstruction(
  vm: Vm,
  program: ProgramSpec,
  rustName: string,
  namedAccounts: Record<string, AccountState>,
  args: Record<string, unknown> = {},
  overrides: Record<string, { isSigner?: boolean; isWritable?: boolean }> = {},
  label?: string,
): VmInstruction {
  const spec = instructionSpec(program, rustName);
  const accounts: AccountMeta[] = spec.accounts.map((meta) => {
    const state = namedAccounts[meta.name];
    if (!state) throw new Error(`${program.name}.${rustName}: missing account \`${meta.name}\``);
    const override = overrides[meta.name] ?? {};
    return {
      pubkey: state.key,
      isSigner: override.isSigner ?? meta.signer,
      isWritable: override.isWritable ?? (meta.writable || meta.init),
    };
  });
  return {
    programId: program.id,
    accounts,
    data: encodeInstructionData(program, rustName, args),
    label: label ?? `${program.name}.${rustName}`,
  };
}

/** Convenience wrapper so tests can build instructions without threading the vm around. */
export function instructionFor(
  program: ProgramSpec,
  rustName: string,
  namedAccounts: Record<string, AccountState>,
  args: Record<string, unknown> = {},
  overrides: Record<string, { isSigner?: boolean; isWritable?: boolean }> = {},
  label?: string,
): VmInstruction {
  const spec = instructionSpec(program, rustName);
  const accounts: AccountMeta[] = spec.accounts.map((meta) => {
    const state = namedAccounts[meta.name];
    if (!state) throw new Error(`${program.name}.${rustName}: missing account \`${meta.name}\``);
    const override = overrides[meta.name] ?? {};
    return {
      pubkey: state.key,
      isSigner: override.isSigner ?? meta.signer,
      isWritable: override.isWritable ?? (meta.writable || meta.init),
    };
  });
  return {
    programId: program.id,
    accounts,
    data: encodeInstructionData(program, rustName, args),
    label: label ?? `${program.name}.${rustName}`,
  };
}
