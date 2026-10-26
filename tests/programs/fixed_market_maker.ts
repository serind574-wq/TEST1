/**
 * Transcription of `programs/fixed-market-maker/src/instructions/*.rs`.
 *
 * Every check in the Rust handler has a counterpart here, in the same order, using the same
 * error variant names (resolved from `errors.rs`). The account constraint attributes
 * (`seeds`, `has_one`, `init`, `close`) are re-applied explicitly because the model does not
 * interpret Anchor attributes.
 */
import { ProgramSpec, buildProgramSpec, Ctx } from '../lib/vm';
import { loadProgram } from '../lib/rustsrc';
import { buildLayouts, AccountLayout } from '../lib/state';
import { pda, ata } from '../lib/pda';
import {
  accountOf,
  fail,
  initAta,
  initProgramAccount,
  requireEq,
  requireKeysEqual,
  requireKeysNotEqual,
  requireSeeds,
  requireTrue,
  tokenAccountOf,
} from '../lib/validation';
import { AccountState } from '../lib/vm';

export const MM_PROGRAM = loadProgram('fixed-market-maker');
const layouts = buildLayouts(MM_PROGRAM);

export const MM_LAYOUTS: Record<string, AccountLayout> = {
  MmConfig: layouts.get('MmConfig')!,
  MakerAccount: layouts.get('MakerAccount')!,
  Quote: layouts.get('Quote')!,
};

const MM_ID = MM_PROGRAM.programId;

function loadConfig(ctx: Ctx): Record<string, unknown> {
  return ctx.vm.loadAccount(ctx, 'config', MM_LAYOUTS.MmConfig);
}

function loadMakerAccount(ctx: Ctx): Record<string, unknown> {
  return ctx.vm.loadAccount(ctx, 'maker_account', MM_LAYOUTS.MakerAccount);
}

function loadQuote(ctx: Ctx): Record<string, unknown> {
  return ctx.vm.loadAccount(ctx, 'quote', MM_LAYOUTS.Quote);
}

function saveQuote(ctx: Ctx, quote: Record<string, unknown>): void {
  ctx.vm.saveAccount(ctx, 'quote', MM_LAYOUTS.Quote, quote);
}

// ---------------------------------------------------------------------------- config

const initializeConfig = (ctx: Ctx): void => {
  const authority = accountOf(ctx, 'authority');
  const arbProgram = String(ctx.args.arb_program);
  requireKeysNotEqual(ctx, arbProgram, '11111111111111111111111111111111', 'InvalidConfig');

  const configPda = pda.mmConfig(MM_ID);
  initProgramAccount(ctx, 'config', MM_LAYOUTS.MmConfig, configPda.address, {
    authority,
    arb_program: arbProgram,
    paused: false,
    bump: configPda.bump,
  });
  ctx.vm.emit(ctx.program, 'ConfigInitialized', MM_PROGRAM.events.get('ConfigInitialized')!, {
    authority,
    arb_program: arbProgram,
  });
};

const setPaused = (ctx: Ctx): void => {
  const config = loadConfig(ctx);
  requireSeeds(ctx, 'config', pda.mmConfig(MM_ID).address);
  requireKeysEqual(ctx, accountOf(ctx, 'authority'), String(config.authority), 'Unauthorized');
  config.paused = Boolean(ctx.args.paused);
  ctx.vm.saveAccount(ctx, 'config', MM_LAYOUTS.MmConfig, config);
  ctx.vm.emit(ctx.program, 'ProtocolPaused', MM_PROGRAM.events.get('ProtocolPaused')!, {
    paused: config.paused,
  });
};

// ---------------------------------------------------------------------------- maker

const registerMaker = (ctx: Ctx): void => {
  const maker = accountOf(ctx, 'maker');
  requireSeeds(ctx, 'mm_config', pda.mmConfig(MM_ID).address);
  const makerPda = pda.maker(MM_ID, maker);
  initProgramAccount(ctx, 'maker_account', MM_LAYOUTS.MakerAccount, makerPda.address, {
    authority: maker,
    active: true,
    quotes_posted: 0n,
    bump: makerPda.bump,
  });
  ctx.vm.emit(ctx.program, 'MakerRegistered', MM_PROGRAM.events.get('MakerRegistered')!, { maker });
};

const initVault = (ctx: Ctx): void => {
  const maker = accountOf(ctx, 'maker');
  const mint = accountOf(ctx, 'mint');
  const makerAccount = loadMakerAccount(ctx);
  requireSeeds(ctx, 'maker_account', pda.maker(MM_ID, maker).address);
  requireKeysEqual(ctx, String(makerAccount.authority), maker, 'Unauthorized');

  const vaultAuthority = pda.vaultAuthority(MM_ID, maker, mint);
  requireSeeds(ctx, 'vault_authority', vaultAuthority.address);
  initAta(ctx, 'vault', ata(mint, vaultAuthority.address), mint, vaultAuthority.address);

  ctx.vm.emit(ctx.program, 'VaultInitialized', MM_PROGRAM.events.get('VaultInitialized')!, {
    maker,
    mint,
    vault: accountOf(ctx, 'vault'),
    vault_authority: vaultAuthority.address,
  });
};

const depositInventory = (ctx: Ctx): void => {
  const maker = accountOf(ctx, 'maker');
  const amount = BigInt(ctx.args.amount as bigint);
  const makerAccount = loadMakerAccount(ctx);
  requireSeeds(ctx, 'maker_account', pda.maker(MM_ID, maker).address);
  requireKeysEqual(ctx, String(makerAccount.authority), maker, 'Unauthorized');

  requireTrue(ctx, amount > 0n, 'InvalidAmount');
  const source = tokenAccountOf(ctx, 'maker_token_account');
  const vault = tokenAccountOf(ctx, 'vault');
  requireKeysEqual(ctx, source.mint, vault.mint, 'TokenMintMismatch');
  requireKeysEqual(ctx, source.owner, maker, 'TokenAuthorityMismatch');
  requireKeysEqual(ctx, vault.owner, accountOf(ctx, 'vault_authority'), 'InvalidVault');
  requireSeeds(ctx, 'vault_authority', pda.vaultAuthority(MM_ID, maker, vault.mint).address);

  ctx.vm.transferTokens(ctx, accountOf(ctx, 'maker_token_account'), accountOf(ctx, 'vault'), maker, amount);

  ctx.vm.emit(ctx.program, 'InventoryChanged', MM_PROGRAM.events.get('InventoryChanged')!, {
    maker,
    mint: vault.mint,
    vault: accountOf(ctx, 'vault'),
    amount,
    balance_after: ctx.vm.tokenAmount(accountOf(ctx, 'vault')),
    deposit: true,
  });
};

const withdrawInventory = (ctx: Ctx): void => {
  const maker = accountOf(ctx, 'maker');
  const amount = BigInt(ctx.args.amount as bigint);
  const makerAccount = loadMakerAccount(ctx);
  requireSeeds(ctx, 'maker_account', pda.maker(MM_ID, maker).address);
  requireKeysEqual(ctx, String(makerAccount.authority), maker, 'Unauthorized');

  requireTrue(ctx, amount > 0n, 'InvalidAmount');
  const vault = tokenAccountOf(ctx, 'vault');
  const destination = tokenAccountOf(ctx, 'maker_token_account');
  requireKeysEqual(ctx, destination.mint, vault.mint, 'TokenMintMismatch');
  requireKeysEqual(ctx, destination.owner, maker, 'TokenAuthorityMismatch');
  requireKeysEqual(ctx, vault.owner, accountOf(ctx, 'vault_authority'), 'InvalidVault');
  requireSeeds(ctx, 'vault_authority', pda.vaultAuthority(MM_ID, maker, vault.mint).address);

  // `new_with_signer`: the vault PDA signs the transfer on behalf of the program.
  ctx.signers.add(accountOf(ctx, 'vault_authority'));
  ctx.vm.transferTokens(ctx, accountOf(ctx, 'vault'), accountOf(ctx, 'maker_token_account'), accountOf(ctx, 'vault_authority'), amount);

  ctx.vm.emit(ctx.program, 'InventoryChanged', MM_PROGRAM.events.get('InventoryChanged')!, {
    maker,
    mint: vault.mint,
    vault: accountOf(ctx, 'vault'),
    amount,
    balance_after: ctx.vm.tokenAmount(accountOf(ctx, 'vault')),
    deposit: false,
  });
};

// ---------------------------------------------------------------------------- quotes

const postQuote = (ctx: Ctx): void => {
  const maker = accountOf(ctx, 'maker');
  const clock = ctx.vm.clock;
  const config = ctx.vm.loadAccount(ctx, 'mm_config', MM_LAYOUTS.MmConfig);
  requireSeeds(ctx, 'mm_config', pda.mmConfig(MM_ID).address);
  requireTrue(ctx, !config.paused, 'Paused');

  const makerAccount = loadMakerAccount(ctx);
  requireSeeds(ctx, 'maker_account', pda.maker(MM_ID, maker).address);
  requireKeysEqual(ctx, String(makerAccount.authority), maker, 'Unauthorized');
  requireTrue(ctx, Boolean(makerAccount.active), 'MakerInactive');

  const rfq = String(ctx.args.rfq);
  const designatedTaker = String(ctx.args.designated_taker);
  const inputMint = String(ctx.args.input_mint);
  const outputMint = String(ctx.args.output_mint);
  const inputAmount = BigInt(ctx.args.input_amount as bigint);
  const outputAmount = BigInt(ctx.args.output_amount as bigint);
  const expirySlot = BigInt(ctx.args.expiry_slot as bigint);

  requireKeysNotEqual(ctx, rfq, '11111111111111111111111111111111', 'InvalidConfig');
  requireKeysNotEqual(ctx, designatedTaker, '11111111111111111111111111111111', 'QuoteNotForTaker');
  requireKeysNotEqual(ctx, inputMint, outputMint, 'SameMint');
  requireTrue(ctx, inputAmount > 0n, 'InvalidAmount');
  requireTrue(ctx, outputAmount > 0n, 'InvalidAmount');
  requireTrue(ctx, expirySlot > clock.slot, 'InvalidExpiry');

  const outputVault = tokenAccountOf(ctx, 'maker_output_vault');
  requireKeysEqual(ctx, outputVault.mint, outputMint, 'TokenMintMismatch');
  const outputVaultAuthority = pda.vaultAuthority(MM_ID, maker, outputMint);
  requireSeeds(ctx, 'maker_output_vault_authority', outputVaultAuthority.address);
  requireKeysEqual(ctx, outputVault.owner, accountOf(ctx, 'maker_output_vault_authority'), 'InvalidVault');
  requireTrue(ctx, outputVault.amount >= outputAmount, 'MakerInventoryInsufficient');

  const quotePda = pda.quote(MM_ID, rfq, maker);
  initProgramAccount(ctx, 'quote', MM_LAYOUTS.Quote, quotePda.address, {
    rfq,
    maker,
    designated_taker: designatedTaker,
    input_mint: inputMint,
    output_mint: outputMint,
    input_amount: inputAmount,
    output_amount: outputAmount,
    expiry_slot: expirySlot,
    created_slot: clock.slot,
    filled: false,
    bump: quotePda.bump,
  });

  makerAccount.quotes_posted = BigInt(makerAccount.quotes_posted as bigint) + 1n;
  ctx.vm.saveAccount(ctx, 'maker_account', MM_LAYOUTS.MakerAccount, makerAccount);

  ctx.vm.emit(ctx.program, 'QuotePosted', MM_PROGRAM.events.get('QuotePosted')!, {
    rfq,
    quote: accountOf(ctx, 'quote'),
    maker,
    designated_taker: designatedTaker,
    input_mint: inputMint,
    output_mint: outputMint,
    input_amount: inputAmount,
    output_amount: outputAmount,
    expiry_slot: expirySlot,
  });
};

const revokeQuote = (ctx: Ctx): void => {
  const maker = accountOf(ctx, 'maker');
  const quote = loadQuote(ctx);
  requireSeeds(ctx, 'quote', pda.quote(MM_ID, String(quote.rfq), maker).address);
  requireTrue(ctx, Boolean(quote.filled) === false, 'QuoteAlreadyFilled');
  ctx.vm.closeAccount(accountOf(ctx, 'quote'), maker);
  ctx.vm.emit(ctx.program, 'QuoteRevoked', MM_PROGRAM.events.get('QuoteRevoked')!, {
    rfq: quote.rfq,
    quote: accountOf(ctx, 'quote'),
    maker,
  });
};

/**
 * Settlement. The maker does not sign: the taker signs the input leg and the vault PDA signs the
 * output leg. Everything the maker pinned at `post_quote` time is enforced here.
 */
const settleQuote = (ctx: Ctx): void => {
  const clock = ctx.vm.clock;
  const config = loadConfig(ctx);
  requireSeeds(ctx, 'config', pda.mmConfig(MM_ID).address);
  requireTrue(ctx, !config.paused, 'Paused');

  const quote = loadQuote(ctx);
  const taker = accountOf(ctx, 'taker');
  requireSeeds(ctx, 'quote', pda.quote(MM_ID, String(quote.rfq), String(quote.maker)).address);
  requireTrue(ctx, Boolean(quote.filled) === false, 'QuoteAlreadyFilled');

  const makerAccount = loadMakerAccount(ctx);
  requireSeeds(ctx, 'maker_account', pda.maker(MM_ID, String(quote.maker)).address);
  requireKeysEqual(ctx, String(makerAccount.authority), String(quote.maker), 'Unauthorized');
  requireTrue(ctx, Boolean(makerAccount.active), 'MakerInactive');

  requireTrue(ctx, clock.slot <= BigInt(quote.expiry_slot as bigint), 'QuoteExpired');
  requireKeysEqual(ctx, taker, String(quote.designated_taker), 'QuoteNotForTaker');

  const amountIn = BigInt(ctx.args.amount_in as bigint);
  const minAmountOut = BigInt(ctx.args.min_amount_out as bigint);
  requireEq(ctx, amountIn, BigInt(quote.input_amount as bigint), 'AmountMismatch');
  requireTrue(ctx, minAmountOut <= BigInt(quote.output_amount as bigint), 'AmountMismatch');

  // Vaults must be the program-owned PDAs of this maker.
  requireSeeds(
    ctx,
    'maker_input_vault_authority',
    pda.vaultAuthority(MM_ID, String(quote.maker), String(quote.input_mint)).address,
  );
  requireSeeds(
    ctx,
    'maker_output_vault_authority',
    pda.vaultAuthority(MM_ID, String(quote.maker), String(quote.output_mint)).address,
  );

  const inputVault = tokenAccountOf(ctx, 'maker_input_vault');
  const outputVault = tokenAccountOf(ctx, 'maker_output_vault');
  requireKeysEqual(ctx, inputVault.owner, accountOf(ctx, 'maker_input_vault_authority'), 'InvalidVault');
  requireKeysEqual(ctx, outputVault.owner, accountOf(ctx, 'maker_output_vault_authority'), 'InvalidVault');
  requireKeysEqual(ctx, inputVault.mint, String(quote.input_mint), 'TokenMintMismatch');
  requireKeysEqual(ctx, outputVault.mint, String(quote.output_mint), 'TokenMintMismatch');
  requireTrue(ctx, outputVault.amount >= BigInt(quote.output_amount as bigint), 'MakerInventoryInsufficient');

  const takerInput = tokenAccountOf(ctx, 'taker_input_account');
  const takerOutput = tokenAccountOf(ctx, 'taker_output_account');
  requireKeysEqual(ctx, takerInput.mint, String(quote.input_mint), 'TokenMintMismatch');
  requireKeysEqual(ctx, takerOutput.mint, String(quote.output_mint), 'TokenMintMismatch');
  requireKeysEqual(ctx, takerInput.owner, taker, 'TokenAuthorityMismatch');
  requireKeysEqual(ctx, takerOutput.owner, taker, 'TokenAuthorityMismatch');

  // Leg A: taker -> maker inventory vault (taker signs).
  ctx.vm.transferTokens(
    ctx,
    accountOf(ctx, 'taker_input_account'),
    accountOf(ctx, 'maker_input_vault'),
    taker,
    amountIn,
  );

  // Leg B: maker inventory vault -> taker (vault PDA signs; no maker signature).
  ctx.signers.add(accountOf(ctx, 'maker_output_vault_authority'));
  ctx.vm.transferTokens(
    ctx,
    accountOf(ctx, 'maker_output_vault'),
    accountOf(ctx, 'taker_output_account'),
    accountOf(ctx, 'maker_output_vault_authority'),
    BigInt(quote.output_amount as bigint),
  );

  quote.filled = true;
  saveQuote(ctx, quote);

  ctx.vm.emit(ctx.program, 'QuoteSettled', MM_PROGRAM.events.get('QuoteSettled')!, {
    rfq: quote.rfq,
    quote: accountOf(ctx, 'quote'),
    maker: quote.maker,
    taker,
    amount_in: amountIn,
    amount_out: BigInt(quote.output_amount as bigint),
    slot: clock.slot,
  });
};

export const MM_HANDLERS = {
  initialize_config: initializeConfig,
  set_paused: setPaused,
  register_maker: registerMaker,
  init_vault: initVault,
  deposit_inventory: depositInventory,
  withdraw_inventory: withdrawInventory,
  post_quote: postQuote,
  revoke_quote: revokeQuote,
  settle_quote: settleQuote,
};

export function buildMmProgram(): ProgramSpec {
  return buildProgramSpec(MM_PROGRAM, MM_HANDLERS);
}

export type { AccountState };
export { fail };
