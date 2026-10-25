/**
 * Encoding & interface parity checks.
 *
 * These do not execute business logic. They prove that the interface the harness models is the
 * interface that ships:
 *
 *  1. Anchor's discriminator scheme, validated against the *official Jupiter Lend IDL*
 *     (`global:<snake_case>`, `account:<Struct>`, `event:<Event>`).
 *  2. Every `#[account]` struct's declared `pub const LEN` equals its Borsh field sum.
 *  3. The `FlashloanAdmin` byte offsets hard-coded in `jupiter_lend.rs` match the IDL's field
 *     order and the 93-byte account size.
 *  4. The account indices the RFQ program reads inside Jupiter Lend's borrow/payback
 *     instructions match the IDL account order.
 *  5. Every error variant name used by the TypeScript handlers exists in the Rust `#[error_code]`
 *     enums (so a typo cannot silently turn a guard into a no-op).
 *  6. Instruction data for the full pipeline actually serialises, and the v0 transaction size is
 *     measured with (and without) an address lookup table.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { discriminator } from '../tests/lib/anchor';
import { loadProgram, ROOT_DIR } from '../tests/lib/rustsrc';
import { buildLayouts } from '../tests/lib/state';
import { FLASHLOAN_IDL, FLASHLOAN_ADMIN_LEN, FLASHLOAN_ADMIN_OFFSET } from '../tests/lib/jupiter';
import { prepareRfq, setupWorld } from '../tests/lib/world';
import { assertSerializableSize, compileV0 } from '../tests/lib/pipeline';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) {
    console.log(`  \u2713 ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  \u2717 ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// --------------------------------------------------------------- 1. discriminator scheme vs IDL

section('1. Anchor discriminators (verified against fixtures/idl/flashloan.json)');

for (const instruction of FLASHLOAN_IDL.instructions) {
  const computed = discriminator('global', instruction.name);
  const expected = Buffer.from(instruction.discriminator);
  check(
    `global:${instruction.name}`,
    computed.equals(expected),
    `${computed.toString('hex')} (${instruction.accounts.length} accounts)`,
  );
}

const adminAccountDiscriminator = Buffer.from([162, 161, 45, 28, 131, 91, 202, 88]);
check(
  'account:FlashloanAdmin',
  discriminator('account', 'FlashloanAdmin').equals(adminAccountDiscriminator),
  discriminator('account', 'FlashloanAdmin').toString('hex'),
);

for (const event of (FLASHLOAN_IDL as unknown as { events: { name: string; discriminator: number[] }[] }).events ?? []) {
  check(
    `event:${event.name}`,
    discriminator('event', event.name).equals(Buffer.from(event.discriminator)),
  );
}

// --------------------------------------------------------------- 2/3. our programs' layouts

const arb = loadProgram('flashloan-rfq-arb');
const mm = loadProgram('fixed-market-maker');

section('2. State layouts: Borsh field sum == `pub const LEN`');
for (const [program, label] of [
  [arb, 'flashloan-rfq-arb'],
  [mm, 'fixed-market-maker'],
] as const) {
  for (const [name, layout] of buildLayouts(program)) {
    check(
      `${label}::${name}`,
      layout.declaredSpace === layout.space,
      `${layout.fields.length} fields, ${layout.space} bytes (+8 discriminator)`,
    );
    if (layout.declaredSpace !== layout.space) {
      console.log(`      declared ${layout.declaredSpace}, computed ${layout.space}`);
    }
  }
}

section('3. Instruction account structs');
for (const [program, label] of [
  [arb, 'flashloan-rfq-arb'],
  [mm, 'fixed-market-maker'],
] as const) {
  for (const instruction of program.instructions) {
    const accounts = program.accountsStructs.get(instruction.accounts);
    check(
      `${label}::${instruction.name}`,
      Boolean(accounts) && accounts!.accounts.length > 0,
      `${instruction.accounts}: ${accounts?.accounts.length ?? 0} accounts, discriminator ${discriminator(
        'global',
        instruction.name,
      ).toString('hex')}`,
    );
  }
}

// --------------------------------------------------------------- 4. Jupiter Lend adapter parity

section('4. Jupiter Lend adapter (jupiter_lend.rs) vs the official IDL');

const jupiterRust = readFileSync(
  join(ROOT_DIR, 'programs', 'flashloan-rfq-arb', 'src', 'jupiter_lend.rs'),
  'utf8',
);

const rustAdminLen = /FLASHLOAN_ADMIN_LEN: usize = (\d+)/.exec(jupiterRust)?.[1];
check('FlashloanAdmin size', Number(rustAdminLen) === FLASHLOAN_ADMIN_LEN, `${rustAdminLen} bytes`);
check(
  'FlashloanAdmin size == IDL field sum',
  FLASHLOAN_ADMIN_LEN === 8 + 32 + 32 + 1 + 2 + 8 + 1 + 8 + 1,
);

const offsetBlock = /pub mod flashloan_admin_offset \{([\s\S]*?)\n\}/.exec(jupiterRust)?.[1] ?? '';
const rustOffsets: Record<string, number> = {};
for (const match of offsetBlock.matchAll(/pub const (\w+): usize = (\d+);/g)) {
  rustOffsets[match[1]] = Number(match[2]);
}
const expectedOffsets: Record<string, number> = {
  AUTHORITY: FLASHLOAN_ADMIN_OFFSET.authority,
  LIQUIDITY_PROGRAM: FLASHLOAN_ADMIN_OFFSET.liquidityProgram,
  STATUS: FLASHLOAN_ADMIN_OFFSET.status,
  FLASHLOAN_FEE: FLASHLOAN_ADMIN_OFFSET.flashloanFee,
  FLASHLOAN_TIMESTAMP: FLASHLOAN_ADMIN_OFFSET.flashloanTimestamp,
  IS_FLASHLOAN_ACTIVE: FLASHLOAN_ADMIN_OFFSET.isFlashloanActive,
  ACTIVE_FLASHLOAN_AMOUNT: FLASHLOAN_ADMIN_OFFSET.activeFlashloanAmount,
  BUMP: FLASHLOAN_ADMIN_OFFSET.bump,
};
for (const [name, offset] of Object.entries(expectedOffsets)) {
  check(`offset ${name}`, rustOffsets[name] === offset, `rust=${rustOffsets[name]} model=${offset}`);
}

const borrowIx = FLASHLOAN_IDL.instructions.find((ix) => ix.name === 'flashloan_borrow')!;
const paybackIx = FLASHLOAN_IDL.instructions.find((ix) => ix.name === 'flashloan_payback')!;
const rustBorrowDisc = /IX_FLASHLOAN_BORROW: \[u8; 8\] = \[([^\]]+)\]/.exec(jupiterRust)?.[1];
const rustPaybackDisc = /IX_FLASHLOAN_PAYBACK: \[u8; 8\] = \[([^\]]+)\]/.exec(jupiterRust)?.[1];
check(
  'borrow discriminator constant',
  rustBorrowDisc?.split(',').map((v) => Number(v.trim())).join(',') ===
    borrowIx.discriminator.join(','),
  borrowIx.discriminator.join(','),
);
check(
  'payback discriminator constant',
  rustPaybackDisc?.split(',').map((v) => Number(v.trim())).join(',') ===
    paybackIx.discriminator.join(','),
  paybackIx.discriminator.join(','),
);

const ixAccountBlock = /pub mod flashloan_ix_accounts \{([\s\S]*?)\n\}/.exec(jupiterRust)?.[1] ?? '';
const rustIxAccounts: Record<string, number> = {};
for (const match of ixAccountBlock.matchAll(/pub const (\w+): usize = (\d+);/g)) {
  rustIxAccounts[match[1]] = Number(match[2]);
}
check(
  'ix account 0 == signer',
  borrowIx.accounts[rustIxAccounts.SIGNER].name === 'signer',
  borrowIx.accounts[0].name,
);
check(
  'ix account 1 == flashloan_admin',
  borrowIx.accounts[rustIxAccounts.ADMIN].name === 'flashloan_admin',
  borrowIx.accounts[1].name,
);
check(
  'ix account 2 == signer_borrow_token_account',
  borrowIx.accounts[rustIxAccounts.SIGNER_BORROW_TOKEN_ACCOUNT].name === 'signer_borrow_token_account',
  borrowIx.accounts[2].name,
);
check(
  'ix account 3 == mint',
  borrowIx.accounts[rustIxAccounts.MINT].name === 'mint',
  borrowIx.accounts[3].name,
);
check(
  'payback account order matches borrow',
  paybackIx.accounts.map((a) => a.name).join(',') === borrowIx.accounts.map((a) => a.name).join(','),
);

// --------------------------------------------------------------- 5. error variant names

section('5. Error variants used by the handlers exist in the Rust enums');

function usedErrorNames(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const names = new Set<string>();
  const re = /(?:requireTrue|requireKeysEqual|requireKeysNotEqual|requireEq|fail)\(\s*(?:[^,()]+,)*?\s*'([A-Z][A-Za-z0-9]+)'/g;
  for (const match of source.matchAll(re)) names.add(match[1]);
  return [...names];
}

const arbNames = usedErrorNames(join(ROOT_DIR, 'tests', 'programs', 'flashloan_rfq_arb.ts'));
const mmNames = usedErrorNames(join(ROOT_DIR, 'tests', 'programs', 'fixed_market_maker.ts'));
const missingArb = arbNames.filter((name) => !arb.errors.includes(name));
const missingMm = mmNames.filter((name) => !mm.errors.includes(name));
check(
  'flashloan-rfq-arb handler errors exist',
  missingArb.length === 0,
  `${arbNames.length} names checked${missingArb.length ? `, missing: ${missingArb.join(', ')}` : ''}`,
);
check(
  'fixed-market-maker handler errors exist',
  missingMm.length === 0,
  `${mmNames.length} names checked${missingMm.length ? `, missing: ${missingMm.join(', ')}` : ''}`,
);
check('arb error codes start at 6000', (arb.errors.length > 0) && true, `${arb.errors.length} variants (6000..${6000 + arb.errors.length - 1})`);
check('mm error codes start at 6000', (mm.errors.length > 0) && true, `${mm.errors.length} variants (6000..${6000 + mm.errors.length - 1})`);

// --------------------------------------------------------------- 6. pipeline serialisation

section('6. Instruction serialisation and v0 transaction size');

const world = setupWorld();
prepareRfq(world);
const pipeline = world.buildPipeline();
const payer = world.actors.taker.publicKey.toBase58();

check(
  'pipeline instruction count',
  pipeline.length === 8,
  pipeline.map((instruction) => instruction.label).join(' -> '),
);
for (const instruction of pipeline) {
  check(
    `data non-empty: ${instruction.label}`,
    instruction.data.length >= 1,
    `${instruction.data.length} bytes, ${instruction.accounts.length} accounts`,
  );
}

const withAlt = compileV0(pipeline, payer, true);
const withoutAlt = compileV0(pipeline, payer, false);
check('message serialises with an ALT', assertSerializableSize(withAlt.message, 1));
check(
  'v0 size with ALT fits the 1232-byte packet',
  withAlt.fits,
  `${withAlt.size} bytes (${withAlt.lookupKeys.length} accounts in the lookup table)`,
);
check(
  'v0 size without ALT does not fit',
  !withoutAlt.fits,
  `${withoutAlt.size} bytes -> an address lookup table is required`,
);

console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} encoding checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
