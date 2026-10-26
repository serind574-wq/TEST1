# Design notes, threat model, and trade-offs

This file records *why* the two programs look the way they do, and what an attacker can and cannot
do. It is written to be read alongside `programs/*/src`.

---

## 1. Actor model

| Actor | Signs | Trust assumption |
|---|---|---|
| Taker (arbitrage bot) | the arbitrage transaction, the RFQ | trusted with its own capital only |
| Fixed market maker | `register_maker`, `init_vault`, `deposit_inventory`, `withdraw_inventory`, `post_quote` | trusted to price its own quotes |
| RFQ program | PDA vault transfers during settlement (no, see below) | trusted by the *taker* to enforce its own strategy |
| Market-maker program | vault PDA (`["mm_vault", maker, mint]`) | trusted by the *maker* with its inventory |
| Jupiter Lend | nothing | trustworthy; its fee/status is read from chain |

Neither program is an authority over the other. The arb program can only *consume* quotes; a quote
can only be consumed under the conditions the maker itself signed into it.

---

## 2. Why settlement does not need the maker's signature

The naive design (the one in most RFQ sketches) makes the maker transfer its own tokens, which
means `authority: maker` and therefore a maker signature at fill time. That is impossible in an
atomic arbitrage transaction: the maker is not online inside the taker's transaction.

Two ways out:

1. **Vault owned by a PDA of the settlement program** (chosen). The maker deposits inventory once,
   with its own signature; afterwards the *program* is the token authority and can deliver against
   a quote the maker signed earlier.
2. **Vault owned by the RFQ program's PDA** (i.e. the taker-side program). Also works, but it makes
   the RFQ program the custodian of maker inventory. The maker then has to trust code it does not
   control. Rejected.

Safety of (1) rests entirely on the `Quote` account:

| Guard | Field | Enforced in |
|---|---|---|
| price + direction | `input_mint`, `output_mint`, `input_amount`, `output_amount` | `settle_quote` (exact match against the caller's declared amounts) |
| deadline | `expiry_slot` | `settle_quote` + pre-quote |
| only the intended counterparty | `designated_taker` | `settle_quote` + pre-quote |
| one shot | `filled` | `settle_quote` + pre-quote |
| inventory actually exists | live vault balance | `post_quote` and `settle_quote` |
| which RFQ | `rfq` | pre-quote (the MM program does not need to parse foreign accounts) |

Because the quote is only ever *read* by the RFQ program and *mutated* by the MM program, the RFQ
program cannot forge a quote and the taker cannot replay one.

---

## 3. Attack surface

| Attack | Result |
|---|---|
| Sniping someone else's quote | `QuoteNotForTaker`: only `designated_taker` can settle. |
| Replaying a settled quote | `QuoteAlreadyFilled` (MM program) and `session.leg*_filled` (RFQ program). |
| Filling leg 2 before leg 1 | `LegOutOfOrder`. |
| Skipping the loan and using own funds | Not an attack *on the protocol*: the arb program only requires the pipeline when `enforce_flashloan_pipeline` is on; economics are unchanged. |
| Opening a loan without a payback | Jupiter Lend (`6009`) and the RFQ program (`FlashloanPaybackNotFound`). |
| Running code after the payback | `FlashloanPaybackNotLast`. |
| CPI-ing into the flash loan to hide it | `6012 FLASHLOAN_CPICALL_NOT_ALLOWED`, modelled and tested. |
| Borrowing and *not* trading (griefing the MM) | Costs the taker the full fee and reverts profit checks; no MM inventory moves. |
| Stale fee (Jupiter raises the fee after the quote) | Fee is read from the admin account **at quote time**, in the same transaction. |
| Expired quote / RFQ | slot-based expiry checked in the pre-quote *and* in `settle_quote`. |
| Leaving intermediate dust | `leg2_in == leg1_out` + `max_intermediate_dust` at settlement. |
| Front-running the quote with a different taker | The quote names the taker; `post_quote` is a PDA per `(rfq, maker)`, so a maker cannot publish two competing quotes for one RFQ. |
| Quote for an RFQ that does not exist | The RFQ program cross-checks `quote.rfq == rfq.key()`; a stray quote is simply unusable. |

Residual risks are the usual ones: a buggy maker can quote itself into a loss (bounded by its own
inventory), and a taker can fail to find a second leg (bounded by the fee, currently 0).

---

## 4. Ordering constraints (the awkward part)

Jupiter Lend requires:

* `flashloan_borrow` / `flashloan_payback` to be **top level** (stack height ≤ 1), so no CPI;
* a matching `flashloan_payback` to exist **later in the same transaction** (it introspects the
  instruction sysvar).

That forces the following order for any flash-loan arbitrage on Solana:

```
borrow → (trade instructions) → payback
```

The RFQ pre-quote is placed immediately **after** the borrow, not before it, for two reasons:

1. it can then verify the borrow by introspection (`borrow_index < current_index`), which is what
   makes the "loan ↔ trade wiring" check meaningful;
2. the transaction cannot be assembled with the quote first *and* have the payback be last while
   still keeping Jupiter's own check satisfied — both are satisfiable in either order, but the
   contract of "quote before any capital is *used*" is what matters, and the pre-quote is still
   before the first token movement.

If you prefer the literal "quote is instruction 0" shape, set `enforce_flashloan_pipeline = false`
when initialising the arb config; the economics and the profit gate are unchanged, only the
introspection guarantee is dropped. The trade-off is documented here rather than hidden.

---

## 5. Ledger of state, rent, and lifetimes

| Account | Seeds | Lifetime |
|---|---|---|
| `ArbConfig` | `["config"]` | forever |
| `RfqRequest` | `["rfq", taker, nonce]` | until the taker closes it (a filled RFQ cannot be closed) |
| `ArbSession` | `["session", rfq]` | one transaction: created by the pre-quote, closed by settlement (rent → taker) |
| `MmConfig` | `["mm_config"]` | forever |
| `MakerAccount` | `["maker", maker]` | forever |
| Inventory vault | ATA of `["mm_vault", maker, mint]` | forever |
| `Quote` | `["quote", rfq, maker]` | until filled or revoked (rent → maker) |

Because the session is closed at settlement, a *concurrent* second arbitrage on the same RFQ
collides on the PDA and one of the two transactions fails - which is the desired behaviour.

---

## 6. Numbers used in the tests

| Quantity | Value | Reason |
|---|---|---|
| flash loan | 100,000 USDC | large enough for realistic fee rounding |
| leg 1 | 100,000 USDC → 500 SOL | $200.00/SOL |
| leg 2 | 500 SOL → 100,300 USDC | $200.60/SOL → 300 USDC spread |
| profit floor | 50 USDC (config 10) | forces the pre-quote to compare against both |
| Jupiter fee | 0 bps (and 5 / 100 bps variants) | 0 is today's real value; the others test pricing |
| expiry | slot + 150 (quotes), slot + 300 (RFQ) | Solana slots, not wall clock |

---

## 7. Deliberate simplifications

* The MM program does not deserialize the RFQ account. It treats `rfq` as an opaque PDA seed,
  which keeps the two programs decoupled (the venue could serve several RFQ programs).
* Only SPL Token (not Token-2022) is supported.
* Quotes are all-or-nothing; there are no partial fills.
* The arb program assumes a single borrowed mint per config (a second route needs a second config).
* `settle_quote` is callable by anyone holding the designated taker's signature. Calling it
  directly (bypassing the arb program) is *allowed by design*: it executes exactly the trade the
  maker signed, and the maker's protections do not depend on the arb program at all.
