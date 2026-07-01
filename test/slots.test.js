import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { generateSlots } from '../src/lib/slots.js';

const TZ = 'America/Chicago';
// A fixed "now" well before the test day so nothing is filtered as past.
const NOW = DateTime.fromISO('2099-01-01T00:00:00', { zone: TZ }).toMillis();

test('generates 30-min-stepped slots that fit inside the window', () => {
  // 09:00–11:00 window, 60-min service => starts at 9:00, 9:30, 10:00 (10:00+60=11:00 ok).
  const slots = generateSlots({
    date: '2099-06-01',
    salonTz: TZ,
    availStart: '09:00',
    availEnd: '11:00',
    durationMinutes: 60,
    existingAppointments: [],
    nowMs: NOW,
  });
  assert.equal(slots.length, 3);
  // First slot should be 09:00 salon time.
  const first = DateTime.fromISO(slots[0]).setZone(TZ);
  assert.equal(first.hour, 9);
  assert.equal(first.minute, 0);
});

test('a service that does not fit yields no slots', () => {
  const slots = generateSlots({
    date: '2099-06-01', salonTz: TZ, availStart: '09:00', availEnd: '09:30',
    durationMinutes: 60, existingAppointments: [], nowMs: NOW,
  });
  assert.equal(slots.length, 0);
});

test('overlapping appointments remove conflicting slots', () => {
  // Block 09:00–10:00 salon time; a 30-min service over 09:00–11:00 should
  // lose the 09:00 and 09:30 starts but keep 10:00 and 10:30.
  const block = {
    start_time: DateTime.fromISO('2099-06-01T09:00', { zone: TZ }).toUTC().toISO(),
    end_time: DateTime.fromISO('2099-06-01T10:00', { zone: TZ }).toUTC().toISO(),
  };
  const slots = generateSlots({
    date: '2099-06-01', salonTz: TZ, availStart: '09:00', availEnd: '11:00',
    durationMinutes: 30, existingAppointments: [block], nowMs: NOW,
  });
  const hours = slots.map((s) => DateTime.fromISO(s).setZone(TZ).toFormat('HH:mm'));
  assert.deepEqual(hours, ['10:00', '10:30']);
});

test('a partial-day time-off window removes only the overlapping slots', () => {
  // Mirrors how availability.js turns a partial block into a busy window:
  // block 12:00–14:00 on a 09:00–17:00 day, 60-min service. The 11:00 slot ends
  // at 12:00 (ok), 12:00/13:00 starts fall inside the block, 14:00 is free again.
  const partialBlock = {
    start_time: DateTime.fromISO('2099-06-01T12:00', { zone: TZ }).toUTC().toISO(),
    end_time: DateTime.fromISO('2099-06-01T14:00', { zone: TZ }).toUTC().toISO(),
  };
  const slots = generateSlots({
    date: '2099-06-01', salonTz: TZ, availStart: '11:00', availEnd: '15:00',
    durationMinutes: 60, existingAppointments: [partialBlock], nowMs: NOW,
  });
  const hours = slots.map((s) => DateTime.fromISO(s).setZone(TZ).toFormat('HH:mm'));
  assert.deepEqual(hours, ['11:00', '14:00']);
});

test('slots already in the past are dropped', () => {
  // now = 10:00 salon time on the test day => only 10:00+ starts survive.
  const nowMid = DateTime.fromISO('2099-06-01T10:00', { zone: TZ }).toMillis();
  const slots = generateSlots({
    date: '2099-06-01', salonTz: TZ, availStart: '09:00', availEnd: '11:00',
    durationMinutes: 30, existingAppointments: [], nowMs: nowMid,
  });
  const hours = slots.map((s) => DateTime.fromISO(s).setZone(TZ).toFormat('HH:mm'));
  // 10:00 is not strictly > now (equal), so first surviving start is 10:30.
  assert.deepEqual(hours, ['10:30']);
});

test('invalid date returns no slots', () => {
  const slots = generateSlots({
    date: 'not-a-date', salonTz: TZ, availStart: '09:00', availEnd: '17:00',
    durationMinutes: 30, existingAppointments: [], nowMs: NOW,
  });
  assert.deepEqual(slots, []);
});
