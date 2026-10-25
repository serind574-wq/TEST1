/**
 * 1:1 port of `programs/flashloan-rfq-arb/src/math.rs`.
 *
 * Mirrored so the harness can assert *both* that the Rust formulas are what we think they are
 * (by comparing against the hard-coded expectations in the tests) and that the arbitrage
 * economics are what the report claims. All arithmetic is `bigint` (uint64 semantics).
 */
export const BPS_DENOMINATOR = 10_000n;

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  return a / b + (a % b === 0n ? 0n : 1n);
}

export function flashloanFee(borrowAmount: bigint, feeBps: number): bigint {
  return ceilDiv(borrowAmount * BigInt(feeBps), BPS_DENOMINATOR);
}

export function requiredRepayment(borrowAmount: bigint, feeBps: number): bigint {
  return borrowAmount + flashloanFee(borrowAmount, feeBps);
}

export interface RoundTrip {
  leg1Input: bigint;
  leg1Output: bigint;
  leg2Input: bigint;
  leg2Output: bigint;
  flashloanFee: bigint;
  requiredRepayment: bigint;
  netProfit: bigint;
  profitable: boolean;
}

export type MathResult = { ok: true; value: RoundTrip } | { ok: false; error: string };

export function evaluateRoundTrip(
  borrowAmount: bigint,
  feeBps: number,
  leg1In: bigint,
  leg1Out: bigint,
  leg2In: bigint,
  leg2Out: bigint,
): MathResult {
  if (borrowAmount <= 0n) return { ok: false, error: 'InvalidBorrowAmount' };
  if (leg1In !== borrowAmount) return { ok: false, error: 'Leg1InputNotEqualBorrow' };
  if (leg2In !== leg1Out) return { ok: false, error: 'IntermediateAmountMismatch' };

  const fee = flashloanFee(borrowAmount, feeBps);
  const repayment = borrowAmount + fee;
  const profitable = leg2Out >= repayment;
  return {
    ok: true,
    value: {
      leg1Input: leg1In,
      leg1Output: leg1Out,
      leg2Input: leg2In,
      leg2Output: leg2Out,
      flashloanFee: fee,
      requiredRepayment: repayment,
      netProfit: profitable ? leg2Out - repayment : 0n,
      profitable,
    },
  };
}
