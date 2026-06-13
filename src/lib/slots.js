import { DateTime } from 'luxon';

/**
 * Generate bookable 30-minute slot start times for one staff member on one day.
 * Pure (no DB) so it can be unit-tested. All wall-clock math is anchored to the
 * salon timezone so DST is handled correctly.
 *
 * @param {object} args
 * @param {string} args.date             requested day, 'YYYY-MM-DD'
 * @param {string} args.salonTz          IANA zone, e.g. 'America/Chicago'
 * @param {string} args.availStart       window open, 'HH:MM' (salon wall clock)
 * @param {string} args.availEnd         window close, 'HH:MM'
 * @param {number} args.durationMinutes  summed service duration
 * @param {Array<{start_time:string,end_time:string}>} args.existingAppointments
 * @param {number} args.nowMs            current epoch ms (past slots are dropped)
 * @returns {string[]} UTC ISO start times for free slots
 */
export function generateSlots({
  date,
  salonTz,
  availStart,
  availEnd,
  durationMinutes,
  existingAppointments = [],
  nowMs,
}) {
  const dayInSalonTz = DateTime.fromISO(date, { zone: salonTz }).startOf('day');
  if (!dayInSalonTz.isValid) return [];

  const [startHour, startMin] = String(availStart).split(':').map(Number);
  const [endHour, endMin] = String(availEnd).split(':').map(Number);
  const availStartMinutes = startHour * 60 + startMin;
  const availEndMinutes = endHour * 60 + endMin;

  const slots = [];
  for (let slotStart = availStartMinutes; slotStart + durationMinutes <= availEndMinutes; slotStart += 30) {
    const slotEnd = slotStart + durationMinutes;
    const slotStartDt = dayInSalonTz.plus({ minutes: slotStart });
    const slotEndDt = dayInSalonTz.plus({ minutes: slotEnd });
    const proposedStart = slotStartDt.toMillis();
    const proposedEnd = slotEndDt.toMillis();

    const hasOverlap = existingAppointments.some((appt) => {
      const apptStart = new Date(appt.start_time).getTime();
      const apptEnd = new Date(appt.end_time).getTime();
      return proposedStart < apptEnd && proposedEnd > apptStart;
    });

    if (!hasOverlap && proposedStart > nowMs) {
      slots.push(slotStartDt.toUTC().toISO());
    }
  }

  return slots;
}
