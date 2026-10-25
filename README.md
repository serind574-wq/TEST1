# Solana Flash Loan with Jupiter Lend & Direct Fixed-MM RFQ Arbitrage

A complete, production-grade Solana architecture and study suite demonstrating **atomic flash loans via Jupiter Lend**, **direct bilateral RFQ (Request-for-Quote) settlement with fixed Market Makers (MMs)** without third-party aggregator routing, and **localnet testing using cloned mainnet contracts**.

---

## Table of Contents
1. [Core Concepts & Architecture](#core-concepts--architecture)
   - [Direct RFQ vs Aggregator Routing (No Jupiter RFQ)](#direct-rfq-vs-aggregator-routing-no-jupiter-rfq)
   - [The Fixed Market Maker (MM) Model](#the-fixed-market-maker-mm-model)
   - [Jupiter Lend Direct Flash Loan Constraint (`get_stack_height() == 1`)](#jupiter-lend-direct-flash-loan-constraint)
   - [On-Chain Pre-Quoting Before Flash Loan Borrow](#on-chain-pre-quoting-before-flash-loan-borrow)
2. [End-to-End Atomic Transaction Pipeline](#end-to-end-atomic-transaction-pipeline)
3. [Localnet Testing with Cloned Mainnet Contracts](#localnet-testing-with-cloned-mainnet-contracts)
   - [Cloned Account Fixtures](#cloned-account-fixtures)
   - [Anchor.toml Configuration (`solana-test-validator`)](#anchortoml-configuration-solana-test-validator)
   - [Running Localnet Tests via Bankrun](#running-localnet-tests-via-bankrun)
4. [Program Implementation (Anchor Rust)](#program-implementation-anchor-rust)
   - [`quote_direct_mm_rfq_arbitrage`: Pre-Execution Safety & Quoting](#1-quote_direct_mm_rfq_arbitrage)
   - [`fill_direct_mm_rfq`: Direct Bilateral MM Settlement](#2-fill_direct_mm_rfq)
   - [`settle_direct_mm_arbitrage`: Profit Enforcement & Rent Refund](#3-settle_direct_mm_arbitrage)
5. [Client SDK & Transaction Builder](#client-sdk--transaction-builder)
6. [Test Suite Execution & Results](#test-suite-execution--results)

---

## Core Concepts & Architecture

### Direct RFQ vs Aggregator Routing (No Jupiter RFQ)

Standard retail swaps on Solana route through meta-aggregators like Jupiter Swap or Jupiter RFQ (`order_engine`). However, institutional arbitrage and direct OTC flow operate **directly with Market Makers (MMs)**:
* **Zero Aggregator Fees**: Eliminates third-party protocol take-rates and extra routing hops.
* **Bilateral Counterparty Execution**: Tokens are transferred directly between the Taker's token account and the Fixed Market Maker's token accounts.
* **Guaranteed Zero Slippage**: The Market Maker signs a firm quote payload with exact input/output amounts and a strict expiration timestamp (`expire_at`).

### The Fixed Market Maker (MM) Model

Our program registers and enforces two fixed institutional Market Makers:
* **Fixed MM 1 (`MM Alpha`)**: `AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9`
  * Specialized in Leg 1: supplies Token B (SOL) in exchange for borrowed Token A (USDC).
* **Fixed MM 2 (`MM Beta`)**: `9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu`
  * Specialized in Leg 2: supplies Token A (USDC) in exchange for intermediate Token B (SOL).

---

### Jupiter Lend Direct Flash Loan Constraint

In Jupiter Lend's Flashloan Program (`jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`), the program strictly enforces:
```rust
// programs/flashloan/src/validate.rs
if get_stack_height() > constants::FLASHLOAN_STACK_HEIGHT { // STACK_HEIGHT == 1
    return Err(ErrorCodes::FlashloanCPICallNotAllowed.into());
}
```
* **CPI is Forbidden**: Flash loans cannot be called from another contract via CPI. Both `flashloan_borrow` and `flashloan_payback` must be top-level instructions.
* **Instruction Introspection**: `flashloan_borrow` reads Solana's `SysvarInstructions` and ensures a matching `flashloan_payback` instruction exists later in the transaction with identical accounts and amount.

---

### On-Chain Pre-Quoting Before Flash Loan Borrow

Before taking the flash loan, our program executes an **On-Chain Quote Instruction** (`quote_direct_mm_rfq_arbitrage`) at **Instruction 0**:
1. Checks that the quoting counterparties match the authorized fixed MMs.
2. Mathematically calculates round-trip return:
   $$\text{Final Token A} = \text{Quote}_{\text{MM2}}.\text{output\_amount} + \text{unused}$$
   $$\text{Loan Debt} = \text{Borrow Amount} + \text{Flash Loan Fee}$$
   $$\text{Net Profit} = \text{Final Token A} - \text{Loan Debt}$$
3. Asserts $\text{Net Profit} \ge \text{Min Profit Threshold}$.
4. Verifies $Clock \le \text{expire\_at}$ for both quotes.
5. Inspects `SysvarInstructions` to guarantee the flash loan pipeline order.
6. **Reverts immediately** if unprofitable or expired, saving gas and preventing any loan from opening!

---

## End-to-End Atomic Transaction Pipeline

```
+-----------------------------------------------------------------------------------------+
|                        Atomic Solana Versioned Transaction (v0)                         |
+-----------------------------------------------------------------------------------------+
| [0] ComputeBudget::SetComputeUnitLimit(500,000)                                         |
| [1] ComputeBudget::SetComputeUnitPrice(100,000 µLamports)                               |
+-----------------------------------------------------------------------------------------+
| [2] direct_mm_rfq_flashloan::quote_direct_mm_rfq_arbitrage                               |
|     - Evaluates MM 1 and MM 2 quotes on-chain before borrowing funds                    |
|     - Checks: Clock <= expire_at, Leg 2 In <= Leg 1 Out, Leg 1 In <= Borrow Amount    |
|     - Asserts: Final USDC >= Borrowed USDC + Flash Loan Fee + Min Profit Threshold      |
|     - Inspects SysvarInstructions: confirms borrow & payback exist                      |
|     - Initializes transient ArbitrageSession PDA                                        |
+-----------------------------------------------------------------------------------------+
| [3] jupiter_lend::flashloan_borrow(100,000 USDC)                                        |
|     - Direct top-level invocation (stack_height == 1)                                   |
|     - Transfers 100,000 USDC into user's ATA                                            |
+-----------------------------------------------------------------------------------------+
| [4] direct_mm_rfq_flashloan::fill_direct_mm_rfq (Leg 1: Taker <-> Fixed MM 1)           |
|     - Taker sends 100,000 USDC directly to MM 1                                         |
|     - MM 1 delivers 500 SOL directly to Taker (@ $200.00/SOL)                           |
+-----------------------------------------------------------------------------------------+
| [5] direct_mm_rfq_flashloan::fill_direct_mm_rfq (Leg 2: Taker <-> Fixed MM 2)           |
|     - Taker sends 500 SOL directly to MM 2                                              |
|     - MM 2 delivers 100,300 USDC directly to Taker (@ $200.60/SOL)                      |
|     - Realizes the arbitrage spread (+300 USDC)                                         |
+-----------------------------------------------------------------------------------------+
| [6] direct_mm_rfq_flashloan::settle_direct_mm_arbitrage                                 |
|     - Verifies post-swap USDC ATA balance >= 100,000 USDC + min_profit                  |
|     - Realizes net profit (+300 USDC)                                                   |
|     - Closes transient ArbitrageSession PDA & refunds rent lamports to user             |
+-----------------------------------------------------------------------------------------+
| [7] jupiter_lend::flashloan_payback(100,000 USDC)                                       |
|     - Repays 100,000 USDC back to Jupiter Lend Vault (0% fee)                           |
|     - Atomic transaction completes successfully                                         |
+-----------------------------------------------------------------------------------------+
```

---

## Localnet Testing with Cloned Mainnet Contracts

### Cloned Account Fixtures

Real mainnet contracts and accounts have been cloned into `fixtures/cloned_accounts/`:
1. `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS.json`: Jupiter Lend Flashloan Program
2. `ESoMWjdS6i8pMgc75SN4s1gNotRDtNLox4uCxk6udXqY.json`: Flashloan Executable BPF ProgramData
3. `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC.json`: Jupiter Lend Liquidity Program
4. `J6Ry5yuy4Vp4kNa1PTGASiHJxZ8x4pgRPaJ18SmnqtW5.json`: Liquidity Executable BPF ProgramData
5. `ALXWtv2P4GqH1B7Lq731joag52yRBRqmHV4naiXPTYWL.json`: Jupiter Lend Flashloan Admin PDA
6. `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.json`: USDC Mint
7. `So11111111111111111111111111111111111111112.json`: WSOL Mint

### Anchor.toml Configuration (`solana-test-validator`)

When running with Anchor localnet:
```toml
[test.validator]
url = "https://api.mainnet-beta.solana.com"

[[test.validator.clone]]
address = "jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS"

[[test.validator.clone]]
address = "ESoMWjdS6i8pMgc75SN4s1gNotRDtNLox4uCxk6udXqY"

[[test.validator.clone]]
address = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC"

[[test.validator.clone]]
address = "J6Ry5yuy4Vp4kNa1PTGASiHJxZ8x4pgRPaJ18SmnqtW5"

[[test.validator.clone]]
address = "ALXWtv2P4GqH1B7Lq731joag52yRBRqmHV4naiXPTYWL"

[[test.validator.clone]]
address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

[[test.validator.clone]]
address = "So11111111111111111111111111111111111111112"
```

---

## Test Suite Execution & Results

### Running All Tests

```bash
npm run test:all
```

Outputs:
1. `npm test`: Runs the full 4-case simulation test (profitable arbitrage, unprofitable quote rejection, expired quote rejection, security introspection).
2. `npm run test:localnet`: Boots an in-process localnet Solana SVM using `solana-bankrun`, loads the cloned mainnet contracts and accounts, and executes the complete Flash Loan + Direct MM RFQ transaction.
