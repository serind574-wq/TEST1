# Vendored IDLs

`flashloan.json` is copied verbatim from the official Jupiter Lend repository:
[`jup-ag/jupiter-lend` → `target/idl/flashloan.json`](https://github.com/jup-ag/jupiter-lend/blob/main/target/idl/flashloan.json)
(program `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`, IDL version `0.1.4`).

It is checked into this repo so that the harness can prove, offline, that:

* the instruction discriminators and account lists used by `tests/lib/jupiter.ts` match the
  deployed program's published interface,
* the `FlashloanAdmin` account layout (93 bytes) decoded by the Rust adapter
  (`programs/flashloan-rfq-arb/src/jupiter_lend.rs`) matches the on-chain struct,
* the error codes the model enforces (6000-6013) are the real ones.

`tests/run_encoding_checks.ts` re-derives `sha256("global:<snake_case>")[0..8]` for every
instruction in this file and fails if Jupiter ever changes a layout.
