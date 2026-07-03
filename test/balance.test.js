import test from 'node:test';
import assert from 'node:assert/strict';
import { computeChargeCents } from '../src/lib/balance.js';

test('nothing paid → charges the full total', () => {
  assert.equal(computeChargeCents({ totalCents: 10000 }), 10000);
});

test('partial payment reduces the charge to the balance', () => {
  // The overcharge bug: $100 total, $60 cash recorded → charge $40, not $100.
  assert.equal(computeChargeCents({ totalCents: 10000, amountPaidCents: 6000 }), 4000);
});

test('fully paid → nothing to charge', () => {
  assert.equal(computeChargeCents({ totalCents: 10000, amountPaidCents: 10000 }), 0);
});

test('overpaid never goes negative', () => {
  assert.equal(computeChargeCents({ totalCents: 10000, amountPaidCents: 12000 }), 0);
});

test('legacy deposit caps the charge', () => {
  assert.equal(computeChargeCents({ totalCents: 10000, depositCents: 2500 }), 2500);
});

test('deposit is capped at the remaining balance', () => {
  assert.equal(
    computeChargeCents({ totalCents: 10000, amountPaidCents: 9000, depositCents: 2500 }),
    1000
  );
});

test('missing/null fields are treated as zero', () => {
  assert.equal(computeChargeCents({ totalCents: 5000, amountPaidCents: null, depositCents: null }), 5000);
});
