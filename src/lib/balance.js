// Pure charge-amount math for the customer payment path (create-intent).
// The amount to collect is always the OUTSTANDING BALANCE — the (possibly
// discounted) total minus everything already in the ledger — never the raw
// total, so a partial payment (e.g. cash recorded in person) can't lead to
// an overcharge when the client later pays online.

/**
 * @param {object} args
 * @param {number} args.totalCents       appointment total (after discounts)
 * @param {number} [args.amountPaidCents] already collected (any method)
 * @param {number} [args.depositCents]   legacy fixed deposit; when set, caps
 *                                       the charge (deposit-era bookings)
 * @returns {number} cents to charge now, never negative
 */
export function computeChargeCents({ totalCents, amountPaidCents = 0, depositCents = 0 }) {
  const total = Math.max(0, Math.round(totalCents || 0));
  const paid = Math.max(0, Math.round(amountPaidCents || 0));
  const deposit = Math.max(0, Math.round(depositCents || 0));

  const balance = Math.max(0, total - paid);
  return deposit > 0 ? Math.min(deposit, balance) : balance;
}
