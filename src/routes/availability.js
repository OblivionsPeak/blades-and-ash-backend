import { Router } from 'express';
import { DateTime } from 'luxon';
import { supabase } from '../supabase.js';

const router = Router();

// The salon's physical timezone. staff_availability start_time/end_time are
// stored as bare wall-clock times ("09:00", "17:00") with no zone; they mean
// 9am–5pm *in Clarksville, TN* (Central). We resolve them against this zone so
// DST is handled correctly (CDT in summer, CST in winter).
const SALON_TZ = process.env.SALON_TZ || 'America/Chicago';

/**
 * GET /api/availability
 * Query params: staff_id, date (YYYY-MM-DD), and either service_id (single)
 *   or service_ids (comma-separated list for a multi-service booking).
 * Slots are sized by the SUMMED duration of all listed services.
 * Returns array of ISO datetime strings (UTC instants) for available 30-min
 * slots. The frontend renders these in the visitor's local zone.
 */
router.get('/', async (req, res) => {
  const { staff_id, service_id, service_ids, date } = req.query;

  // Back-compat: a single service_id is treated as a one-element list.
  const ids = service_ids
    ? service_ids.split(',').map((s) => s.trim()).filter(Boolean)
    : (service_id ? [service_id] : []);

  if (!staff_id || ids.length === 0 || !date) {
    return res.status(400).json({ error: 'staff_id, service_id(s), and date are required query parameters' });
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  }

  // Anchor the requested calendar date at midnight in the SALON timezone. All
  // wall-clock math below is done in this zone so DST is applied correctly.
  const dayInSalonTz = DateTime.fromISO(date, { zone: SALON_TZ }).startOf('day');
  if (!dayInSalonTz.isValid) {
    return res.status(400).json({ error: 'Invalid date provided' });
  }

  // 1. Get the services to find the SUMMED duration_minutes
  const { data: services, error: serviceError } = await supabase
    .from('services')
    .select('id, duration_minutes, active')
    .in('id', ids);

  if (serviceError) {
    return res.status(500).json({ error: serviceError.message });
  }
  if (!services || services.length !== ids.length) {
    return res.status(404).json({ error: 'Service not found' });
  }
  if (services.some((s) => !s.active)) {
    return res.status(400).json({ error: 'Service is not active' });
  }

  const durationMinutes = services.reduce((sum, s) => sum + s.duration_minutes, 0);

  // 2. Get staff_availability for the given day_of_week — the day-of-week of
  // the requested date *in the salon timezone*. Luxon weekday: 1=Mon..7=Sun;
  // staff_availability.day_of_week is 0=Sun..6=Sat, so normalize Sunday(7)->0.
  const dayOfWeek = dayInSalonTz.weekday % 7;

  const { data: availability, error: availError } = await supabase
    .from('staff_availability')
    .select('*')
    .eq('staff_id', staff_id)
    .eq('day_of_week', dayOfWeek)
    .single();

  if (availError || !availability) {
    // Staff not available on this day
    return res.json([]);
  }

  // 3. Get existing appointments for that staff overlapping that salon-local
  // day. We compute the day's UTC bounds from the salon-local midnight..midnight
  // so the window is correct regardless of zone/DST.
  const dayStart = dayInSalonTz.toUTC().toISO();
  const dayEnd = dayInSalonTz.plus({ days: 1 }).toUTC().toISO();

  const { data: existingAppointments, error: apptError } = await supabase
    .from('appointments')
    .select('start_time, end_time')
    .eq('staff_id', staff_id)
    .neq('status', 'cancelled')
    .gte('start_time', dayStart)
    .lt('start_time', dayEnd);

  if (apptError) {
    return res.status(500).json({ error: apptError.message });
  }

  // 4. Generate 30-minute slots from the availability window. start_time and
  // end_time are bare "HH:MM[:SS]" wall-clock times in SALON_TZ on this date.
  const [startHour, startMin] = availability.start_time.split(':').map(Number);
  const [endHour, endMin] = availability.end_time.split(':').map(Number);

  // Availability window as salon-local wall-clock minutes from midnight.
  const availStartMinutes = startHour * 60 + startMin;
  const availEndMinutes = endHour * 60 + endMin;

  const now = Date.now();
  const slots = [];

  // Step through in 30-min increments; the slot must end by the window close.
  for (let slotStart = availStartMinutes; slotStart + durationMinutes <= availEndMinutes; slotStart += 30) {
    const slotEnd = slotStart + durationMinutes;

    // Build the slot's UTC instants from salon-local wall-clock minutes. Adding
    // minutes to the salon-local midnight (in SALON_TZ) yields the correct UTC
    // instant even across a DST boundary.
    const slotStartDt = dayInSalonTz.plus({ minutes: slotStart });
    const slotEndDt = dayInSalonTz.plus({ minutes: slotEnd });

    const proposedStart = slotStartDt.toMillis();
    const proposedEnd = slotEndDt.toMillis();

    // 5. Check overlap with existing appointments.
    const hasOverlap = (existingAppointments || []).some((appt) => {
      const apptStart = new Date(appt.start_time).getTime();
      const apptEnd = new Date(appt.end_time).getTime();
      // Overlap: proposed starts before appt ends AND proposed ends after appt starts
      return proposedStart < apptEnd && proposedEnd > apptStart;
    });

    if (!hasOverlap) {
      // Skip slots in the past
      if (proposedStart > now) {
        slots.push(slotStartDt.toUTC().toISO());
      }
    }
  }

  return res.json(slots);
});

export default router;
