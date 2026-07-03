// Pure time-off overlap check for the booking guard. staff_time_off rows with
// no start_time/end_time block the whole day; rows with a time window only
// block bookings that overlap that wall-clock window in the salon timezone.
// Kept DB-free so it's unit-testable and agrees with the slot generator
// (lib/slots.js), which applies the same windows when listing availability.
import { DateTime } from 'luxon';

/**
 * @param {object} args
 * @param {Array<{start_time:string|null,end_time:string|null}>} args.blocks
 *        time-off rows already filtered to the booking's date
 * @param {string} args.date          booking date, 'YYYY-MM-DD' (salon-local)
 * @param {string} args.salonTz       IANA zone, e.g. 'America/Chicago'
 * @param {number} args.bookingStartMs  booking start, epoch ms
 * @param {number} args.bookingEndMs    booking end, epoch ms
 * @returns {boolean} true if the booking is blocked by any row
 */
export function isBookingBlocked({ blocks, date, salonTz, bookingStartMs, bookingEndMs }) {
  if (!blocks || blocks.length === 0) return false;

  const day = DateTime.fromISO(date, { zone: salonTz }).startOf('day');
  if (!day.isValid) return true; // unparseable date — fail closed

  return blocks.some((block) => {
    // Whole-day block (back-compat rows have no time window).
    if (!block.start_time || !block.end_time) return true;

    const [sh, sm] = String(block.start_time).split(':').map(Number);
    const [eh, em] = String(block.end_time).split(':').map(Number);
    const blockStart = day.plus({ hours: sh, minutes: sm }).toMillis();
    const blockEnd = day.plus({ hours: eh, minutes: em }).toMillis();
    return bookingStartMs < blockEnd && bookingEndMs > blockStart;
  });
}
