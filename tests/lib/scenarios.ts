/**
 * The scenario matrix, shared by `tests/run_vm_tests.ts` (assertions) and
 * `tests/run_report.ts` (the study report), so the two can never disagree.
 *
 * Each scenario executes the *entire* atomic transaction in the VM and returns either `ok` or the
 * program error that stopped it. Scenarios also assert the economic outcome they care about.
 */
import { PublicKey } from '@solana/web3.js';
import { ProgramError, ProgramSpec, VmInstruction } from './vm';
import { prepareRfq, setupWorld, World, WorldOptions } from './world';
import { PROGRAMS, USDC, SOL } from './constants';
import { discriminator } from './anchor';
import { MM_ID } from './world';

export interface ScenarioOutcome {
  /** `ok`, or the program error variant that rejected the transaction. */
  outcome: string;
  /** Human readable detail (profit, fee, balances...) shown in the report. */
  notes: string;
}

export interface Scenario {
  group: string;
  name: string;
  expect: string;
  run: () => ScenarioOutcome;
}

// ------------------------------------------------------------------------------- helpers

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

interface Execution {
  world: World;
  pipeline: VmInstruction[];
}

export function execute(
  options: Partial<WorldOptions> = {},
  mutate?: (world: World, pipeline: VmInstruction[]) => VmInstruction[],
  advanceSlots = 0n,
): Execution & { error?: ProgramError } {
  const world = setupWorld(options);
  prepareRfq(world, options);
  if (advanceSlots > 0n) world.vm.clock.slot += advanceSlots;
  let pipeline = world.buildPipeline();
  if (mutate) pipeline = mutate(world, pipeline);
  try {
    world.vm.execute(pipeline);
    return { world, pipeline };
  } catch (error) {
    if (error instanceof ProgramError) return { world, pipeline, error };
    throw error;
  }
}

export function snapshotBalances(world: World): Record<string, bigint> {
  const keys = [
    world.keys.takerUsdc,
    world.keys.takerSol,
    world.keys.maker1UsdcVault,
    world.keys.maker1SolVault,
    world.keys.maker2UsdcVault,
    world.keys.maker2SolVault,
    world.keys.jupiterVault,
  ];
  const out: Record<string, bigint> = {};
  for (const key of keys) out[key] = world.vm.tokenAmount(key);
  return out;
}

function assertUnchanged(before: Record<string, bigint>, after: Record<string, bigint>): void {
  for (const [key, amount] of Object.entries(before)) {
    assertEqual(after[key], amount, `balance ${key.slice(0, 8)}`);
  }
}

const usdc = (value: bigint): string => `${Number(value) / 1e6} USDC`;
const sol = (value: bigint): string => `${Number(value) / 1e9} SOL`;

// ------------------------------------------------------------------------------- scenarios

export const SCENARIOS: Scenario[] = [
  {
    group: '1. Economics',
    name: 'profitable round trip realises exactly 300 USDC',
    expect: 'ok',
    run: () => {
      const { world, error } = execute();
      assert(!error, `unexpected ${error?.errorName}`);
      assertEqual(world.vm.tokenAmount(world.keys.takerUsdc), USDC(300), 'taker USDC');
      assertEqual(world.vm.tokenAmount(world.keys.takerSol), 0n, 'taker SOL');
      const settled = world.vm.events.filter((event) => event.name === 'ArbSettled').pop()!;
      assertEqual(settled.data.realized_net_profit, USDC(300), 'realised profit');
      return {
        outcome: 'ok',
        notes: `profit ${usdc(USDC(300))}, intermediate token flat`,
      };
    },
  },
  {
    group: '1. Economics',
    name: 'maker inventory and Jupiter vault move exactly as quoted',
    expect: 'ok',
    run: () => {
      const world = setupWorld();
      prepareRfq(world);
      const before = snapshotBalances(world);
      world.vm.execute(world.buildPipeline());
      const after = snapshotBalances(world);
      assertEqual(
        after[world.keys.maker1UsdcVault] - before[world.keys.maker1UsdcVault],
        USDC(100_000),
        'maker1 USDC in',
      );
      assertEqual(
        before[world.keys.maker1SolVault] - after[world.keys.maker1SolVault],
        SOL(500),
        'maker1 SOL out',
      );
      assertEqual(
        after[world.keys.maker2SolVault] - before[world.keys.maker2SolVault],
        SOL(500),
        'maker2 SOL in',
      );
      assertEqual(
        before[world.keys.maker2UsdcVault] - after[world.keys.maker2UsdcVault],
        USDC(100_300),
        'maker2 USDC out',
      );
      assertEqual(after[world.keys.jupiterVault], before[world.keys.jupiterVault], 'jupiter vault');
      return {
        outcome: 'ok',
        notes: 'MM1 +100k USDC / -500 SOL, MM2 +500 SOL / -100.3k USDC, Jupiter made whole',
      };
    },
  },
  {
    group: '1. Economics',
    name: '5 bps flashloan fee is priced in (profit 300 -> 250 USDC)',
    expect: 'ok',
    run: () => {
      const { world, error } = execute({ flashloanFeeBps: 5 });
      assert(!error, `unexpected ${error?.errorName}`);
      assertEqual(world.vm.tokenAmount(world.keys.takerUsdc), USDC(250), 'taker USDC');
      const quoted = world.vm.events.filter((event) => event.name === 'ArbQuoted').pop()!;
      assertEqual(quoted.data.flashloan_fee, USDC(50), 'fee');
      assertEqual(quoted.data.required_repayment, USDC(100_050), 'repayment');
      return { outcome: 'ok', notes: 'fee 50 USDC read from the on-chain admin account' };
    },
  },
  {
    group: '1. Economics',
    name: '100 bps fee makes the same trade unprofitable',
    expect: 'Unprofitable',
    run: () => {
      const { error } = execute({ flashloanFeeBps: 100 });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'fee 1,000 USDC > 300 USDC spread' };
    },
  },
  {
    group: '1. Economics',
    name: 'pre-existing taker funds are not booked as profit',
    expect: 'ok',
    run: () => {
      const { world, error } = execute({ takerUsdcBalance: USDC(1_000) });
      assert(!error, `unexpected ${error?.errorName}`);
      assertEqual(world.vm.tokenAmount(world.keys.takerUsdc), USDC(1_300), 'taker USDC');
      const settled = world.vm.events.filter((event) => event.name === 'ArbSettled').pop()!;
      assertEqual(settled.data.realized_net_profit, USDC(300), 'realised profit');
      return { outcome: 'ok', notes: 'baseline measured pre-loan, delta = 300 USDC' };
    },
  },

  {
    group: '2. On-chain pre-quote rejections',
    name: 'unprofitable quote (leg 2 returns 99,850 USDC)',
    expect: 'Unprofitable',
    run: () => {
      const world = setupWorld({ leg2Output: USDC(99_850) });
      prepareRfq(world, { leg2Output: USDC(99_850) });
      const before = snapshotBalances(world);
      let error: ProgramError | undefined;
      try {
        world.vm.execute(world.buildPipeline());
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      assertUnchanged(before, snapshotBalances(world));
      assertEqual(world.vm.account(world.keys.flashloanAdmin).data.readUInt8(83), 0, 'loan flag');
      return {
        outcome: error!.errorName,
        notes: 'rejected before any transfer; balances and Jupiter state rolled back',
      };
    },
  },
  {
    group: '2. On-chain pre-quote rejections',
    name: 'expired maker quote',
    expect: 'QuoteExpired',
    run: () => {
      const { error } = execute({ quoteExpiryOffset: 50, rfqExpiryOffset: 10_000 }, undefined, 100n);
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'quoted at slot+50, executed at slot+100' };
    },
  },
  {
    group: '2. On-chain pre-quote rejections',
    name: 'expired RFQ',
    expect: 'RfqExpired',
    run: () => {
      const { error } = execute({ quoteExpiryOffset: 10_000, rfqExpiryOffset: 50 }, undefined, 100n);
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'RFQ expiry is slot based' };
    },
  },
  {
    group: '2. On-chain pre-quote rejections',
    name: 'quote addressed to another taker (anti-sniping)',
    expect: 'QuoteTakerMismatch',
    run: () => {
      const world = setupWorld();
      prepareRfq(world, { maker2DesignatedTaker: world.actors.outsider.publicKey.toBase58() });
      let error: ProgramError | undefined;
      try {
        world.vm.execute(world.buildPipeline());
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'maker 2 quoted the outsider, not the taker' };
    },
  },
  {
    group: '2. On-chain pre-quote rejections',
    name: 'leg 2 input does not consume leg 1 output exactly',
    expect: 'IntermediateAmountMismatch',
    run: () => {
      const { error } = execute({ leg2Input: SOL(499) });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: '1 SOL of intermediate dust would be stranded' };
    },
  },
  {
    group: '2. On-chain pre-quote rejections',
    name: 'leg 1 input does not equal the borrowed amount',
    expect: 'Leg1InputNotEqualBorrow',
    run: () => {
      const { error } = execute({ leg1Input: USDC(99_000) });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: '1,000 USDC of borrowed capital would idle' };
    },
  },
  {
    group: '2. On-chain pre-quote rejections',
    name: 'leg 1 from a maker the RFQ did not designate',
    expect: 'UnauthorizedMaker',
    run: () => {
      const { error } = execute({ rfqFixedMaker: 'maker2' });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'RFQ.fixed_maker = maker2, quote1 from maker1' };
    },
  },
  {
    group: '2. On-chain pre-quote rejections',
    name: 'profit below the requested floor',
    expect: 'Unprofitable',
    run: () => {
      const { error } = execute({ minProfitAmount: USDC(400) });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: '300 USDC realised < 400 USDC floor' };
    },
  },

  {
    group: '3. Flashloan compliancy',
    name: 'CPI into Jupiter Lend is rejected (6012)',
    expect: 'FlashloanCPICallNotAllowed',
    run: () => {
      const world = setupWorld();
      prepareRfq(world);
      const borrow = world.buildCore()[0];
      const wrapperId = new PublicKey(Buffer.alloc(32, 9)).toBase58();
      const wrapper: ProgramSpec = {
        name: 'cpi_wrapper',
        id: wrapperId,
        errors: new Map(),
        instructions: new Map([
          [
            '0101010101010101',
            {
              name: 'proxy',
              accounts: borrow.accounts.map((meta, index) => ({
                name: `a${index}`,
                rustType: 'UncheckedAccount',
                writable: meta.isWritable,
                signer: meta.isSigner,
                init: false,
              })),
              argFields: [],
              handler: (ctx) => {
                ctx.vm.invoke(
                  ctx,
                  PROGRAMS.jupiterFlashloan,
                  'flashloan_borrow',
                  borrow.accounts.map((meta) => ctx.vm.account(meta.pubkey)),
                  { amount: USDC(100_000) },
                  [],
                  'flashloan_borrow (via CPI)',
                );
              },
            },
          ],
        ]),
      };
      world.vm.mount(wrapper);
      world.vm.setAccount({
        key: wrapperId,
        owner: 'NativeLoader1111111111111111111111111111111',
        lamports: 1n,
        data: Buffer.alloc(0),
        executable: true,
      });
      let error: ProgramError | undefined;
      try {
        world.vm.execute([
          {
            programId: wrapperId,
            accounts: borrow.accounts,
            data: Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]),
            label: 'cpi_wrapper.proxy',
          },
        ]);
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'CPI must be rejected');
      assertEqual(error!.code, 6012, 'error code');
      return { outcome: error!.errorName, notes: 'stack height > 1 is fatal for flashloan_borrow' };
    },
  },
  {
    group: '3. Flashloan compliancy',
    name: 'borrow with no scheduled payback is rejected (6009)',
    expect: 'FlashloanPaybackNotFound',
    run: () => {
      const world = setupWorld();
      prepareRfq(world);
      const pipeline = world
        .buildPipeline()
        .filter((instruction) => !instruction.label.includes('payback'));
      let error: ProgramError | undefined;
      try {
        world.vm.execute(pipeline);
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      assertEqual(error!.code, 6009, 'error code');
      return { outcome: error!.errorName, notes: 'instructions sysvar introspection' };
    },
  },
  {
    group: '3. Flashloan compliancy',
    name: 'payback that is not the last instruction is rejected',
    expect: 'FlashloanPaybackNotLast',
    run: () => {
      const world = setupWorld();
      prepareRfq(world);
      const pipeline = world.buildPipeline();
      pipeline.push({
        programId: PROGRAMS.computeBudget,
        accounts: [],
        data: Buffer.from([2, 0, 0, 0, 0]),
        label: 'trailing no-op',
      });
      let error: ProgramError | undefined;
      try {
        world.vm.execute(pipeline);
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'nothing may run after the loan is closed' };
    },
  },

  {
    group: '4. Pipeline integrity',
    name: 'leg 2 before leg 1',
    expect: 'LegOutOfOrder',
    run: () => {
      const { error } = execute({}, (world, pipeline) => {
        const copy = [...pipeline];
        const leg1 = copy[4];
        copy[4] = copy[5];
        copy[5] = leg1;
        return copy;
      });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'session pins the leg order' };
    },
  },
  {
    group: '4. Pipeline integrity',
    name: 'settlement before both legs',
    expect: 'LegsNotFilled',
    run: () => {
      const { error } = execute({}, (world, pipeline) => {
        const copy = [...pipeline];
        const settle = copy[6];
        copy[6] = copy[4];
        copy[4] = settle;
        return copy;
      });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'settlement re-checks the session flags' };
    },
  },
  {
    group: '4. Pipeline integrity',
    name: 'replayed fill leg',
    expect: 'QuoteAlreadyFilled',
    run: () => {
      const { error } = execute({}, (world, pipeline) => {
        const copy = [...pipeline];
        copy.splice(5, 0, { ...copy[4] });
        return copy;
      });
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'quote.filled and session.leg1_filled' };
    },
  },
  {
    group: '4. Pipeline integrity',
    name: 'missing maker quote',
    expect: 'error',
    run: () => {
      const world = setupWorld();
      prepareRfq(world, { skipMaker2Quote: true });
      let error: ProgramError | undefined;
      try {
        world.vm.execute(world.buildPipeline());
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      return { outcome: 'error', notes: `failed at the fill with ${error!.errorName}` };
    },
  },
  {
    group: '4. Pipeline integrity',
    name: 'whole arbitrage replayed after settlement',
    expect: 'error',
    run: () => {
      const world = setupWorld();
      prepareRfq(world);
      world.vm.execute(world.buildPipeline());
      let error: ProgramError | undefined;
      try {
        world.vm.execute(world.buildPipeline());
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      return { outcome: 'error', notes: `second run rejected with ${error!.errorName}` };
    },
  },

  {
    group: '5. Maker-side guards',
    name: 'quote without enough inventory',
    expect: 'MakerInventoryInsufficient',
    run: () => {
      const world = setupWorld();
      let error: ProgramError | undefined;
      try {
        prepareRfq(world, { maker2UsdcInventory: USDC(100) });
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'post_quote checks live vault balance' };
    },
  },
  {
    group: '5. Maker-side guards',
    name: 'settlement after the quote expiry',
    expect: 'QuoteExpired',
    run: () => {
      const world = setupWorld();
      prepareRfq(world, { quoteExpiryOffset: 50, rfqExpiryOffset: 10_000 });
      world.vm.clock.slot += 100n;
      let error: ProgramError | undefined;
      try {
        world.vm.execute(world.buildPipeline());
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'both the pre-quote and the MM program check' };
    },
  },
  {
    group: '5. Maker-side guards',
    name: 'pause switch blocks new quotes',
    expect: 'Paused',
    run: () => {
      const world = setupWorld();
      const mmAdmin = world.actors.mmAdmin.publicKey.toBase58();
      world.vm.execute([
        {
          programId: MM_ID,
          accounts: [
            { pubkey: world.keys.mmConfig, isSigner: false, isWritable: true },
            { pubkey: mmAdmin, isSigner: true, isWritable: false },
          ],
          data: Buffer.concat([discriminator('global', 'set_paused'), Buffer.from([1])]),
          label: 'fixed_market_maker.set_paused(true)',
        },
      ]);
      let error: ProgramError | undefined;
      try {
        prepareRfq(world);
      } catch (caught) {
        error = caught as ProgramError;
      }
      assert(Boolean(error), 'must fail');
      return { outcome: error!.errorName, notes: 'venue-wide emergency switch' };
    },
  },
];

export function runAll(): { scenario: Scenario; outcome: ScenarioOutcome; ok: boolean }[] {
  return SCENARIOS.map((scenario) => {
    let outcome: ScenarioOutcome;
    try {
      outcome = scenario.run();
    } catch (error) {
      outcome = {
        outcome: 'assertion-failed',
        notes: error instanceof Error ? error.message : String(error),
      };
    }
    const ok =
      scenario.expect === 'error'
        ? outcome.outcome !== 'ok' && outcome.outcome !== 'assertion-failed'
        : outcome.outcome === scenario.expect;
    return { scenario, outcome, ok };
  });
}
