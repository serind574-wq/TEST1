# Running this project locally

There are **two completely separate things you can run**, and it is worth being clear about which
one you want before you install anything:

| | Path A — the verification harness | Path B — the actual Anchor programs |
|---|---|---|
| What runs | TypeScript: encodings, 24 scenarios, the study report | Rust programs compiled to BPF, on a real validator |
| Needs | Node 18+ only | Solana CLI + Anchor + Rust (~1.5 GB) |
| Time | ~1 minute | 15–30 minutes (first build is slow) |
| Network | only for `npm install` | `cargo`/`avm`/validator downloads, and mainnet RPC to clone Jupiter Lend |
| Proves | interface parity, economics, guards, packet size | the same logic on a real runtime, real CPIs, real compute |

Start with Path A. It is the part that is fully verified in this repository and it will tell you
within a minute whether anything has drifted.

---

## Path A — offline harness (recommended first run)

### A1. Prerequisites

* **Node.js 18 or newer** (`node --version`; developed on Node 22).
* `git`, and network access for the one-time `npm install`.

No Solana, Rust, or Anchor toolchain is required for this path.

### A2. Install and run

```bash
git clone https://github.com/serind574-wq/TEST1.git
cd TEST1
npm install          # ~10 s, installs @solana/web3.js, @solana/spl-token, ts-node, typescript
npm test             # runs all three suites in sequence
```

Expected output (last lines of each stage):

```
> solana-jupiter-rfq-flashloan@1.0.0 test
> npm run test:encodings && npm run test:vm && npm run test:report

PASS: 67/67 encoding checks passed
PASS: 24/24 scenarios passed
...
REPORT COMPLETE - all scenarios matched and the transaction fits in one packet.
```

Exit code is `0` only when everything matches. You will also see this harmless warning once per
process — ignore it:

```
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
```

### A3. Run the suites individually

```bash
npm run test:encodings   # interface/layout parity against the official Jupiter Lend IDL
npm run test:vm          # 24 behavioural scenarios (profit, fees, expiry, replay, CPI, rollback)
npm run test:report      # the full study report: tables, balances, sizes, event trail
npm run typecheck        # tsc --noEmit
```

`npm run test:report` is the one to read if you are studying the design — it prints the program
surfaces, the real `FlashloanAdmin` byte layout, the PDAs, the instruction table, the measured
transaction size, a live balance delta table, the event trail, and the scenario matrix.

### A4. What you should see in the report (sanity numbers)

If any of these differ, something changed and you should look at the diff, not the marketing:

| Line | Expected |
|---|---|
| `PASS: 67/67 encoding checks passed` | 7 Jupiter instructions + account/event discriminators, layouts, offsets, error names, sizes |
| `PASS: 24/24 scenarios passed` | all guards fire as designed |
| `v0 size with an ALT` | `490 bytes / 1232 (fills: true)` |
| `v0 size without an ALT` | `1417 bytes (fills: false)` |
| `taker USDC ... delta` | `+300` (100,000 → 500 SOL → 100,300 USDC) |
| `Jupiter reserve ... delta` | `0` (loan repaid, vault whole) |
| `session account after settlement` | `closed (rent refunded to the taker)` |
| `RFQ status` / `Jupiter loan flag` | `Filled` / `closed (repaid)` |

### A5. Poking at it (this is the fun part)

Everything is data-driven, so you can study a design change by editing one number:

* **Change the trade** — `tests/lib/world.ts`, `DEFAULT_OPTIONS`
  (`borrowAmount`, `leg1Output`, `leg2Output`, `flashloanFeeBps`, `minProfitAmount`,
  `quoteExpiryOffset`, `maker1SolInventory`, …). Add a case to `tests/lib/scenarios.ts` and it
  automatically appears in both `npm run test:vm` and `npm run test:report`.
* **Change a program guard** — edit `programs/*/src/**/*.rs`, then re-run `npm test`. The harness
  parses the Rust sources (`tests/lib/rustsrc.ts`) for account layouts, error variants, account
  order and events, so a renamed field or reordered account breaks the run loudly instead of
  silently testing the old shape. *This is the main reason the harness is worth keeping.*
* **Change the Jupiter interface** — `fixtures/idl/flashloan.json` is the official IDL, vendored.
  Replace it with a newer revision and `npm run test:encodings` tells you what broke.

---

## Path B — build and run the real programs

> **Read this first.** The Rust in `programs/` was written and reviewed here but **could not be
> compiled in the authoring environment** (no `cargo`, `solana`, or `anchor`). Expect small
> first-build fixes — unused imports, a bump expression, `Cargo.lock` resolution. The logic and
> account wiring are mirrored 1:1 by Path A, so the semantics are pinned; the compile is the
> unknown.

### B1. Install the toolchain

```bash
# 1. Rust
curl https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"

# 2. Solana / Agave CLI (provides solana, solana-test-validator, cargo-build-sbf)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 3. Anchor via avm (the programs target anchor-lang 0.31.1)
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.1
avm use 0.31.1

solana --version && anchor --version    # expect anchor-cli 0.31.1
```

Do **not** pin Rust 1.79.0 (earlier revisions of this guide said to - that advice was wrong, see
[`edition2024`](#edition2024-is-required)). Use Rust **1.85 or newer**, and check what your SBF
toolchain can do before you start:

```bash
./scripts/toolchain-check.sh
```

That prints your host Rust, the Rust bundled in Solana's *platform-tools* (which is what
`anchor build` actually compiles with), any crate in the resolved graph that demands edition 2024,
and whether a `Cargo.lock` exists.

The two toolchains are independent — this trips everybody up:

| Command | Compiler used | Fixed by |
|---|---|---|
| `anchor build` / `cargo build-sbf` | Rust bundled in Solana **platform-tools** | upgrading the Solana CLI |
| `cargo test`, `cargo metadata` | your **rustup** toolchain | `rustup default stable` |

Required minimums (edition 2024 was stabilized in **Rust 1.85**):

| platform-tools | bundled Rust | edition 2024 |
|---|---|---|
| v1.43 – v1.46 | 1.79.0 | ❌ |
| v1.47 – v1.51.1 | 1.84.1 | ❌ |
| **v1.52+** | **1.89.0** | ✅ |

(From the [platform-tools release notes](https://github.com/anza-xyz/platform-tools/releases); each
tag pins a `solana-tools-v*` tag in `anza-xyz/rust`.)

### B2. Wallet setup

```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json   # if you have none
solana config set --url localhost
cat ~/.config/solana/id.json | head -c 20; echo      # must exist: Anchor.toml points here
```

### B3. Build

```bash
anchor build
```

Artifacts you should get:

```
target/deploy/flashloan_rfq_arb.so
target/deploy/fixed_market_maker.so
target/deploy/*-keypair.json
target/idl/flashloan_rfq_arb.json
target/idl/fixed_market_maker.json
target/types/*.ts
```

Check the addresses match `declare_id!` (and therefore `Anchor.toml`):

```bash
solana address -k target/deploy/flashloan_rfq_arb-keypair.json     # GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB
solana address -k target/deploy/fixed_market_maker-keypair.json    # J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf
```

If they differ, either `anchor keys sync` (regenerates `declare_id!` to match) or keep the
committed ids and deploy with `--program-id`.

Rust-side unit tests (pure math + layout assertions, no validator needed):

```bash
cargo test -p flashloan-rfq-arb     # fee rounding, round-trip pricing, admin layout
cargo test                           # whole workspace
```

### B4. `anchor test` — what it does today

`Anchor.toml` contains:

```toml
[scripts]
test = "npm test"
```

so `anchor test` **runs Path A**, not BPF integration tests. That is deliberate: it guarantees the
fast suite runs in CI without a validator, and there is no Mocha/TS integration suite wired to the
compiled programs yet.

To add one later, install `@coral-xyz/anchor` + `mocha` + `chai`, delete that `[scripts]` entry,
and write `tests/*.ts` against `target/idl/*.json`. The account wiring you need is already
documented — `tests/lib/world.ts` shows the exact account order and PDA seeds for every
instruction.

### B5. Running a local validator

**Plain localnet (no Jupiter Lend).** Fine for the `fixed-market-maker` program only:

```bash
solana-test-validator --reset --ledger .anchor/ledger --quiet &
solana config set --url localhost
solana airdrop 100
anchor deploy
solana program show GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB
```

**Forked localnet with Jupiter Lend (needed for the full pipeline).** `Anchor.toml` already lists
the accounts to clone; you can run the validator by hand:

```bash
solana-test-validator --reset --ledger .anchor/ledger \
  --url https://api.mainnet-beta.solana.com \
  --clone jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS \
  --clone ALXWtv2P4GqH1B7Lq731joag52yRBRqmHV4naiXPTYWL \
  --clone jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC \
  --clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --clone So11111111111111111111111111111111111111112
```

Then deploy your programs against it:

```bash
anchor deploy --provider.cluster localhost
# or, without anchor:
solana program deploy target/deploy/fixed_market_maker.so \
  --program-id target/deploy/fixed_market_maker-keypair.json --url localhost
```

**The honest gap.** `flashloan_borrow` also requires four liquidity-layer accounts whose seeds are
**not** in the published IDL: the USDC reserve, the flashloan borrow position, the rate model, and
the reserve vault. The harness uses documented stand-ins for exactly these four
(`tests/lib/constants.ts` → `JUPITER_LIQUIDITY_ACCOUNTS`). On a real forked validator, get the real
addresses from a live mainnet borrow transaction before calling `flashloan_borrow`, e.g.:

```bash
solana confirm -v <a signature that contains flashloan_borrow> --url https://api.mainnet-beta.solana.com
# read the account list of the flashloan_borrow instruction, keys 4, 5, 6, 7
```

Everything else in the pipeline — the RFQ programs, both market makers, the quoting and settlement
flow — needs **nothing** from Jupiter Lend and runs on a bare localnet.

### B6. A localnet walkthrough of the RFQ flow only

This is the part you can run end to end without mainnet at all. Account wiring (orders are from
each `#[derive(Accounts)]` struct):

```text
initialize_config(arb_config)              admin, config["config"], system
initialize_config(mm_config)               authority, config["mm_config"], system
register_maker(maker1), register_maker(maker2)
init_vault(maker1, WSOL), init_vault(maker2, USDC)     -> ATA of ["mm_vault", maker, mint]
deposit_inventory(maker1, WSOL, 5_000 SOL)
deposit_inventory(maker2, USDC, 1_000_000 USDC)
create_rfq(taker, nonce=1)                 -> ["rfq", taker, nonce]
post_quote(maker1): 100_000 USDC in, 500 SOL out, designated_taker = taker
post_quote(maker2): 500 SOL in, 100_300 USDC out, designated_taker = taker
settle_quote(maker1) / settle_quote(maker2)   <- only the TAKER signs
```

Use `tests/lib/world.ts` as the reference for every account in each of those calls, and
`tests/lib/anchor.ts` for the Borsh encoding if you are driving it from a script rather than
Anchor's generated client.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `bigint: Failed to load bindings, pure JS will be used` | Harmless `bigint-buffer` native-module warning. Ignore. |
| `No matching version found for solana-bankrun` | Old lockfile from a previous revision. The current `package.json` has no `solana-bankrun`; run `git pull` and `npm install`. |
| `cannot find module 'ts-node'` / weird `_npx` paths | `node_modules` is missing or half-installed. Run `npm install` in the repo root. **Do not run `npm ci --dry-run`** — npm still clears `node_modules`. |
| `anchor: command not found` | `export PATH="$HOME/.avm/bin:$PATH"` (avm installs into `~/.avm/bin`). |
| `anchor build` fails on the toolchain | Run `./scripts/toolchain-check.sh`. Host builds need Rust >= 1.85 (`rustup default stable`); SBF builds need platform-tools >= v1.52 (upgrade the Solana CLI). **Do not** pin 1.79.0. |
| `feature \`edition2024\` is required` | See [below](#edition2024-is-required). |
| `Error: No such file or directory` for the wallet | Create `~/.config/solana/id.json` (`solana-keygen new`); `Anchor.toml` hard-codes that path. |
| `anchor test` runs TypeScript instead of BPF | Expected: `[scripts] test = "npm test"` in `Anchor.toml`. See B4. |
| `AccountNotFound` / `InvalidAccountData` at `flashloan_borrow` | The four liquidity-layer accounts are not the cloned mainnet ones. See B5. |
| `FLASHLOAN_CPICALL_NOT_ALLOWED` (6012) | You put `flashloan_borrow` behind a CPI. It must be a top-level instruction. |
| `FLASHLOAN_PAYBACK_NOT_FOUND` (6009) | No matching `flashloan_payback` later in the same transaction. |
| Transaction too large | Ship an address lookup table: 35 accounts / 8 instructions measure 1417 B raw vs 490 B with an ALT. |
| Port 8899 already in use | An old validator is running: `pkill -f solana-test-validator`, or use `--ledger .anchor/ledger2`. |

---

## `edition2024` is required

You hit this:

```text
Caused by:
  feature `edition2024` is required
  The package requires the Cargo feature called `edition2024`, but that feature is not stabilized
  in this version of Cargo (1.79.0 (8d3d6ef09 2024-08-15)).
```

### What is actually wrong

Nothing in this repository is broken. Some **transitive dependency** was published with
`edition = "2024"` in its `Cargo.toml`, and edition 2024 was stabilized in **Rust 1.85**. Your
Cargo is `1.79.0`, so it refuses to parse that crate.

Two details explain why this appears out of nowhere:

1. **`anchor build` does not use your Rust.** It shells out to `cargo build-sbf`, which uses the
   compiler baked into Solana's *platform-tools*. Solana CLIs shipping platform-tools
   v1.43 – v1.51.1 bundle Rust 1.79 / 1.84 — both older than 1.85. `rustup update` cannot help;
   only `platform-tools >= v1.52` (Rust 1.89) can.
2. **This repo has no committed `Cargo.lock`.** Every build re-resolves `anchor-lang 0.31.1`'s
   dependency ranges and happily picks up the newest patch releases, so a crate that adopted
   edition 2024 lands in the graph without anything here changing.

Run the diagnostic first — it names the offenders and your toolchain versions:

```bash
./scripts/toolchain-check.sh
```

### Fix A — upgrade the Solana CLI (do this if you want the modern stack)

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"   # installs the current Agave release
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# clear any stale downloaded SBF toolchain, then verify
rm -rf ~/.cache/solana
cargo-build-sbf --version        # want: platform-tools v1.52 or newer
./scripts/toolchain-check.sh
```

If the very new toolchain then trips Anchor 0.31.1 (it is a 2025-vintage release), prefer Fix B.

### Fix B — pin the offending crates (surgical, keeps your current CLI)

```bash
# 1. what demands edition 2024?
cargo metadata --format-version 1 \
  | python3 -c "import json,sys; [print(p['name'], p['version']) for p in json.load(sys.stdin)['packages'] if p.get('edition')=='2024']"

# 2. pin each one back to a release that predates the edition bump, e.g.
cargo update -p <crate-name> --precise <older-version>

# 3. lock it in and commit - without this, the next build re-resolves again
cargo generate-lockfile
git add Cargo.lock && git commit -m "chore: pin dependencies for Rust 1.79 platform-tools"
```

`cargo update -p X --precise Y` needs a concrete `Y`: use `cargo tree -i X` to see why `X` is
present, then check its release history for the last edition-2021 release. Commit the lockfile —
that single file is what stops the problem recurring.

> **Lockfile format gotcha.** Cargo ≥ 1.83 writes `Cargo.lock` **version 4**, and Cargo 1.79 (what
> old platform-tools bundles) refuses to read it:
> `lock file version 4 requires -Z next-lockfile-bump`.
> If you stay on the old toolchain, either generate the lock with that cargo
> (`~/.cache/solana/*/platform-tools/rust/bin/cargo generate-lockfile`), or edit
> `version = 4` → `version = 3` at the top of `Cargo.lock` — v3 is readable by both old and new
> Cargo.

### Fix C — host-side builds only (`cargo test`, `cargo metadata`)

```bash
rustup toolchain install stable && rustup default stable   # Rust >= 1.85
```

This fixes `cargo test` but **will not fix `anchor build`**, because that uses platform-tools.

### What not to do

Do **not** pin `channel = "1.79.0"` under `[toolchain]` in `Anchor.toml` (earlier revisions of this
guide suggested it — that was my mistake and it causes exactly this failure). If you already added
it, delete the line.

## Where to read next

| File | Why |
|---|---|
| `README.md` | the architecture and the design rationale |
| `docs/DESIGN.md` | threat model, ordering constraints, rent/lifetimes, simplifications |
| `programs/flashloan-rfq-arb/src/instructions/quote_arbitrage.rs` | the on-chain pre-quote — the core idea |
| `programs/fixed-market-maker/src/instructions/settle_quote.rs` | why no maker signature is needed |
| `programs/flashloan-rfq-arb/src/jupiter_lend.rs` | the IDL-pinned Jupiter adapter and sysvar introspection |
| `tests/lib/scenarios.ts` | the behavioural contract, in one readable file |
| `tests/run_report.ts` | everything measured, printed |
| `scripts/toolchain-check.sh` | diagnoses this class of build failure: host Rust, platform-tools Rust, edition-2024 crates, lockfile |
