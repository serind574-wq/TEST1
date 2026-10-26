/**
 * Transcription of `programs/flashloan-rfq-arb/src/instructions/*.rs`.
 *
 * The interesting instruction is `quote_arbitrage`: it is the *on-chain pre-quote* that prices
 * both RFQ legs before the arbitrage runs, using only on-chain state (firm quote accounts, live
 * maker inventory, the Jupiter Lend admin account for the fee, the clock, and the transaction's
 * own instruction list).
 */
import { ProgramSpec, buildProgramSpec, Ctx, ProgramError, instructionSpec } from '../lib/vm';
import { loadProgram } from '../lib/rustsrc';
import { buildLayouts, AccountLayout } from '../lib/state';
import { pda } from '../lib/pda';
import {
  accountOf,
  fail,
  initProgramAccount,
  requireEq,
  requireKeysEqual,
  requireKeysNotEqual,
  requireSeeds,
  requireTrue,
  tokenAccountOf,
} from '../lib/validation';
import { MM_LAYOUTS, MM_PROGRAM } from './fixed_market_maker';
import { evaluateRoundTrip } from '../lib/math';
import {
  FLASHLOAN_ADMIN_LEN,
  decodeFlashloanAdmin,
  inspectFlashloanPipeline,
} from '../lib/jupiter';
import { PROGRAMS } from '../lib/constants';

export const ARB_PROGRAM = loadProgram('flashloan-rfq-arb');
const layouts = buildLayouts(ARB_PROGRAM);
const ARB_ID = ARB_PROGRAM.programId;

export const ARB_LAYOUTS: Record<string, AccountLayout> = {
  ArbConfig: layouts.get('ArbConfig')!,
  RfqRequest: layouts.get('RfqRequest')!,
  ArbSession: layouts.get('ArbSession')!,
};

const SYSTEM = PROGRAMS.system;
const BPS_DENOMINATOR = 10_000;

function loadConfig(ctx: Ctx): Record<string, unknown> {
  return ctx.vm.loadAccount(ctx, 'config', ARB_LAYOUTS.ArbConfig);
}

function loadRfq(ctx: Ctx, name = 'rfq'): Record<string, unknown> {
  return ctx.vm.loadAccount(ctx, name, ARB_LAYOUTS.RfqRequest);
}

function loadSession(ctx: Ctx): Record<string, unknown> {
  return ctx.vm.loadAccount(ctx, 'session', ARB_LAYOUTS.ArbSession);
}

// ---------------------------------------------------------------------------- admin

const initializeConfig = (ctx: Ctx): void => {
  const admin = accountOf(ctx, 'admin');
  const mmProgram = String(ctx.args.mm_program);
  const flashloanProgram = String(ctx.args.flashloan_program);
  const liquidityProgram = String(ctx.args.liquidity_program);
  const borrowMint = String(ctx.args.borrow_mint);
  const intermediateMint = String(ctx.args.intermediate_mint);
  const maxFeeBps = Number(ctx.args.max_flashloan_fee_bps);
  const minProfit = BigInt(ctx.args.min_profit_amount as bigint);
  const maxDust = BigInt(ctx.args.max_intermediate_dust as bigint);

  requireKeysNotEqual(ctx, mmProgram, SYSTEM, 'InvalidConfig');
  requireKeysNotEqual(ctx, flashloanProgram, SYSTEM, 'InvalidConfig');
  requireKeysNotEqual(ctx, borrowMint, intermediateMint, 'InvalidRfqMints');
  requireTrue(ctx, maxFeeBps <= BPS_DENOMINATOR, 'FlashloanFeeTooHigh');

  const flashloanAdmin = pda.flashloanAdmin(flashloanProgram);
  const configPda = pda.config(ARB_ID);
  initProgramAccount(ctx, 'config', ARB_LAYOUTS.ArbConfig, configPda.address, {
    admin,
    mm_program: mmProgram,
    flashloan_program: flashloanProgram,
    liquidity_program: liquidityProgram,
    flashloan_admin: flashloanAdmin.address,
    borrow_mint: borrowMint,
    intermediate_mint: intermediateMint,
    max_flashloan_fee_bps: maxFeeBps,
    min_profit_amount: minProfit,
    max_intermediate_dust: maxDust,
    paused: false,
    enforce_flashloan_pipeline: true,
    bump: configPda.bump,
  });

  ctx.vm.emit(ctx.program, 'ConfigInitialized', ARB_PROGRAM.events.get('ConfigInitialized')!, {
    admin,
    mm_program: mmProgram,
    flashloan_program: flashloanProgram,
    borrow_mint: borrowMint,
    intermediate_mint: intermediateMint,
  });
};

const setPaused = (ctx: Ctx): void => {
  const config = loadConfig(ctx);
  requireSeeds(ctx, 'config', pda.config(ARB_ID).address);
  requireKeysEqual(ctx, accountOf(ctx, 'admin'), String(config.admin), 'Unauthorized');
  config.paused = Boolean(ctx.args.paused);
  ctx.vm.saveAccount(ctx, 'config', ARB_LAYOUTS.ArbConfig, config);
  ctx.vm.emit(ctx.program, 'ProtocolPaused', ARB_PROGRAM.events.get('ProtocolPaused')!, {
    paused: config.paused,
  });
};

// ---------------------------------------------------------------------------- RFQ

const createRfq = (ctx: Ctx): void => {
  const taker = accountOf(ctx, 'taker');
  const config = loadConfig(ctx);
  const clock = ctx.vm.clock;

  const inputMint = String(ctx.args.input_mint);
  const outputMint = String(ctx.args.output_mint);
  const exactInputAmount = BigInt(ctx.args.exact_input_amount as bigint);
  const minOutputAmount = BigInt(ctx.args.min_output_amount as bigint);
  const expirySlot = BigInt(ctx.args.expiry_slot as bigint);
  const fixedMaker = String(ctx.args.fixed_maker);
  const nonce = BigInt(ctx.args.nonce as bigint);

  requireTrue(ctx, exactInputAmount > 0n, 'InvalidBorrowAmount');
  requireTrue(ctx, minOutputAmount > 0n, 'InvalidRfqMints');
  requireTrue(ctx, expirySlot > clock.slot, 'RfqExpired');
  requireKeysNotEqual(ctx, inputMint, outputMint, 'InvalidRfqMints');
  requireKeysEqual(ctx, inputMint, String(config.borrow_mint), 'InvalidBorrowMint');
  requireKeysEqual(ctx, outputMint, String(config.intermediate_mint), 'InvalidIntermediateMint');

  const rfqPda = pda.rfq(ARB_ID, taker, nonce);
  initProgramAccount(ctx, 'rfq', ARB_LAYOUTS.RfqRequest, rfqPda.address, {
    taker,
    fixed_maker: fixedMaker,
    input_mint: inputMint,
    output_mint: outputMint,
    exact_input_amount: exactInputAmount,
    min_output_amount: minOutputAmount,
    expiry_slot: expirySlot,
    nonce,
    status: 'Open',
    bump: rfqPda.bump,
  });

  ctx.vm.emit(ctx.program, 'RfqCreated', ARB_PROGRAM.events.get('RfqCreated')!, {
    rfq: rfqPda.address,
    taker,
    fixed_maker: fixedMaker,
    input_mint: inputMint,
    output_mint: outputMint,
    exact_input_amount: exactInputAmount,
    min_output_amount: minOutputAmount,
    expiry_slot: expirySlot,
    nonce,
  });
};

const closeRfq = (ctx: Ctx): void => {
  const taker = accountOf(ctx, 'taker');
  const rfq = loadRfq(ctx);
  requireKeysEqual(ctx, String(rfq.taker), taker, 'Unauthorized');
  requireTrue(ctx, String(rfq.status) !== 'Filled', 'RfqNotOpen');
  const cancelled = ARB_PROGRAM.enums.get('RfqStatus')!.indexOf('Cancelled');
  ctx.vm.closeAccount(accountOf(ctx, 'rfq'), taker);
  ctx.vm.emit(ctx.program, 'RfqClosed', ARB_PROGRAM.events.get('RfqClosed')!, {
    rfq: accountOf(ctx, 'rfq'),
    taker,
    status: new Uint8Array([cancelled])[0],
  });
};

// ---------------------------------------------------------------------------- on-chain pre-quote

const quoteArbitrage = (ctx: Ctx): void => {
  const clock = ctx.vm.clock;
  const config = loadConfig(ctx);
  const rfq = loadRfq(ctx);
  const taker = accountOf(ctx, 'taker');
  const borrowAmount = BigInt(ctx.args.borrow_amount as bigint);
  const minProfitAmount = BigInt(ctx.args.min_profit_amount as bigint);

  // 1. request sanity
  requireTrue(ctx, !config.paused, 'Paused');
  requireTrue(ctx, borrowAmount > 0n, 'InvalidBorrowAmount');
  requireKeysEqual(ctx, taker, String(rfq.taker), 'Unauthorized');
  requireTrue(ctx, String(rfq.status) === 'Open', 'RfqNotOpen');
  requireTrue(ctx, clock.slot <= BigInt(rfq.expiry_slot as bigint), 'RfqExpired');
  requireKeysEqual(ctx, String(rfq.input_mint), String(config.borrow_mint), 'InvalidBorrowMint');
  requireKeysEqual(
    ctx,
    String(rfq.output_mint),
    String(config.intermediate_mint),
    'InvalidIntermediateMint',
  );
  requireEq(ctx, borrowAmount, BigInt(rfq.exact_input_amount as bigint), 'Leg1InputNotEqualBorrow');

  // 2. quote identity (foreign accounts: owner is the market-maker program)
  const quote1 = ctx.vm.loadAccount<Record<string, unknown>>(ctx, 'quote1', MM_LAYOUTS.Quote);
  const quote2 = ctx.vm.loadAccount<Record<string, unknown>>(ctx, 'quote2', MM_LAYOUTS.Quote);
  const rfqKey = accountOf(ctx, 'rfq');
  requireKeysEqual(ctx, String(quote1.rfq), rfqKey, 'QuoteRfqMismatch');
  requireKeysEqual(ctx, String(quote2.rfq), rfqKey, 'QuoteRfqMismatch');
  requireKeysNotEqual(ctx, String(quote1.maker), String(quote2.maker), 'MakerMismatch');
  if (String(rfq.fixed_maker) !== SYSTEM) {
    requireKeysEqual(ctx, String(quote1.maker), String(rfq.fixed_maker), 'UnauthorizedMaker');
  }
  requireKeysEqual(ctx, String(quote1.designated_taker), String(rfq.taker), 'QuoteTakerMismatch');
  requireKeysEqual(ctx, String(quote2.designated_taker), String(rfq.taker), 'QuoteTakerMismatch');
  requireTrue(ctx, Boolean(quote1.filled) === false, 'QuoteAlreadyFilled');
  requireTrue(ctx, Boolean(quote2.filled) === false, 'QuoteAlreadyFilled');
  requireTrue(ctx, clock.slot <= BigInt(quote1.expiry_slot as bigint), 'QuoteExpired');
  requireTrue(ctx, clock.slot <= BigInt(quote2.expiry_slot as bigint), 'QuoteExpired');

  // 3. round-trip route
  requireKeysEqual(ctx, String(quote1.input_mint), String(config.borrow_mint), 'InvalidBorrowMint');
  requireKeysEqual(
    ctx,
    String(quote1.output_mint),
    String(config.intermediate_mint),
    'InvalidIntermediateMint',
  );
  requireKeysEqual(
    ctx,
    String(quote2.input_mint),
    String(config.intermediate_mint),
    'InvalidIntermediateMint',
  );
  requireKeysEqual(ctx, String(quote2.output_mint), String(config.borrow_mint), 'RoundTripMismatch');
  requireTrue(
    ctx,
    BigInt(quote1.output_amount as bigint) >= BigInt(rfq.min_output_amount as bigint),
    'Leg1OutputBelowRfqMinimum',
  );

  const borrowAta = tokenAccountOf(ctx, 'borrow_ata');
  const intermediateAta = tokenAccountOf(ctx, 'intermediate_ata');
  requireKeysEqual(ctx, borrowAta.mint, String(config.borrow_mint), 'TokenAccountMismatch');
  requireKeysEqual(ctx, borrowAta.owner, String(rfq.taker), 'TokenAccountMismatch');
  requireKeysEqual(
    ctx,
    intermediateAta.mint,
    String(config.intermediate_mint),
    'TokenAccountMismatch',
  );
  requireKeysEqual(ctx, intermediateAta.owner, String(rfq.taker), 'TokenAccountMismatch');

  // 4. live inventory
  const vault1 = tokenAccountOf(ctx, 'quote1_output_vault');
  const vault2 = tokenAccountOf(ctx, 'quote2_output_vault');
  requireKeysEqual(ctx, vault1.mint, String(quote1.output_mint), 'TokenAccountMismatch');
  requireKeysEqual(ctx, vault2.mint, String(quote2.output_mint), 'TokenAccountMismatch');
  requireKeysEqual(
    ctx,
    vault1.owner,
    pda.vaultAuthority(String(config.mm_program), String(quote1.maker), String(quote1.output_mint))
      .address,
    'TokenAccountMismatch',
  );
  requireKeysEqual(
    ctx,
    vault2.owner,
    pda.vaultAuthority(String(config.mm_program), String(quote2.maker), String(quote2.output_mint))
      .address,
    'TokenAccountMismatch',
  );
  requireTrue(ctx, vault1.amount >= BigInt(quote1.output_amount as bigint), 'Unprofitable');
  requireTrue(ctx, vault2.amount >= BigInt(quote2.output_amount as bigint), 'Unprofitable');

  // 5. live loan terms from Jupiter Lend's own admin account
  const adminKey = accountOf(ctx, 'flashloan_admin');
  requireKeysEqual(ctx, adminKey, String(config.flashloan_admin), 'FlashloanAdminPdaMismatch');
  requireKeysEqual(
    ctx,
    adminKey,
    pda.flashloanAdmin(String(config.flashloan_program)).address,
    'FlashloanAdminPdaMismatch',
  );
  const adminState = ctx.accounts.get('flashloan_admin')!;
  requireKeysEqual(ctx, adminState.owner, String(config.flashloan_program), 'FlashloanAdminOwnerMismatch');
  if (adminState.data.length !== FLASHLOAN_ADMIN_LEN) fail(ctx, 'FlashloanAdminInvalidSize');
  const admin = decodeFlashloanAdmin(adminState.data);
  requireTrue(ctx, admin.status, 'FlashloanProtocolInactive');
  requireKeysEqual(
    ctx,
    admin.liquidity_program,
    String(config.liquidity_program),
    'FlashloanLiquidityProgramMismatch',
  );
  requireTrue(
    ctx,
    admin.flashloan_fee_bps <= Number(config.max_flashloan_fee_bps),
    'FlashloanFeeTooHigh',
  );
  requireTrue(ctx, admin.flashloan_fee_bps <= BPS_DENOMINATOR, 'FlashloanFeeTooHigh');
  const feeBps = admin.flashloan_fee_bps;

  // 6. price the round trip
  const priced = evaluateRoundTrip(
    borrowAmount,
    feeBps,
    BigInt(quote1.input_amount as bigint),
    BigInt(quote1.output_amount as bigint),
    BigInt(quote2.input_amount as bigint),
    BigInt(quote2.output_amount as bigint),
  );
  if (!priced.ok) fail(ctx, priced.error);
  const roundTrip = priced.value;
  requireTrue(ctx, roundTrip.profitable, 'Unprofitable');
  requireTrue(ctx, roundTrip.netProfit >= minProfitAmount, 'Unprofitable');
  requireTrue(ctx, roundTrip.netProfit >= BigInt(config.min_profit_amount as bigint), 'Unprofitable');

  // 7. loan <-> trade wiring via the instructions sysvar
  let preLoanBorrowBalance = borrowAta.amount;
  if (config.enforce_flashloan_pipeline) {
    const check = inspectFlashloanPipeline(
      ctx.vm,
      ctx.currentIndex,
      String(config.flashloan_program),
      borrowAmount,
      taker,
      accountOf(ctx, 'borrow_ata'),
      String(config.borrow_mint),
    );
    if (!check.ok) fail(ctx, check.error);
    // The principal already landed, so the pre-loan baseline is `balance - principal`.
    requireTrue(ctx, borrowAta.amount >= borrowAmount, 'FlashloanAccountMismatch');
    preLoanBorrowBalance = borrowAta.amount - borrowAmount;
  }

  // 8. record the session
  const sessionPda = pda.session(ARB_ID, rfqKey);
  initProgramAccount(ctx, 'session', ARB_LAYOUTS.ArbSession, sessionPda.address, {
    rfq: rfqKey,
    taker: String(rfq.taker),
    borrow_mint: String(config.borrow_mint),
    intermediate_mint: String(config.intermediate_mint),
    mm1: String(quote1.maker),
    mm2: String(quote2.maker),
    quote1: accountOf(ctx, 'quote1'),
    quote2: accountOf(ctx, 'quote2'),
    borrow_ata: accountOf(ctx, 'borrow_ata'),
    intermediate_ata: accountOf(ctx, 'intermediate_ata'),
    borrow_amount: borrowAmount,
    flashloan_fee: roundTrip.flashloanFee,
    required_repayment: roundTrip.requiredRepayment,
    min_profit_amount: minProfitAmount > BigInt(config.min_profit_amount as bigint)
      ? minProfitAmount
      : BigInt(config.min_profit_amount as bigint),
    projected_final_amount: roundTrip.leg2Output,
    projected_net_profit: roundTrip.netProfit,
    pre_loan_borrow_balance: preLoanBorrowBalance,
    pre_loan_intermediate_balance: intermediateAta.amount,
    realized_leg1_out: 0n,
    realized_leg2_out: 0n,
    quote_slot: clock.slot,
    leg1_filled: false,
    leg2_filled: false,
    stage: 'Quoted',
    bump: sessionPda.bump,
  });

  ctx.vm.emit(ctx.program, 'ArbQuoted', ARB_PROGRAM.events.get('ArbQuoted')!, {
    session: sessionPda.address,
    rfq: rfqKey,
    taker: String(rfq.taker),
    borrow_mint: String(config.borrow_mint),
    intermediate_mint: String(config.intermediate_mint),
    mm1: String(quote1.maker),
    mm2: String(quote2.maker),
    borrow_amount: borrowAmount,
    leg1_output: BigInt(quote1.output_amount as bigint),
    leg2_output: BigInt(quote2.output_amount as bigint),
    flashloan_fee: roundTrip.flashloanFee,
    flashloan_fee_bps: feeBps,
    required_repayment: roundTrip.requiredRepayment,
    projected_net_profit: roundTrip.netProfit,
    slot: clock.slot,
  });
};

// ---------------------------------------------------------------------------- fill

const fillRfqLeg = (ctx: Ctx): void => {
  const clock = ctx.vm.clock;
  const session = loadSession(ctx);
  const taker = accountOf(ctx, 'taker');
  const leg = Number(ctx.args.leg);

  requireKeysEqual(ctx, String(session.taker), taker, 'Unauthorized');
  requireTrue(ctx, String(session.stage) === 'Quoted', 'SessionNotOpen');

  const legSpec =
    leg === 1
      ? {
          expectedQuote: String(session.quote1),
          expectedMaker: String(session.mm1),
          expectedInput: String(session.borrow_ata),
          expectedOutput: String(session.intermediate_ata),
          expectedInMint: String(session.borrow_mint),
        }
      : leg === 2
        ? {
            expectedQuote: String(session.quote2),
            expectedMaker: String(session.mm2),
            expectedInput: String(session.intermediate_ata),
            expectedOutput: String(session.borrow_ata),
            expectedInMint: String(session.intermediate_mint),
          }
        : null;
  if (!legSpec) fail(ctx, 'InvalidConfig');

  if (leg === 1) {
    requireTrue(ctx, Boolean(session.leg1_filled) === false, 'QuoteAlreadyFilled');
  } else {
    requireTrue(ctx, Boolean(session.leg1_filled), 'LegOutOfOrder');
    requireTrue(ctx, Boolean(session.leg2_filled) === false, 'QuoteAlreadyFilled');
  }

  const quote = ctx.vm.loadAccount<Record<string, unknown>>(ctx, 'quote', MM_LAYOUTS.Quote);
  requireKeysEqual(ctx, accountOf(ctx, 'quote'), legSpec.expectedQuote, 'SessionAccountMismatch');
  requireKeysEqual(ctx, String(quote.maker), legSpec.expectedMaker, 'MakerMismatch');
  requireKeysEqual(ctx, String(quote.rfq), String(session.rfq), 'QuoteRfqMismatch');
  requireTrue(ctx, Boolean(quote.filled) === false, 'QuoteAlreadyFilled');
  requireTrue(ctx, clock.slot <= BigInt(quote.expiry_slot as bigint), 'QuoteExpired');
  requireKeysEqual(ctx, String(quote.input_mint), legSpec.expectedInMint, 'TokenAccountMismatch');
  requireKeysEqual(ctx, accountOf(ctx, 'taker_input_account'), legSpec.expectedInput, 'SessionAccountMismatch');
  requireKeysEqual(ctx, accountOf(ctx, 'taker_output_account'), legSpec.expectedOutput, 'SessionAccountMismatch');

  // CPI: fixed_market_maker::settle_quote, accounts in the Rust struct's declaration order.
  const mmSpec = instructionSpec(MM_PROGRAM_Spec(), 'settle_quote');
  const mmAccounts = mmSpec.accounts.map((meta) => {
    const state = ctx.accounts.get(MM_CPI_ACCOUNT_MAP[meta.name]);
    if (!state) throw new Error(`missing CPi account ${meta.name}`);
    return state;
  });
  ctx.vm.invoke(
    ctx,
    MM_PROGRAM.programId,
    'settle_quote',
    mmAccounts,
    {
      amount_in: BigInt(quote.input_amount as bigint),
      min_amount_out: BigInt(quote.output_amount as bigint),
    },
    [],
    `fixed_market_maker.settle_quote(leg ${leg})`,
  );

  const settled = ctx.vm.loadAccount<Record<string, unknown>>(ctx, 'quote', MM_LAYOUTS.Quote);
  requireTrue(ctx, Boolean(settled.filled), 'QuoteAlreadyFilled');
  ctx.accounts.get('taker_output_account')!.data = ctx.accounts.get('taker_output_account')!.data;

  const updated = loadSession(ctx);
  if (leg === 1) {
    updated.leg1_filled = true;
    updated.realized_leg1_out = BigInt(quote.output_amount as bigint);
  } else {
    updated.leg2_filled = true;
    updated.realized_leg2_out = BigInt(quote.output_amount as bigint);
  }
  ctx.vm.saveAccount(ctx, 'session', ARB_LAYOUTS.ArbSession, updated);

  ctx.vm.emit(ctx.program, 'LegFilled', ARB_PROGRAM.events.get('LegFilled')!, {
    session: accountOf(ctx, 'session'),
    leg,
    quote: accountOf(ctx, 'quote'),
    maker: String(quote.maker),
    amount_in: BigInt(quote.input_amount as bigint),
    amount_out: BigInt(quote.output_amount as bigint),
  });
};

/**
 * Mapping from the arb program's account names to the market-maker program's names for the CPI.
 * (`mm_config`/`mm_program` are the arb-side handles for the callee's `config`/program.)
 */
const MM_CPI_ACCOUNT_MAP: Record<string, string> = {
  config: 'mm_config',
  quote: 'quote',
  maker_account: 'maker_account',
  taker: 'taker',
  taker_input_account: 'taker_input_account',
  taker_output_account: 'taker_output_account',
  maker_input_vault: 'maker_input_vault',
  maker_output_vault: 'maker_output_vault',
  maker_input_vault_authority: 'maker_input_vault_authority',
  maker_output_vault_authority: 'maker_output_vault_authority',
  token_program: 'token_program',
};

function MM_PROGRAM_Spec() {
  // Lazily built to avoid a circular import at module load time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./fixed_market_maker').buildMmProgram() as ProgramSpec;
}

// ---------------------------------------------------------------------------- settle

const settleArbitrage = (ctx: Ctx): void => {
  const clock = ctx.vm.clock;
  const config = loadConfig(ctx);
  const session = loadSession(ctx);
  const taker = accountOf(ctx, 'taker');
  const rfq = loadRfq(ctx);

  requireKeysEqual(ctx, String(session.taker), taker, 'Unauthorized');
  requireKeysEqual(ctx, String(session.rfq), accountOf(ctx, 'rfq'), 'SessionAccountMismatch');
  requireTrue(ctx, String(session.stage) === 'Quoted', 'SessionNotOpen');
  requireTrue(ctx, Boolean(session.leg1_filled) && Boolean(session.leg2_filled), 'LegsNotFilled');
  requireTrue(ctx, String(rfq.status) === 'Open', 'RfqNotOpen');

  requireKeysEqual(ctx, accountOf(ctx, 'borrow_ata'), String(session.borrow_ata), 'SessionAccountMismatch');
  requireKeysEqual(
    ctx,
    accountOf(ctx, 'intermediate_ata'),
    String(session.intermediate_ata),
    'SessionAccountMismatch',
  );

  const borrowAta = tokenAccountOf(ctx, 'borrow_ata');
  const intermediateAta = tokenAccountOf(ctx, 'intermediate_ata');
  requireKeysEqual(ctx, borrowAta.mint, String(session.borrow_mint), 'TokenAccountMismatch');
  requireKeysEqual(ctx, borrowAta.owner, String(session.taker), 'TokenAccountMismatch');

  const preBorrow = BigInt(session.pre_loan_borrow_balance as bigint);
  const preIntermediate = BigInt(session.pre_loan_intermediate_balance as bigint);
  const repayment = BigInt(session.required_repayment as bigint);
  const minProfit = BigInt(session.min_profit_amount as bigint);

  const minBalance = preBorrow + repayment + minProfit;
  requireTrue(ctx, borrowAta.amount >= minBalance, 'InsufficientRepaymentBalance');
  const realizedProfit = borrowAta.amount - preBorrow - repayment;

  const dust = intermediateAta.amount > preIntermediate ? intermediateAta.amount - preIntermediate : 0n;
  requireTrue(ctx, dust <= BigInt(config.max_intermediate_dust as bigint), 'IntermediateDustTooHigh');

  rfq.status = 'Filled';
  ctx.vm.saveAccount(ctx, 'rfq', ARB_LAYOUTS.RfqRequest, rfq);

  const settled = loadSession(ctx);
  settled.stage = 'Settled';
  ctx.vm.saveAccount(ctx, 'session', ARB_LAYOUTS.ArbSession, settled);

  ctx.vm.emit(ctx.program, 'ArbSettled', ARB_PROGRAM.events.get('ArbSettled')!, {
    session: accountOf(ctx, 'session'),
    rfq: String(settled.rfq),
    taker: String(settled.taker),
    borrow_balance_after: borrowAta.amount,
    required_repayment: repayment,
    realized_net_profit: realizedProfit,
    intermediate_dust: dust,
    slot: clock.slot,
  });

  // `close = taker`: rent is refunded and the session disappears.
  ctx.vm.closeAccount(accountOf(ctx, 'session'), taker);
};

export const ARB_HANDLERS = {
  initialize_config: initializeConfig,
  set_paused: setPaused,
  create_rfq: createRfq,
  close_rfq: closeRfq,
  quote_arbitrage: quoteArbitrage,
  fill_rfq_leg: fillRfqLeg,
  settle_arbitrage: settleArbitrage,
};

export function buildArbProgram(): ProgramSpec {
  return buildProgramSpec(ARB_PROGRAM, ARB_HANDLERS);
}

export type { ProgramError };
