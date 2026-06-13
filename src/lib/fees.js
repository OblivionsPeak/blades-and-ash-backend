// Pure fee math for no-show / late-cancellation charges. Kept dependency-free
// so it's unit-testable and the policy lives in exactly one place.
//
// Policy (mirrors the cancellation copy shown at booking):
//   no_show     → 100% of the service total
//   late_cancel → 50% of the service total
//
// Anything already paid online (deposit or prepayment) counts toward the fee,
// so the chargeable amount is the fee minus what's already been collected.

const FEE_RATES = {
  no_show: 1.0,
  late_cancel: 0.5,
};

export function isValidFeeType(feeType) {
  return Object.prototype.hasOwnProperty.call(FEE_RATES, feeType);
}

/**
 * @param {object} args
 * @param {'no_show'|'late_cancel'} args.feeType
 * @param {number} args.totalCents      service total
 * @param {number} args.amountPaidCents already collected online
 * @param {number} [args.overrideCents] explicit fee amount (admin override);
 *                                      when provided it replaces the policy %
 * @returns {{ feeCents: number, chargeableCents: number }}
 *   feeCents        — the policy (or overridden) fee owed
 *   chargeableCents — what to actually charge now (fee minus already paid),
 *                     never negative
 */
export function computeFee({ feeType, totalCents, amountPaidCents = 0, overrideCents }) {
  const total = Math.max(0, Math.round(totalCents || 0));
  const paid = Math.max(0, Math.round(amountPaidCents || 0));

  let feeCents;
  if (overrideCents != null) {
    feeCents = Math.max(0, Math.round(overrideCents));
  } else {
    const rate = FEE_RATES[feeType] ?? 0;
    feeCents = Math.round(total * rate);
  }

  const chargeableCents = Math.max(0, feeCents - paid);
  return { feeCents, chargeableCents };
}
