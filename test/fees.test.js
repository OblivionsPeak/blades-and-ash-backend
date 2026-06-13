import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFee, isValidFeeType } from '../src/lib/fees.js';

test('isValidFeeType accepts known types only', () => {
  assert.equal(isValidFeeType('no_show'), true);
  assert.equal(isValidFeeType('late_cancel'), true);
  assert.equal(isValidFeeType('refund'), false);
  assert.equal(isValidFeeType(undefined), false);
});

test('no_show fee is 100% of total when nothing paid', () => {
  const { feeCents, chargeableCents } = computeFee({ feeType: 'no_show', totalCents: 15000, amountPaidCents: 0 });
  assert.equal(feeCents, 15000);
  assert.equal(chargeableCents, 15000);
});

test('late_cancel fee is 50% of total', () => {
  const { feeCents, chargeableCents } = computeFee({ feeType: 'late_cancel', totalCents: 15000, amountPaidCents: 0 });
  assert.equal(feeCents, 7500);
  assert.equal(chargeableCents, 7500);
});

test('already-paid deposit reduces the chargeable amount', () => {
  // $150 service, $50 deposit already collected, no-show => owe $100 more.
  const { feeCents, chargeableCents } = computeFee({ feeType: 'no_show', totalCents: 15000, amountPaidCents: 5000 });
  assert.equal(feeCents, 15000);
  assert.equal(chargeableCents, 10000);
});

test('chargeable never goes negative when overpaid', () => {
  const { chargeableCents } = computeFee({ feeType: 'late_cancel', totalCents: 10000, amountPaidCents: 9000 });
  // 50% fee = $50, but $90 already paid => nothing to charge.
  assert.equal(chargeableCents, 0);
});

test('override replaces the policy percentage', () => {
  const { feeCents, chargeableCents } = computeFee({ feeType: 'no_show', totalCents: 15000, amountPaidCents: 5000, overrideCents: 8000 });
  assert.equal(feeCents, 8000);
  assert.equal(chargeableCents, 3000);
});

test('rounds fractional cents', () => {
  const { feeCents } = computeFee({ feeType: 'late_cancel', totalCents: 2501, amountPaidCents: 0 });
  assert.equal(feeCents, 1251); // 2501 * 0.5 = 1250.5 -> 1251
});
