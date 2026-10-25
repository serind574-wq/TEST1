/**
 * The study report: prints everything the harness verifies, with real computed values.
 *
 * Run with `npm run test:report`. Exits non-zero only if a scenario mismatches or the transaction
 * does not fit in a packet, so it doubles as a smoke test.
 */
import { prepareRfq, setupWorld } from './lib/world';
import { compileV0, assertSerializableSize, MAX_TRANSACTION_SIZE } from './lib/pipeline';
import { runAll } from './lib/scenarios';
import { ARB_PROGRAM } from './programs/flashloan_rfq_arb';
import { MM_PROGRAM } from './programs/fixed_market_maker';
import { FLASHLOAN_IDL, FLASHLOAN_ADMIN_LEN, decodeFlashloanAdmin } from './lib/jupiter';
import {
  PROGRAMS,
  MINTS,
  JUPITER_FLASHLOAN_ADMIN,
  JUPITER_LIQUIDITY_ACCOUNTS,
  USDC,
  SOL,
} from './lib/constants';
import { pda } from './lib/pda';
import { discriminator } from './lib/anchor';
import { ARB_ID, MM_ID } from './lib/world';

const line = (char = '-') => console.log(char.repeat(96));
const heading = (title: string) => {
  console.log('');
  line('=');
  console.log(title);
  line('=');
};
const sub = (title: string) => {
  console.log('');
  line();
  console.log(title);
  line();
};
const pad = (value: string | number, width: number): string => String(value).padEnd(width);
const padLeft = (value: string | number, width: number): string => String(value).padStart(width);
const usdc = (value: bigint): string => (Number(value) / 1e6).toLocaleString('en-US');
const sol = (value: bigint): string => (Number(value) / 1e9).toLocaleString('en-US');

heading('JUPITER LEND FLASH LOAN  +  DIRECT RFQ ROUND TRIP  -  ON-CHAIN STUDY HARNESS');

console.log(`
Scope: two Anchor programs that (a) post and settle direct, bilateral RFQ quotes with fixed
market makers and (b) price a two-leg round trip ON CHAIN before the flash loan's capital is
used, inside one atomic v0 transaction.

  Leg 1:  taker pays borrowed USDC -> fixed MM 1 delivers SOL
  Leg 2:  taker pays that SOL     -> fixed MM 2 delivers USDC  (back to the borrowed token)
  Settle: prove the USDC account covers principal + fee + profit, then Jupiter Lend is repaid.
`);

sub('0. What this harness proves - and what it does not');

console.log(`
VERIFIED HERE (offline, deterministic):
  * Anchor discriminators / account layouts / error codes, cross-checked against the OFFICIAL
    Jupiter Lend IDL vendored in fixtures/idl/flashloan.json (v${FLASHLOAN_IDL.metadata.version}).
  * Real PDAs and associated token accounts (ed25519 on-curve logic from @solana/web3.js).
  * The exact atomic instruction pipeline, serialised with @solana/web3.js, measured against the
    1232-byte packet limit.
  * Every guard in both programs, plus atomic rollback, in a deterministic in-memory VM that
    transcribes the Rust handlers (${runAll().length} scenarios).

NOT VERIFIED HERE (needs a machine with the Solana toolchain and network):
  * The Rust programs were NOT compiled in this environment (no cargo/solana/anchor available).
    Run \`anchor build && anchor test\` to execute the same scenarios against real BPF.
  * The VM is a specification model, not a BPF interpreter: it enforces signer/writable/owner
    rules, PDAs, atomicity, the instructions sysvar and stack height, not compute units.
  * Jupiter Lend's reserve/borrow-position/rate-model addresses are stand-ins (their seeds live
    in the liquidity layer, which is not in the published IDL). The admin PDA, mint addresses
    and instruction interfaces are real.
`);

sub('1. Programs');

console.log(
  [
    pad('program', 26),
    pad('program id', 46),
    'instructions',
  ].join(''),
);
line();
console.log(
  [
    pad(ARB_PROGRAM.idlName, 26),
    pad(ARB_PROGRAM.programId, 46),
    String(ARB_PROGRAM.instructions.length),
  ].join(''),
);
console.log(
  [
    pad(MM_PROGRAM.idlName, 26),
    pad(MM_PROGRAM.programId, 46),
    String(MM_PROGRAM.instructions.length),
  ].join(''),
);
console.log('');
for (const program of [ARB_PROGRAM, MM_PROGRAM]) {
  console.log(`${program.idlName}:`);
  for (const instruction of program.instructions) {
    const accounts = program.accountsStructs.get(instruction.accounts)!;
    console.log(
      `  ${pad(discriminator('global', instruction.name).toString('hex'), 20)}` +
        `${pad(instruction.name, 24)}` +
        `${padLeft(accounts.accounts.length, 2)} accounts  ` +
        `${instruction.args.length} args`,
    );
  }
}

sub('2. Jupiter Lend interface (from the official IDL)');

const admin = decodeFlashloanAdmin(
  (() => {
    const world = setupWorld();
    return world.vm.account(world.keys.flashloanAdmin).data;
  })(),
);

console.log(`flashloan program : ${PROGRAMS.jupiterFlashloan}`);
console.log(`liquidity program : ${PROGRAMS.jupiterLiquidity}`);
console.log(`admin PDA         : ${JUPITER_FLASHLOAN_ADMIN}   (seeds ["flashloan_admin"], bump ${admin.bump})`);
console.log(`reserve PDA       : ${JUPITER_LIQUIDITY_ACCOUNTS.reservesLiquidity}   (seeds ["reserve", mint])`);
console.log('');
console.log(`FlashloanAdmin account: ${FLASHLOAN_ADMIN_LEN} bytes (8-byte discriminator + 85 bytes of Borsh fields)`);
line();
console.log(`${pad('offset', 8)}${pad('field', 26)}${pad('type', 10)}value`);
line();
const adminRows: [number, string, string, string][] = [
  [0, '(discriminator)', 'u8[8]', 'a2a12d1c835bca58'],
  [8, 'authority', 'Pubkey', admin.authority],
  [40, 'liquidity_program', 'Pubkey', admin.liquidity_program],
  [72, 'status', 'bool', String(admin.status)],
  [73, 'flashloan_fee', 'u16', `${admin.flashloan_fee_bps} bps`],
  [75, 'flashloan_timestamp', 'u64', String(admin.flashloan_timestamp)],
  [83, 'is_flashloan_active', 'bool', String(admin.is_flashloan_active)],
  [84, 'active_flashloan_amount', 'u64', String(admin.active_flashloan_amount)],
  [92, 'bump', 'u8', String(admin.bump)],
];
for (const [offset, field, type, value] of adminRows) {
  console.log(`${pad(offset, 8)}${pad(field, 26)}${pad(type, 10)}${value}`);
}
console.log(`
Both programs read the fee and the protocol status from THIS account at quote time - never from
instruction arguments - so a fee change by Jupiter Lend cannot be front-run by a stale quote.
`);
console.log('Error codes enforced by the model (from the IDL):');
for (const error of FLASHLOAN_IDL.errors.filter((entry) =>
  [
    'FlashloanInvalidParams',
    'FlashloanAlreadyActive',
    'FlashloanPaybackNotFound',
    'FlashloanInvalidInstruction',
    'FlashloanPaused',
    'FlashloanCPICallNotAllowed',
    'FlashloanMultiplePaybacksFound',
  ].includes(entry.name),
)) {
  console.log(`  ${error.code}  ${pad(error.name, 32)}${error.msg}`);
}

sub('3. Accounts and PDAs of the RFQ flow');

const world = setupWorld();
prepareRfq(world);
const world2 = setupWorld();
const rfqPda = pda.rfq(ARB_ID, world.actors.taker.publicKey.toBase58(), 1n);
const maker1 = world.actors.maker1.publicKey.toBase58();
const maker2 = world.actors.maker2.publicKey.toBase58();
void world2;

const pdaRows: [string, string, string][] = [
  ['arb config', `["config"]`, pda.config(ARB_ID).address],
  ['rfq request', `["rfq", taker, nonce]`, rfqPda.address],
  ['arb session', `["session", rfq]`, pda.session(ARB_ID, rfqPda.address).address],
  ['mm config', `["mm_config"]`, pda.mmConfig(MM_ID).address],
  ['maker 1', `["maker", maker1]`, pda.maker(MM_ID, maker1).address],
  ['maker 2', `["maker", maker2]`, pda.maker(MM_ID, maker2).address],
  ['quote 1', `["quote", rfq, maker1]`, pda.quote(MM_ID, rfqPda.address, maker1).address],
  ['quote 2', `["quote", rfq, maker2]`, pda.quote(MM_ID, rfqPda.address, maker2).address],
  ['mm1 SOL vault auth', `["mm_vault", maker1, SOL]`, pda.vaultAuthority(MM_ID, maker1, MINTS.wsol).address],
  ['mm2 USDC vault auth', `["mm_vault", maker2, USDC]`, pda.vaultAuthority(MM_ID, maker2, MINTS.usdc).address],
];
line();
console.log(`${pad('account', 22)}${pad('seeds', 30)}address`);
line();
for (const [label, seeds, address] of pdaRows) {
  console.log(`${pad(label, 22)}${pad(seeds, 30)}${address}`);
}
console.log(`
Tokens: borrow mint ${MINTS.usdc} (USDC, 6 dp)
        intermediate ${MINTS.wsol} (WSOL, 9 dp)
`);

sub('4. The atomic transaction');

const pipeline = world.buildPipeline();
const payer = world.actors.taker.publicKey.toBase58();
const withAlt = compileV0(pipeline, payer, true);
const withoutAlt = compileV0(pipeline, payer, false);

line();
console.log(`${pad('#', 3)}${pad('instruction', 44)}${padLeft('accts', 6)}${padLeft('data', 6)}`);
line();
pipeline.forEach((instruction, index) => {
  console.log(
    `${pad(index, 3)}${pad(instruction.label, 44)}${padLeft(instruction.accounts.length, 6)}${padLeft(
      instruction.data.length,
      6,
    )}`,
  );
});
line();
console.log(`
The loan opens at instruction 2 and is priced at instruction 3, before any swap:
  quote_arbitrage reads the two firm quote accounts, both live inventory vaults, the Jupiter
  Lend admin account (fee + status), the clock, and the transaction's own instruction list.
  If anything is off - expired, unprofitable, wrong maker, wrong taker, missing payback - the
  transaction dies before a single token moves.
`);
console.log(`Total instructions      : ${pipeline.length}`);
console.log(`Distinct accounts       : ${withAlt.staticKeys.length}`);
console.log(`Signatures              : 1 (the taker; the makers never sign this transaction)`);
console.log(`v0 size with an ALT     : ${withAlt.size} bytes / ${MAX_TRANSACTION_SIZE} (fills: ${withAlt.fits}) - ${withAlt.lookupKeys.length} accounts compressed`);
console.log(`v0 size without an ALT  : ${withoutAlt.size} bytes (fills: ${withoutAlt.fits})`);
console.log(`Size cross-check        : ${assertSerializableSize(withAlt.message, 1) ? 'matches the real @solana/web3.js serializer' : 'computed only (over the packet limit)'}`);
console.log(`
Conclusion: an address lookup table is MANDATORY for this pipeline. 14-account Jupiter Lend
instructions plus two 13-account RFQ fills cannot fit in 1232 bytes otherwise.
`);

sub('5. Live execution trace (happy path)');

const live = setupWorld();
prepareRfq(live);
const before = {
  takerUsdc: live.vm.tokenAmount(live.keys.takerUsdc),
  takerSol: live.vm.tokenAmount(live.keys.takerSol),
  mm1Usdc: live.vm.tokenAmount(live.keys.maker1UsdcVault),
  mm1Sol: live.vm.tokenAmount(live.keys.maker1SolVault),
  mm2Usdc: live.vm.tokenAmount(live.keys.maker2UsdcVault),
  mm2Sol: live.vm.tokenAmount(live.keys.maker2SolVault),
  jupiter: live.vm.tokenAmount(live.keys.jupiterVault),
};
const eventsBefore = live.vm.events.length;
live.vm.execute(live.buildPipeline());
const after = {
  takerUsdc: live.vm.tokenAmount(live.keys.takerUsdc),
  takerSol: live.vm.tokenAmount(live.keys.takerSol),
  mm1Usdc: live.vm.tokenAmount(live.keys.maker1UsdcVault),
  mm1Sol: live.vm.tokenAmount(live.keys.maker1SolVault),
  mm2Usdc: live.vm.tokenAmount(live.keys.maker2UsdcVault),
  mm2Sol: live.vm.tokenAmount(live.keys.maker2SolVault),
  jupiter: live.vm.tokenAmount(live.keys.jupiterVault),
};

line();
console.log(`${pad('balance', 22)}${padLeft('before', 18)}${padLeft('after', 18)}${padLeft('delta', 18)}`);
line();
const balanceRows: [string, bigint, bigint, (value: bigint) => string][] = [
  ['taker USDC', before.takerUsdc, after.takerUsdc, usdc],
  ['taker SOL', before.takerSol, after.takerSol, sol],
  ['MM1 USDC vault', before.mm1Usdc, after.mm1Usdc, usdc],
  ['MM1 SOL vault', before.mm1Sol, after.mm1Sol, sol],
  ['MM2 USDC vault', before.mm2Usdc, after.mm2Usdc, usdc],
  ['MM2 SOL vault', before.mm2Sol, after.mm2Sol, sol],
  ['Jupiter reserve', before.jupiter, after.jupiter, usdc],
];
for (const [label, start, end, format] of balanceRows) {
  const delta = end - start;
  const sign = delta > 0n ? '+' : '';
  console.log(
    `${pad(label, 22)}${padLeft(format(start), 18)}${padLeft(format(end), 18)}${padLeft(
      delta === 0n ? '0' : `${sign}${format(delta)}`,
      18,
    )}`,
  );
}

console.log('');
line();
console.log('Events emitted by the arbitrage transaction (Anchor `emit!`, discriminator + Borsh body)');
line();
for (const event of live.vm.events.slice(eventsBefore)) {
  const program = event.program === ARB_ID ? 'arb' : 'mm ';
  const interesting = ['ArbQuoted', 'ArbSettled', 'LegFilled', 'QuoteSettled'].includes(event.name);
  if (!interesting) continue;
  const details: string[] = [];
  for (const key of [
    'leg',
    'maker',
    'amount_in',
    'amount_out',
    'borrow_amount',
    'leg1_output',
    'leg2_output',
    'flashloan_fee',
    'required_repayment',
    'projected_net_profit',
    'realized_net_profit',
    'intermediate_dust',
  ]) {
    if (event.data[key] === undefined) continue;
    const raw = event.data[key];
    if (key === 'maker') details.push(`maker=${String(raw).slice(0, 8)}..`);
    else if (typeof raw === 'bigint') details.push(`${key}=${raw.toString()}`);
    else details.push(`${key}=${String(raw)}`);
  }
  console.log(`  [${program}] ${pad(event.name, 14)}${details.join('  ')}`);
}
console.log(`
  session account after settlement: ${
    live.vm.account(live.keys.session).data.length === 0 ? 'closed (rent refunded to the taker)' : 'still open'
  }
  RFQ status                      : ${live.vm.account(live.keys.rfq).data.readUInt8(8 + 32 * 4 + 8 * 4) === 1 ? 'Filled' : 'not filled'}
  Jupiter loan flag               : ${
    live.vm.account(live.keys.flashloanAdmin).data.readUInt8(83) === 0 ? 'closed (repaid)' : 'OPEN'
  }
`);

sub('6. Scenario matrix');

const results = runAll();
const groups = [...new Set(results.map((result) => result.scenario.group))];
line();
for (const group of groups === undefined ? [] : groups) {
  console.log(group);
  for (const { scenario, outcome, ok } of results.filter(
    (result) => result.scenario.group === group,
  )) {
    const expected =
      scenario.expect === 'error'
        ? 'rejected'
        : scenario.expect === 'ok'
          ? 'accepted'
          : scenario.expect;
    console.log(
      `  ${ok ? '\u2713' : '\u2717'} ${pad(scenario.name, 58)} ${pad(expected, 26)}${outcome.outcome}`,
    );
    if (scenario.expect === 'ok' && ok) console.log(`      ${outcome.notes}`);
  }
}
line();
const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} scenarios matched expectations`);

sub('7. Design notes and open questions');

console.log(`
1. Why the maker does not sign the arbitrage transaction.
   A maker "authorises a price" once, on chain, with post_quote (maker signature). Settlement
   then needs only the taker's signature plus the program-owned inventory vault PDA
   (["mm_vault", maker, mint]) for the deliver leg. The alternative - vault owned by the RFQ
   program - works too, but forces the RFQ program to be trusted with MM inventory.

2. Why quotes must be quote *accounts*, not instruction arguments.
   An argument-passed price is only a claim. A signed quote account is a commitment: it has an
   owner (the MM program), an expiry slot, a designated taker, a filled flag and a live inventory
   check at post AND settle time. quote_arbitrage can then price the trade from state the taker
   cannot forge, and the MM program can refuse a second fill without trusting the taker.

3. Why "flat intermediate token" matters.
   Round trips leak value if leg 2 consumes less than leg 1 produced. evaluate_round_trip requires
   leg2_in == leg1_out exactly, and settlement requires the intermediate balance to return to its
   pre-loan level (max_intermediate_dust tolerance).

4. Flashloan ordering. Jupiter Lend's borrow refuses CPI (stack height) and introspects the
   transaction for a matching payback, so the loan must be a top-level instruction. The RFQ
   pre-quote is placed immediately after it, before either fill: the borrow is verified by
   introspection (borrow index < current index, exactly one payback, and it must be last).

5. Fee semantics. The model charges ceil(amount * fee_bps / 10_000) at payback. Jupiter Lend
   currently charges 0 bps, so the fee term is normally zero; the code still prices it, caps it
   with config.max_flashloan_fee_bps, and fails closed if the admin account reports more.

6. What a production deployment still needs.
   - Split the pipeline's single signer into a dedicated fee-payer/keypair policy (and consider a
     Jito bundle for landing guarantees).
   - Rate-limit fill_rfq_leg per session (one arbitrage per RFQ at a time is already enforced by
     the ["session", rfq] PDA and its close at settlement).
   - Monitor Jupiter Lend's admin account for fee/status changes (read it at quote time - done).
   - Fuzz evaluate_round_trip (proptest) around rounding edges: fee_bps = 1 on tiny amounts.
`);

line('=');
console.log(
  failed.length === 0 && withAlt.fits
    ? 'REPORT COMPLETE - all scenarios matched and the transaction fits in one packet.'
    : 'REPORT INCOMPLETE - see the failures above.',
);
line('=');

process.exit(failed.length === 0 && withAlt.fits ? 0 : 1);
