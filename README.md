# Jupiter Lend flash loan → direct RFQ round trip (on-chain quoted)

Two Anchor programs that answer one question: **can a flash loan be made to trade a token into
another token and back, through direct bilateral RFQs with fixed market makers, where the whole
trade is priced on chain before any capital is used?**

```
                 ┌────────────────────────── one atomic v0 transaction ──────────────────────────┐
 taker  ───────► │ [0] ComputeBudget::SetComputeUnitLimit(500_000)                              │
 (1 signer)      │ [1] ComputeBudget::SetComputeUnitPrice(100_000)                              │
                 │ [2] jupiter_lend::flashloan_borrow(B)        ← top level (CPI is forbidden)   │
                 │ [3] rfq::quote_arbitrage                     ← prices BOTH legs, on chain      │
                 │ [4] rfq::fill_rfq_leg(1)  ──CPI──► mm::settle_quote  (B  → intermediate)      │
                 │ [5] rfq::fill_rfq_leg(2)  ──CPI──► mm::settle_quote  (intermediate → B)       │
                 │ [6] rfq::settle_arbitrage                    ← proves repayment + profit      │
                 │ [7] jupiter_lend::flashloan_payback(B)       ← last instruction, closes loan   │
                 └───────────────────────────────────────────────────────────────────────────────┘
                        makers never sign this transaction - only their quotes, once
```

* `programs/flashloan-rfq-arb` — RFQ lifecycle, the **on-chain pre-quote**, leg execution via CPI,
  and post-trade settlement.
* `programs/fixed-market-maker` — the RFQ venue: maker registry, **PDA-owned inventory vaults**,
  firm signed quotes with expiry + designated taker, and settlement that needs only the taker's
  signature.

---

## 1. What is actually verified in this repository

This environment has **no Rust toolchain** (no `cargo`, `solana`, `anchor`) and no Solana RPC, so
the programs are **not compiled here**. Instead, `tests/` contains a verification harness that
derives its entire view of the on-chain interface *from the Rust sources* and executes the full
pipeline deterministically:

| Verified offline | How |
|---|---|
| Anchor discriminator scheme (`global:` / `account:` / `event:`) | checked against the **official Jupiter Lend IDL** vendored in `fixtures/idl/flashloan.json` |
| Every `#[account]` struct's `pub const LEN` | compared with its Borsh field sum parsed from `state.rs` |
| `FlashloanAdmin` 93-byte layout used by `jupiter_lend.rs` | offsets parsed from the Rust and compared with the published struct |
| Jupiter instruction account indices the RFQ program reads | compared with the IDL account order |
| Every error variant name used by the handlers | checked against the Rust `#[error_code]` enums |
| Real PDAs / associated token accounts / instruction encoding | `@solana/web3.js`, real seeds, real Borsh |
| v0 transaction size | serialised with `@solana/web3.js` and measured against the 1232-byte limit |
| 24 behavioural scenarios (profit, fees, expiry, replay, CPI, rollback…) | deterministic in-memory VM |

```bash
npm install
npm test          # encodings + scenarios + full report
```

**New here? Start with [`docs/RUN_LOCALLY.md`](docs/RUN_LOCALLY.md)** — it walks through both the
offline harness (Node only, ~1 minute) and building/deploying the real programs on a local
validator, with a troubleshooting table.

Building locally and hitting `feature \`edition2024\` is required`? Run
`./scripts/toolchain-check.sh`, then see
[`docs/RUN_LOCALLY.md` § edition2024](docs/RUN_LOCALLY.md#edition2024-is-required). In short:
`anchor build` compiles with the Rust bundled in Solana **platform-tools** (needs ≥ v1.52 for Rust
1.85+), not your rustup toolchain — and this repo ships no `Cargo.lock`, so pin the offending
crates or upgrade the CLI.

Individual suites:

```bash
npm run test:encodings   # interface/layout parity (67 checks)
npm run test:vm          # 24 behavioural scenarios
npm run test:report      # the study report (tables, balances, sizes, event trail)
```

**Not verified here — needs a toolchain and network:** `anchor build && anchor test`. The VM is a
*specification model*: it transcribes the Rust handlers and enforces signer/writable/owner rules,
PDAs, atomicity, the instructions sysvar and stack height — it is not a BPF interpreter and does
not model compute units.

---

## 2. The design, and why it looks like this

### 2.1 Makers must not co-sign the arbitrage transaction

An atomic transaction cannot wait for an off-chain market maker to add a signature. The venue
therefore splits "authorising a price" from "moving the tokens":

1. **`post_quote`** (maker signs, once, ahead of time) writes a `Quote` account containing the
   RFQ it answers, the **designated taker**, the two mints, exact input/output amounts, an expiry
   **slot**, and a `filled` flag.
2. **`settle_quote`** (taker signs) performs the two transfers:
   * taker → maker vault, authorised by the **taker's** signature,
   * maker vault → taker, authorised by the **`["mm_vault", maker, mint]` PDA** — the maker's
     inventory sits in a token account whose authority is the program, so the program can deliver
     without the maker being present.

The maker's safety comes from the quote account, not from its signature at fill time: expiry,
exact amounts, designated taker, one-shot `filled`, and a live inventory re-check.

### 2.2 Quotes are accounts, not instruction arguments

Passing a price as an instruction argument is only a claim. Pricing against **signed, expiring,
owner-checked quote accounts** means `quote_arbitrage` reads state neither the taker nor a
relayer can forge, and the MM program can refuse a second fill without trusting the taker.

### 2.3 The on-chain pre-quote (`quote_arbitrage`)

Runs before any swap and reverts the whole transaction if anything is off. It reads **only chain
state**:

| Input | Source |
|---|---|
| leg 1 / leg 2 price | `Quote` accounts owned by the MM program |
| maker inventory | the makers' PDA-owned token accounts (live balances) |
| flash loan fee + protocol status | Jupiter Lend's `FlashloanAdmin` account (93 bytes, layout pinned) |
| expiry | `Clock` (slots) |
| loan wiring | the instruction sysvar: exactly one borrow **before** us, exactly one payback **and it must be last** |

Then it prices the round trip and requires `leg2_out ≥ borrow + fee + profit_floor`, where the fee
is `ceil(borrow × fee_bps / 10_000)` with `fee_bps` taken from the on-chain admin account.

### 2.4 Round-trip exactness

* leg 1 input **must equal** the borrowed amount (no idle borrowed capital),
* leg 2 input **must equal** leg 1 output (no stranded intermediate token),
* leg 2 output mint **must be** the borrowed mint,
* settlement re-checks that the intermediate balance returned to its pre-loan level
  (`max_intermediate_dust` tolerance).

### 2.5 Settlement measures deltas, not absolutes

The pre-quote runs *after* the loan lands (Jupiter Lend's borrow must be top-level and its payback
must exist later in the transaction), so the taker's token account already holds the principal.
`quote_arbitrage` therefore stores `pre_loan_balance = balance − principal`, and settlement requires

```
balance ≥ pre_loan_balance + required_repayment + min_profit
```

A taker's pre-existing inventory can never be booked as trading profit.

---

## 3. Jupiter Lend compliancy

Verified against the official IDL (`fixtures/idl/flashloan.json`, program v0.1.4, program id
`jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`):

| Fact | Value | Where it is used |
|---|---|---|
| `flashloan_borrow` discriminator | `67134e18f009873f` | `jupiter_lend.rs`, harness |
| `flashloan_payback` discriminator | `d52f998954f35ee8` | `jupiter_lend.rs`, harness |
| accounts per instruction | 14 | pipeline builder |
| `FlashloanAdmin` size | 93 bytes | parsed (manual, offset-pinned) |
| `FlashloanAdmin` fee field | offset 73, `u16` bps | priced into the arbitrage |
| admin PDA | `["flashloan_admin"]` → `ALXWtv2P4GqH1B7Lq731joag52yRBRqmHV4naiXPTYWL` | derived, not hardcoded |
| CPI into borrow | rejected: `FLASHLOAN_CPICALL_NOT_ALLOWED` (6012) | never CPId; modelled in the suite |
| missing payback | `FLASHLOAN_PAYBACK_NOT_FOUND` (6009) | the RFQ program asserts the same structure itself |

Nothing in this repo CPIs into Jupiter Lend. The two flashloan instructions are top-level and the
RFQ instructions sit between them.

---

## 4. Repository layout

```
programs/
  flashloan-rfq-arb/src/
    lib.rs                 instruction entry points + pipeline documentation
    state.rs               ArbConfig / RfqRequest / ArbSession (PDA seeds)
    math.rs                pure round-trip pricing (ceil-div fee, exactness) + unit tests
    jupiter_lend.rs        IDL-pinned adapter: admin layout, discriminators, sysvar introspection
    instructions/
      initialize_config.rs create_rfq.rs  quote_arbitrage.rs  fill_rfq_leg.rs  settle_arbitrage.rs
  fixed-market-maker/src/
    lib.rs  state.rs  errors.rs  events.rs
    instructions/initialize_config.rs  maker.rs  quote.rs  settle_quote.rs
tests/
  lib/rustsrc.ts           parses programs/*/src (layouts, accounts, errors, events, seeds)
  lib/anchor.ts            discriminators + Borsh codec
  lib/vm.ts                deterministic execution model (signers, CPI, sysvar, atomicity)
  lib/world.ts             fixtures: actors, mints, Jupiter admin, makers, quotes, pipeline
  lib/jupiter.ts           Jupiter Lend model driven by the official IDL
  lib/scenarios.ts         the 24-scenario matrix (shared with the report)
  lib/pipeline.ts          real v0 assembly + packet-size measurement
  programs/*.ts            transcriptions of the Rust handlers
  run_encoding_checks.ts  run_vm_tests.ts  run_report.ts
fixtures/idl/flashloan.json official Jupiter Lend IDL (vendored, with attribution)
```

---

## 5. Running against real BPF

```bash
anchor build            # both programs
anchor test             # requires the Jupiter Lend accounts (see Anchor.toml)
```

`Anchor.toml` lists the mainnet accounts to clone for a forked validator. `flashloan_borrow` also
needs the liquidity-layer reserve / borrow-position / rate-model accounts, whose seeds are not in
the published IDL — copy them from a live mainnet borrow transaction. The harness uses documented
stand-ins for exactly those four accounts, and real values for everything else.

---

## 6. Known limitations / next steps

* **Not compiled here.** Expect to fix small things on first `anchor build` (imports, a bump).
* **ALT is mandatory.** 8 instructions / 35 accounts measure **1417 bytes** raw; **490 bytes** with
  a lookup table. Both numbers are measured, not estimated (`npm run test:report`).
* **Fee semantics are modelled** as `ceil(amount × bps / 10_000)` charged at payback. Jupiter Lend
  currently charges 0 bps, so the term is normally zero; the code prices it anyway and caps it with
  `max_flashloan_fee_bps`.
* **Single signer.** The taker signs everything; production would separate a fee-payer/keypair
  policy and consider a Jito bundle for landing.
* **Quote sniping** is prevented by `designated_taker` on the quote, not by an allowlist.
* Ideas worth exploring next: multi-maker competition on one RFQ (n quotes, pick the best in the
  pre-quote), partial fills, and a proptest fuzz of `evaluate_round_trip` around rounding edges.

## 7. License

Apache-2.0.
