//! Pure, integer-only pricing math.
//!
//! Kept free of account access so the exact same functions can be unit tested on the host and
//! mirrored 1:1 by the TypeScript harness (`tests/lib/math.ts`).

use crate::errors::ArbError;
use anchor_lang::prelude::*;

pub const BPS_DENOMINATOR: u64 = 10_000;

/// `ceil(a / b)` for `b > 0`, in u128 so it cannot overflow.
pub fn ceil_div_u128(a: u128, b: u128) -> u128 {
    if b == 0 {
        return 0;
    }
    a / b + u128::from(a % b != 0)
}

/// Jupiter Lend charges `flashloan_fee` in basis points of the borrowed amount. The fee is
/// rounded **up** so the protocol can never be short-changed by a rounding remainder.
pub fn flashloan_fee(borrow_amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = ceil_div_u128(
        (borrow_amount as u128) * (fee_bps as u128),
        BPS_DENOMINATOR as u128,
    );
    u64::try_from(fee).map_err(|_| error!(ArbError::MathOverflow))
}

/// Total amount the taker must hold in the borrowed mint at settlement time.
pub fn required_repayment(borrow_amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = flashloan_fee(borrow_amount, fee_bps)?;
    borrow_amount
        .checked_add(fee)
        .ok_or_else(|| error!(ArbError::MathOverflow))
}

/// Result of pricing a two-leg round trip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoundTrip {
    pub leg1_input: u64,
    pub leg1_output: u64,
    pub leg2_input: u64,
    pub leg2_output: u64,
    pub flashloan_fee: u64,
    pub required_repayment: u64,
    pub net_profit: u64,
    pub profitable: bool,
}

/// Price `borrow_mint -> intermediate_mint -> borrow_mint` against two firm quotes.
///
/// Rejects the shapes that would leak value or leave the loan under-collateralised:
/// * leg 1 must consume the borrowed amount **exactly** (no idle borrowed capital),
/// * leg 2 must consume leg 1's output **exactly** (no intermediate dust),
/// * the round trip must end in the borrowed mint.
pub fn evaluate_round_trip(
    borrow_amount: u64,
    fee_bps: u16,
    leg1_in: u64,
    leg1_out: u64,
    leg2_in: u64,
    leg2_out: u64,
) -> Result<RoundTrip> {
    require!(borrow_amount > 0, ArbError::InvalidBorrowAmount);
    require!(leg1_in == borrow_amount, ArbError::Leg1InputNotEqualBorrow);
    require!(
        leg2_in == leg1_out,
        ArbError::IntermediateAmountMismatch
    );

    let fee = flashloan_fee(borrow_amount, fee_bps)?;
    let repayment = borrow_amount
        .checked_add(fee)
        .ok_or_else(|| error!(ArbError::MathOverflow))?;

    let (net_profit, profitable) = if leg2_out >= repayment {
        (leg2_out - repayment, true)
    } else {
        (0, false)
    };

    Ok(RoundTrip {
        leg1_input: leg1_in,
        leg1_output: leg1_out,
        leg2_input: leg2_in,
        leg2_output: leg2_out,
        flashloan_fee: fee,
        required_repayment: repayment,
        net_profit,
        profitable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_rounds_up() {
        assert_eq!(flashloan_fee(100_000_000_000, 0).unwrap(), 0);
        assert_eq!(flashloan_fee(1, 1).unwrap(), 1); // 0.0001 rounds up to 1 base unit
        assert_eq!(flashloan_fee(10_000, 5).unwrap(), 5);
        assert_eq!(flashloan_fee(10_001, 5).unwrap(), 6);
    }

    #[test]
    fn round_trip_prices_the_spread() {
        let rt = evaluate_round_trip(
            100_000_000_000,
            0,
            100_000_000_000,
            500_000_000_000,
            500_000_000_000,
            100_300_000_000,
        )
        .unwrap();
        assert_eq!(rt.required_repayment, 100_000_000_000);
        assert_eq!(rt.net_profit, 300_000_000);
        assert!(rt.profitable);
    }

    #[test]
    fn round_trip_flags_a_loss() {
        let rt = evaluate_round_trip(
            100_000_000_000,
            0,
            100_000_000_000,
            500_000_000_000,
            500_000_000_000,
            99_850_000_000,
        )
        .unwrap();
        assert_eq!(rt.net_profit, 0);
        assert!(!rt.profitable);
    }

    #[test]
    fn rejects_non_exact_legs() {
        assert!(evaluate_round_trip(100, 0, 99, 1, 1, 100).is_err());
        assert!(evaluate_round_trip(100, 0, 100, 2, 1, 100).is_err());
    }
}
