/**
 * Fixture builder: a deterministic "localnet" containing
 *
 * * the two programs from `programs/` (mounted in the VM with their Rust-derived interfaces),
 * * the Jupiter Lend flashloan program model (driven by the official IDL),
 * * real mainnet mint addresses (USDC / WSOL) and the derived Jupiter Lend admin PDA,
 * * two fixed market makers with PDA-owned inventory vaults,
 * * a taker with associated token accounts.
 *
 * Everything is created through the programs' own instructions wherever possible, so the setup
 * path exercises the same code the arbitrage does.
 */
import { Keypair } from '@solana/web3.js';
import { createHash } from 'crypto';
import { Vm, AccountState, VmInstruction, buildInstruction, instructionFor, ProgramSpec } from './vm';
import { encodeTokenAccount, encodeMint } from './token';
import { pda, ata } from './pda';
import { buildArbProgram, ARB_PROGRAM, ARB_LAYOUTS } from '../programs/flashloan_rfq_arb';
import { buildMmProgram, MM_PROGRAM, MM_LAYOUTS } from '../programs/fixed_market_maker';
import {
  PROGRAMS,
  MINTS,
  DECIMALS,
  JUPITER_FLASHLOAN_ADMIN,
  JUPITER_LIQUIDITY_ACCOUNTS,
  SEP,
} from './constants';
import { buildJupiterProgram, encodeFlashloanAdmin, IX_FLASHLOAN_BORROW } from './jupiter';

export function deterministicKeypair(label: string): Keypair {
  const seed = createHash('sha256').update(`flashloan-rfq-arb:${label}`).digest();
  return Keypair.fromSeed(seed);
}

export function emptyAccount(key: string): AccountState {
  return { key, owner: PROGRAMS.system, lamports: 0n, data: Buffer.alloc(0), executable: false };
}

export function fundedAccount(key: string, lamports = 10_000_000_000n): AccountState {
  return { key, owner: PROGRAMS.system, lamports, data: Buffer.alloc(0), executable: false };
}

export function tokenAccount(
  key: string,
  mint: string,
  owner: string,
  amount: bigint,
): AccountState {
  return {
    key,
    owner: PROGRAMS.token,
    lamports: 2_039_280n,
    data: encodeTokenAccount({ mint, owner, amount, state: 1 }),
    executable: false,
  };
}

export function mintAccount(key: string, decimals: number, supply: bigint): AccountState {
  return {
    key,
    owner: PROGRAMS.token,
    lamports: 1_461_600n,
    data: encodeMint({ mintAuthority: null, supply, decimals }),
    executable: false,
  };
}

// ------------------------------------------------------------------------------ actors

export const ARB_ID = ARB_PROGRAM.programId;
export const MM_ID = MM_PROGRAM.programId;

export interface Actors {
  taker: Keypair;
  maker1: Keypair;
  maker2: Keypair;
  arbAdmin: Keypair;
  mmAdmin: Keypair;
  outsider: Keypair;
}

export function actors(): Actors {
  return {
    taker: deterministicKeypair('taker'),
    maker1: deterministicKeypair('maker1'),
    maker2: deterministicKeypair('maker2'),
    arbAdmin: deterministicKeypair('arb-admin'),
    mmAdmin: deterministicKeypair('mm-admin'),
    outsider: deterministicKeypair('outsider'),
  };
}

// ------------------------------------------------------------------------------ world

export interface WorldOptions {
  /** USDC base units flash borrowed (and paid as leg 1 input). */
  borrowAmount: bigint;
  /** SOL base units delivered by leg 1. */
  leg1Output: bigint;
  /** USDC base units delivered by leg 2 (must exceed the loan to be profitable). */
  leg2Output: bigint;
  /** Leg-1 input the maker quotes (defaults to `borrowAmount`; can be skewed for tests). */
  leg1Input?: bigint;
  /** Leg-2 input the maker quotes (defaults to `leg1Output`; can be skewed for tests). */
  leg2Input?: bigint;
  /** RFQ minimum output for leg 1. */
  minOutputAmount?: bigint;
  /** Profit floor passed to `quote_arbitrage`. */
  minProfitAmount?: bigint;
  /** Jupiter Lend flashloan fee in bps, as configured on the admin account. */
  flashloanFeeBps?: number;
  /** Slot offset for quote expiry (>= 1). Negative offsets make quotes expired. */
  quoteExpiryOffset?: number;
  /** Slot offset for the RFQ expiry. */
  rfqExpiryOffset?: number;
  /** Restrict leg 1 to a specific maker (`null` = open). */
  fixedMaker?: 'maker1' | null;
  /** Pubkey stored in the RFQ's `fixed_maker` field (defaults to the `fixedMaker` option). */
  rfqFixedMaker?: 'maker1' | 'maker2';
  /** Inventory the makers actually deposit, overriding the defaults. */
  maker1SolInventory?: bigint;
  maker2UsdcInventory?: bigint;
  /** Taker's starting balances (pre-existing funds must not count as profit). */
  takerUsdcBalance?: bigint;
  takerSolBalance?: bigint;
  /** Skip posting one of the quotes (to test the "quote missing / not for this taker" paths). */
  skipMaker2Quote?: boolean;
  /** Designate a different taker on maker 2's quote. */
  maker2DesignatedTaker?: string;
}

export const DEFAULT_OPTIONS: WorldOptions = {
  borrowAmount: 100_000n * 10n ** 6n, // 100,000 USDC
  leg1Output: 500n * 10n ** 9n, // 500 SOL
  leg2Output: 100_300n * 10n ** 6n, // 100,300 USDC
  minOutputAmount: 490n * 10n ** 9n,
  minProfitAmount: 50n * 10n ** 6n,
  flashloanFeeBps: 0,
  quoteExpiryOffset: 150,
  rfqExpiryOffset: 300,
  fixedMaker: 'maker1',
  maker1SolInventory: 5_000n * 10n ** 9n,
  maker2UsdcInventory: 1_000_000n * 10n ** 6n,
  takerUsdcBalance: 0n,
  takerSolBalance: 0n,
};

export interface World {
  vm: Vm;
  actors: Actors;
  programs: { arb: ProgramSpec; mm: ProgramSpec; jupiter: ProgramSpec };
  keys: {
    arbConfig: string;
    mmConfig: string;
    rfq: string;
    session: string;
    quote1: string;
    quote2: string;
    makerAccount1: string;
    makerAccount2: string;
    maker1UsdcVault: string;
    maker1SolVault: string;
    maker2UsdcVault: string;
    maker2SolVault: string;
    takerUsdc: string;
    takerSol: string;
    maker1Usdc: string;
    maker1Sol: string;
    maker2Usdc: string;
    maker2Sol: string;
    flashloanAdmin: string;
    jupiterVault: string;
  };
  options: WorldOptions;
  /** Assemble the full atomic arbitrage transaction (7-8 instructions). */
  buildPipeline(overrides?: Partial<WorldOptions>): VmInstruction[];
  /** Build just the router of the pipeline without the ComputeBudget prelude. */
  buildCore(overrides?: Partial<WorldOptions>): VmInstruction[];
  depositInventory(maker: 'maker1' | 'maker2', mint: string, amount: bigint): void;
}

export function programAccount(key: string): AccountState {
  return {
    key,
    owner: 'NativeLoader1111111111111111111111111111111',
    lamports: 1n,
    data: Buffer.alloc(0),
    executable: true,
  };
}

export function createVm(): Vm {
  const vm = new Vm();
  vm.mount(buildArbProgram());
  vm.mount(buildMmProgram());
  vm.mount(buildJupiterProgram());
  for (const key of [
    PROGRAMS.system,
    PROGRAMS.token,
    PROGRAMS.associatedToken,
    PROGRAMS.computeBudget,
    PROGRAMS.jupiterLiquidity,
    PROGRAMS.jupiterFlashloan,
    ARB_ID,
    MM_ID,
  ]) {
    vm.setAccount(programAccount(key));
  }
  vm.setAccount(fundedAccount(PROGRAMS.instructionSysvar, 1n));
  vm.noopPrograms.add(PROGRAMS.computeBudget);
  return vm;
}

export function setupWorld(overrides: Partial<WorldOptions> = {}): World {
  const options: WorldOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const vm = createVm();
  const who = actors();
  const arb = buildArbProgram();
  const mm = buildMmProgram();

  // ------------------------------------------------------------------ base accounts
  const usdcMint = mintAccount(MINTS.usdc, DECIMALS.usdc, 10n ** 15n);
  const solMint = mintAccount(MINTS.wsol, DECIMALS.wsol, 10n ** 15n);
  vm.setAccount(usdcMint);
  vm.setAccount(solMint);

  const takerUsdc = ata(MINTS.usdc, who.taker.publicKey.toBase58());
  const takerSol = ata(MINTS.wsol, who.taker.publicKey.toBase58());
  vm.setAccount(tokenAccount(takerUsdc, MINTS.usdc, who.taker.publicKey.toBase58(), options.takerUsdcBalance ?? 0n));
  vm.setAccount(tokenAccount(takerSol, MINTS.wsol, who.taker.publicKey.toBase58(), options.takerSolBalance ?? 0n));

  // Jupiter Lend side: admin account (93 bytes), reserve vault holding the liquidity.
  const flashloanAdmin = JUPITER_FLASHLOAN_ADMIN;
  vm.setAccount({
    key: flashloanAdmin,
    owner: PROGRAMS.jupiterFlashloan,
    lamports: 2_000_000n,
    data: encodeFlashloanAdmin({
      authority: who.arbAdmin.publicKey.toBase58(),
      liquidity_program: PROGRAMS.jupiterLiquidity,
      status: true,
      flashloan_fee_bps: options.flashloanFeeBps ?? 0,
      flashloan_timestamp: 0n,
      is_flashloan_active: false,
      active_flashloan_amount: 0n,
      bump: 255,
    }),
    executable: false,
  });
  vm.setAccount(
    tokenAccount(
      JUPITER_LIQUIDITY_ACCOUNTS.vault,
      MINTS.usdc,
      JUPITER_LIQUIDITY_ACCOUNTS.vault,
      10_000_000n * 10n ** 6n,
    ),
  );
  for (const key of [
    JUPITER_LIQUIDITY_ACCOUNTS.reservesLiquidity,
    JUPITER_LIQUIDITY_ACCOUNTS.borrowPosition,
    JUPITER_LIQUIDITY_ACCOUNTS.rateModel,
    JUPITER_LIQUIDITY_ACCOUNTS.liquidity,
  ]) {
    vm.setAccount(fundedAccount(key, 1_000_000n));
  }
  vm.setAccount(fundedAccount(PROGRAMS.instructionSysvar, 1n));

  // Maker token accounts (their own wallets) + empty PDA vaults.
  const makerKeys: Record<string, { usdc: string; sol: string; account: string }> = {};
  for (const [label, keypair] of [
    ['maker1', who.maker1],
    ['maker2', who.maker2],
  ] as const) {
    const owner = keypair.publicKey.toBase58();
    const usdcAccount = ata(MINTS.usdc, owner);
    const solAccount = ata(MINTS.wsol, owner);
    vm.setAccount(tokenAccount(usdcAccount, MINTS.usdc, owner, 10n ** 15n));
    vm.setAccount(tokenAccount(solAccount, MINTS.wsol, owner, 10n ** 15n));
    vm.setAccount(fundedAccount(owner, 100n * 10n ** 9n));
    const makerPda = pda.maker(MM_ID, owner);
    vm.setAccount(emptyAccount(makerPda.address));
    const usdcVaultAuthority = pda.vaultAuthority(MM_ID, owner, MINTS.usdc);
    const solVaultAuthority = pda.vaultAuthority(MM_ID, owner, MINTS.wsol);
    vm.setAccount(emptyAccount(usdcVaultAuthority.address));
    vm.setAccount(emptyAccount(solVaultAuthority.address));
    const usdcVault = ata(MINTS.usdc, usdcVaultAuthority.address);
    const solVault = ata(MINTS.wsol, solVaultAuthority.address);
    vm.setAccount(emptyAccount(usdcVault));
    vm.setAccount(emptyAccount(solVault));
    makerKeys[label] = { usdc: usdcAccount, sol: solAccount, account: makerPda.address };
  }

  // PDAs for our programs.
  const arbAdminKey = who.arbAdmin.publicKey.toBase58();
  const mmAdminKey = who.mmAdmin.publicKey.toBase58();
  const arbConfig = pda.config(ARB_ID);
  const mmConfig = pda.mmConfig(MM_ID);
  vm.setAccount(emptyAccount(arbConfig.address));
  vm.setAccount(emptyAccount(mmConfig.address));
  for (const key of [arbAdminKey, mmAdminKey, who.taker.publicKey.toBase58(), who.outsider.publicKey.toBase58()]) {
    vm.setAccount(fundedAccount(key, 100n * 10n ** 9n));
  }

  // ------------------------------------------------------------------ program setup
  const signersFor = (keypair: Keypair) => ({ [keypair.publicKey.toBase58()]: keypair });

  vm.execute([
    instructionFor(
      arb,
      'initialize_config',
      { admin: vm.account(arbAdminKey), config: vm.account(arbConfig.address), system_program: vm.account(PROGRAMS.system) },
      {
        mm_program: MM_ID,
        flashloan_program: PROGRAMS.jupiterFlashloan,
        liquidity_program: PROGRAMS.jupiterLiquidity,
        borrow_mint: MINTS.usdc,
        intermediate_mint: MINTS.wsol,
        max_flashloan_fee_bps: 100,
        min_profit_amount: 10n * 10n ** 6n,
        max_intermediate_dust: 1_000n,
      },
    ),
  ]);
  vm.execute([
    instructionFor(
      mm,
      'initialize_config',
      { authority: vm.account(mmAdminKey), config: vm.account(mmConfig.address), system_program: vm.account(PROGRAMS.system) },
      { arb_program: ARB_ID },
    ),
  ]);

  const makers = [
    { label: 'maker1' as const, keypair: who.maker1 },
    { label: 'maker2' as const, keypair: who.maker2 },
  ];
  for (const { label, keypair } of makers) {
    const owner = keypair.publicKey.toBase58();
    vm.execute([
      instructionFor(mm, 'register_maker', {
        maker: vm.account(owner),
        mm_config: vm.account(mmConfig.address),
        maker_account: vm.account(makerKeys[label].account),
        system_program: vm.account(PROGRAMS.system),
      }),
    ]);
    for (const mint of [MINTS.usdc, MINTS.wsol]) {
      const authority = pda.vaultAuthority(MM_ID, owner, mint);
      vm.execute([
        instructionFor(mm, 'init_vault', {
          maker: vm.account(owner),
          maker_account: vm.account(makerKeys[label].account),
          mint: vm.account(mint),
          vault_authority: vm.account(authority.address),
          vault: vm.account(ata(mint, authority.address)),
          token_program: vm.account(PROGRAMS.token),
          associated_token_program: vm.account(PROGRAMS.associatedToken),
          system_program: vm.account(PROGRAMS.system),
        }),
      ]);
    }
  }
  void signersFor;

  const world: World = {
    vm,
    actors: who,
    programs: { arb, mm, jupiter: undefined as unknown as ProgramSpec },
    keys: {
      arbConfig: arbConfig.address,
      mmConfig: mmConfig.address,
      rfq: pda.rfq(ARB_ID, who.taker.publicKey.toBase58(), 1n).address,
      session: '',
      quote1: pda.quote(MM_ID, pda.rfq(ARB_ID, who.taker.publicKey.toBase58(), 1n).address, who.maker1.publicKey.toBase58()).address,
      quote2: pda.quote(MM_ID, pda.rfq(ARB_ID, who.taker.publicKey.toBase58(), 1n).address, who.maker2.publicKey.toBase58()).address,
      makerAccount1: makerKeys.maker1.account,
      makerAccount2: makerKeys.maker2.account,
      maker1UsdcVault: ata(MINTS.usdc, pda.vaultAuthority(MM_ID, who.maker1.publicKey.toBase58(), MINTS.usdc).address),
      maker1SolVault: ata(MINTS.wsol, pda.vaultAuthority(MM_ID, who.maker1.publicKey.toBase58(), MINTS.wsol).address),
      maker2UsdcVault: ata(MINTS.usdc, pda.vaultAuthority(MM_ID, who.maker2.publicKey.toBase58(), MINTS.usdc).address),
      maker2SolVault: ata(MINTS.wsol, pda.vaultAuthority(MM_ID, who.maker2.publicKey.toBase58(), MINTS.wsol).address),
      takerUsdc,
      takerSol,
      maker1Usdc: makerKeys.maker1.usdc,
      maker1Sol: makerKeys.maker1.sol,
      maker2Usdc: makerKeys.maker2.usdc,
      maker2Sol: makerKeys.maker2.sol,
      flashloanAdmin,
      jupiterVault: JUPITER_LIQUIDITY_ACCOUNTS.vault,
    },
    options,
    buildPipeline: (override) => buildPipeline(world, override),
    buildCore: (override) => buildCore(world, override),
    depositInventory: (maker, mint, amount) => {
      const keypair = maker === 'maker1' ? who.maker1 : who.maker2;
      const owner = keypair.publicKey.toBase58();
      const authority = pda.vaultAuthority(MM_ID, owner, mint);
      const source = mint === MINTS.usdc ? makerKeys[maker].usdc : makerKeys[maker].sol;
      vm.execute([
        instructionFor(mm, 'deposit_inventory', {
          maker: vm.account(owner),
          maker_account: vm.account(makerKeys[maker].account),
          maker_token_account: vm.account(source),
          vault: vm.account(ata(mint, authority.address)),
          vault_authority: vm.account(authority.address),
          token_program: vm.account(PROGRAMS.token),
        }, { amount }),
      ]);
    },
  };
  world.keys.session = pda.session(ARB_ID, world.keys.rfq).address;
  vm.setAccount(emptyAccount(world.keys.rfq));
  vm.setAccount(emptyAccount(world.keys.session));
  vm.setAccount(emptyAccount(world.keys.quote1));
  vm.setAccount(emptyAccount(world.keys.quote2));

  return world;
}

/** Fund inventories, create the RFQ and post both maker quotes. */
export function prepareRfq(world: World, override: Partial<WorldOptions> = {}): World {
  const options = { ...world.options, ...override };
  const { vm, actors: who } = world;
  const mm = world.programs.mm;
  const arb = world.programs.arb;
  const taker = who.taker.publicKey.toBase58();
  const maker1 = who.maker1.publicKey.toBase58();
  const maker2 = who.maker2.publicKey.toBase58();
  const expiry = vm.clock.slot + BigInt(options.quoteExpiryOffset ?? 150);

  world.depositInventory('maker1', MINTS.wsol, options.maker1SolInventory ?? 0n);
  world.depositInventory('maker2', MINTS.usdc, options.maker2UsdcInventory ?? 0n);

  // RFQ
  vm.execute([
    instructionFor(
      arb,
      'create_rfq',
      {
        taker: vm.account(taker),
        config: vm.account(world.keys.arbConfig),
        rfq: vm.account(world.keys.rfq),
        system_program: vm.account(PROGRAMS.system),
      },
      {
        input_mint: MINTS.usdc,
        output_mint: MINTS.wsol,
        exact_input_amount: options.borrowAmount,
        min_output_amount: options.minOutputAmount ?? 0n,
        expiry_slot: vm.clock.slot + BigInt(options.rfqExpiryOffset ?? 300),
        fixed_maker:
          options.rfqFixedMaker === 'maker2'
            ? maker2
            : options.fixedMaker === 'maker1'
              ? maker1
              : PROGRAMS.system,
        nonce: 1n,
      },
    ),
  ]);

  // Leg 1 quote: maker 1 sells SOL for USDC.
  const quote1Authority = pda.vaultAuthority(MM_ID, maker1, MINTS.wsol);
  vm.execute([
    instructionFor(
      mm,
      'post_quote',
      {
        maker: vm.account(maker1),
        mm_config: vm.account(world.keys.mmConfig),
        maker_account: vm.account(world.keys.makerAccount1),
        quote: vm.account(world.keys.quote1),
        maker_output_vault: vm.account(ata(MINTS.wsol, quote1Authority.address)),
        maker_output_vault_authority: vm.account(quote1Authority.address),
        system_program: vm.account(PROGRAMS.system),
      },
      {
        rfq: world.keys.rfq,
        designated_taker: taker,
        input_mint: MINTS.usdc,
        output_mint: MINTS.wsol,
        input_amount: options.leg1Input ?? options.borrowAmount,
        output_amount: options.leg1Output,
        expiry_slot: expiry,
      },
    ),
  ]);

  if (!options.skipMaker2Quote) {
    const quote2Authority = pda.vaultAuthority(MM_ID, maker2, MINTS.usdc);
    vm.execute([
      instructionFor(
        mm,
        'post_quote',
        {
          maker: vm.account(maker2),
          mm_config: vm.account(world.keys.mmConfig),
          maker_account: vm.account(world.keys.makerAccount2),
          quote: vm.account(world.keys.quote2),
          maker_output_vault: vm.account(ata(MINTS.usdc, quote2Authority.address)),
          maker_output_vault_authority: vm.account(quote2Authority.address),
          system_program: vm.account(PROGRAMS.system),
        },
        {
          rfq: world.keys.rfq,
          designated_taker: options.maker2DesignatedTaker ?? taker,
          input_mint: MINTS.wsol,
          output_mint: MINTS.usdc,
          input_amount: options.leg2Input ?? options.leg1Output,
          output_amount: options.leg2Output,
          expiry_slot: expiry,
        },
      ),
    ]);
  }

  return world;
}

// ------------------------------------------------------------------------------ pipeline

export function jupiterProgram(): ProgramSpec {
  return buildJupiterProgram();
}

export function jupiterBorrowInstruction(
  world: World,
  borrowAmount: bigint,
): VmInstruction {
  const vm = world.vm;
  const jupiter = jupiterProgram();
  const taker = world.actors.taker.publicKey.toBase58();
  return buildInstruction(
    vm,
    jupiter,
    'flashloan_borrow',
    {
      signer: vm.account(taker),
      flashloan_admin: vm.account(world.keys.flashloanAdmin),
      signer_borrow_token_account: vm.account(world.keys.takerUsdc),
      mint: vm.account(MINTS.usdc),
      flashloan_token_reserves_liquidity: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.reservesLiquidity),
      flashloan_borrow_position_on_liquidity: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.borrowPosition),
      rate_model: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.rateModel),
      vault: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.vault),
      liquidity: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.liquidity),
      liquidity_program: vm.account(PROGRAMS.jupiterLiquidity),
      token_program: vm.account(PROGRAMS.token),
      associated_token_program: vm.account(PROGRAMS.associatedToken),
      system_program: vm.account(PROGRAMS.system),
      instruction_sysvar: vm.account(PROGRAMS.instructionSysvar),
    },
    { amount: borrowAmount },
    {},
    'jupiter_lend.flashloan_borrow',
  );
}

export function jupiterPaybackInstruction(world: World, borrowAmount: bigint): VmInstruction {
  const vm = world.vm;
  const jupiter = jupiterProgram();
  const taker = world.actors.taker.publicKey.toBase58();
  return buildInstruction(
    vm,
    jupiter,
    'flashloan_payback',
    {
      signer: vm.account(taker),
      flashloan_admin: vm.account(world.keys.flashloanAdmin),
      signer_borrow_token_account: vm.account(world.keys.takerUsdc),
      mint: vm.account(MINTS.usdc),
      flashloan_token_reserves_liquidity: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.reservesLiquidity),
      flashloan_borrow_position_on_liquidity: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.borrowPosition),
      rate_model: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.rateModel),
      vault: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.vault),
      liquidity: vm.account(JUPITER_LIQUIDITY_ACCOUNTS.liquidity),
      liquidity_program: vm.account(PROGRAMS.jupiterLiquidity),
      token_program: vm.account(PROGRAMS.token),
      associated_token_program: vm.account(PROGRAMS.associatedToken),
      system_program: vm.account(PROGRAMS.system),
      instruction_sysvar: vm.account(PROGRAMS.instructionSysvar),
    },
    { amount: borrowAmount },
    {},
    'jupiter_lend.flashloan_payback',
  );
}

export function computeBudgetInstructions(): VmInstruction[] {
  const limit = Buffer.alloc(5);
  limit.writeUInt8(2, 0);
  limit.writeUInt32LE(500_000, 1);
  const price = Buffer.alloc(9);
  price.writeUInt8(3, 0);
  price.writeBigUInt64LE(100_000n, 1);
  return [
    {
      programId: PROGRAMS.computeBudget,
      accounts: [],
      data: limit,
      label: 'ComputeBudget.setComputeUnitLimit(500000)',
    },
    {
      programId: PROGRAMS.computeBudget,
      accounts: [],
      data: price,
      label: 'ComputeBudget.setComputeUnitPrice(100000)',
    },
  ];
}

/**
 * The core pipeline (without the compute-budget prelude):
 *
 * ```text
 * jupiter.flashloan_borrow
 * arb.quote_arbitrage
 * arb.fill_rfq_leg(1)
 * arb.fill_rfq_leg(2)
 * arb.settle_arbitrage
 * jupiter.flashloan_payback
 * ```
 */
export function buildCore(world: World, override: Partial<WorldOptions> = {}): VmInstruction[] {
  const options = { ...world.options, ...override };
  const { vm, actors: who } = world;
  const arb = world.programs.arb;
  const taker = who.taker.publicKey.toBase58();
  const maker1 = who.maker1.publicKey.toBase58();
  const maker2 = who.maker2.publicKey.toBase58();

  const quote1Authority = pda.vaultAuthority(MM_ID, maker1, MINTS.wsol);
  const quote2Authority = pda.vaultAuthority(MM_ID, maker2, MINTS.usdc);

  const borrow = options.borrowAmount;
  return [
    jupiterBorrowInstruction(world, borrow),
    instructionFor(
      arb,
      'quote_arbitrage',
      {
        config: vm.account(world.keys.arbConfig),
        rfq: vm.account(world.keys.rfq),
        taker: vm.account(taker),
        session: vm.account(world.keys.session),
        borrow_ata: vm.account(world.keys.takerUsdc),
        intermediate_ata: vm.account(world.keys.takerSol),
        quote1: vm.account(world.keys.quote1),
        quote2: vm.account(world.keys.quote2),
        quote1_output_vault: vm.account(world.keys.maker1SolVault),
        quote2_output_vault: vm.account(world.keys.maker2UsdcVault),
        flashloan_admin: vm.account(world.keys.flashloanAdmin),
        instruction_sysvar: vm.account(PROGRAMS.instructionSysvar),
        system_program: vm.account(PROGRAMS.system),
      },
      { borrow_amount: borrow, min_profit_amount: options.minProfitAmount ?? 0n },
      {},
      'flashloan_rfq_arb.quote_arbitrage',
    ),
    instructionFor(
      arb,
      'fill_rfq_leg',
      {
        session: vm.account(world.keys.session),
        taker: vm.account(taker),
        quote: vm.account(world.keys.quote1),
        maker_account: vm.account(world.keys.makerAccount1),
        mm_config: vm.account(world.keys.mmConfig),
        taker_input_account: vm.account(world.keys.takerUsdc),
        taker_output_account: vm.account(world.keys.takerSol),
        maker_input_vault: vm.account(world.keys.maker1UsdcVault),
        maker_output_vault: vm.account(world.keys.maker1SolVault),
        maker_input_vault_authority: vm.account(pda.vaultAuthority(MM_ID, maker1, MINTS.usdc).address),
        maker_output_vault_authority: vm.account(quote1Authority.address),
        token_program: vm.account(PROGRAMS.token),
        mm_program: vm.account(MM_ID),
      },
      { leg: 1 },
      {},
      'flashloan_rfq_arb.fill_rfq_leg(1)',
    ),
    instructionFor(
      arb,
      'fill_rfq_leg',
      {
        session: vm.account(world.keys.session),
        taker: vm.account(taker),
        quote: vm.account(world.keys.quote2),
        maker_account: vm.account(world.keys.makerAccount2),
        mm_config: vm.account(world.keys.mmConfig),
        taker_input_account: vm.account(world.keys.takerSol),
        taker_output_account: vm.account(world.keys.takerUsdc),
        maker_input_vault: vm.account(world.keys.maker2SolVault),
        maker_output_vault: vm.account(world.keys.maker2UsdcVault),
        maker_input_vault_authority: vm.account(pda.vaultAuthority(MM_ID, maker2, MINTS.wsol).address),
        maker_output_vault_authority: vm.account(quote2Authority.address),
        token_program: vm.account(PROGRAMS.token),
        mm_program: vm.account(MM_ID),
      },
      { leg: 2 },
      {},
      'flashloan_rfq_arb.fill_rfq_leg(2)',
    ),
    instructionFor(
      arb,
      'settle_arbitrage',
      {
        config: vm.account(world.keys.arbConfig),
        rfq: vm.account(world.keys.rfq),
        taker: vm.account(taker),
        session: vm.account(world.keys.session),
        borrow_ata: vm.account(world.keys.takerUsdc),
        intermediate_ata: vm.account(world.keys.takerSol),
      },
      {},
      {},
      'flashloan_rfq_arb.settle_arbitrage',
    ),
    jupiterPaybackInstruction(world, borrow),
  ];
}

export function buildPipeline(world: World, override: Partial<WorldOptions> = {}): VmInstruction[] {
  return [...computeBudgetInstructions(), ...buildCore(world, override)];
}

export { IX_FLASHLOAN_BORROW, ARB_LAYOUTS, MM_LAYOUTS, SEP };
