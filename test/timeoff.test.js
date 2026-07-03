import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { isBookingBlocked } from '../src/lib/timeoff.js';

const TZ = 'America/Chicago';
const DATE = '2026-07-15';

// Booking window helper: wall-clock hours on DATE in the salon zone → epoch ms.
function windowMs(startHour, endHour) {
  const day = DateTime.fromISO(DATE, { zone: TZ }).startOf('day');
  return {
    bookingStartMs: day.plus({ hours: startHour }).toMillis(),
    bookingEndMs: day.plus({ hours: endHour }).toMillis(),
  };
}

test('no blocks → not blocked', () => {
  assert.equal(
    isBookingBlocked({ blocks: [], date: DATE, salonTz: TZ, ...windowMs(10, 11) }),
    false
  );
});

test('whole-day block (null times) blocks any booking', () => {
  const blocks = [{ start_time: null, end_time: null }];
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(10, 11) }),
    true
  );
});

test('partial block only blocks overlapping bookings', () => {
  const blocks = [{ start_time: '12:00', end_time: '13:00' }];
  // 3–4pm does not overlap the noon block — must be bookable (the bug this guards).
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(15, 16) }),
    false
  );
  // 12:30–1:30pm overlaps — blocked.
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(12.5, 13.5) }),
    true
  );
});

test('booking that merely touches a block boundary is allowed', () => {
  const blocks = [{ start_time: '12:00', end_time: '13:00' }];
  // 11am–12pm ends exactly when the block starts — allowed.
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(11, 12) }),
    false
  );
  // 1pm–2pm starts exactly when the block ends — allowed.
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(13, 14) }),
    false
  );
});

test('any whole-day block among partials still blocks', () => {
  const blocks = [
    { start_time: '09:00', end_time: '10:00' },
    { start_time: null, end_time: null },
  ];
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(15, 16) }),
    true
  );
});

test('HH:MM:SS-style times are handled', () => {
  const blocks = [{ start_time: '12:00:00', end_time: '13:00:00' }];
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(12, 13) }),
    true
  );
  assert.equal(
    isBookingBlocked({ blocks, date: DATE, salonTz: TZ, ...windowMs(14, 15) }),
    false
  );
});
