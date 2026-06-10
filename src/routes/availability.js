import { Router } from 'express';
import { supabase } from '../supabase.js';

const router = Router();

/**
 * GET /api/availability
 * Query params: staff_id, service_id, date (YYYY-MM-DD)
 * Returns array of ISO datetime strings for available 30-min slots
 */
router.get('/', async (req, res) => {
  const { staff_id, service_id, date } = req.query;

  if (!staff_id || !service_id || !date) {
    return res.status(400).json({ error: 'staff_id, service_id, and date are required query parameters' });
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  }

  const parsedDate = new Date(date + 'T00:00:00Z');
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date provided' });
  }

  // 1. Get the service to find duration_minutes
  const { data: service, error: serviceError } = await supabase
    .from('services')
    .select('id, duration_minutes, active')
    .eq('id', service_id)
    .single();

  if (serviceError || !service) {
    return res.status(404).json({ error: 'Service not found' });
  }
  if (!service.active) {
    return res.status(400).json({ error: 'Service is not active' });
  }

  const durationMinutes = service.duration_minutes;

  // 2. Get staff_availability for the given day_of_week
  // JavaScript getUTCDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
  const dayOfWeek = parsedDate.getUTCDay();

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

  // 3. Get existing appointments for that staff on that date (not cancelled)
  const dayStart = date + 'T00:00:00.000Z';
  const dayEnd = date + 'T23:59:59.999Z';

  const { data: existingAppointments, error: apptError } = await supabase
    .from('appointments')
    .select('start_time, end_time')
    .eq('staff_id', staff_id)
    .neq('status', 'cancelled')
    .gte('start_time', dayStart)
    .lte('start_time', dayEnd);

  if (apptError) {
    return res.status(500).json({ error: apptError.message });
  }

  // 4. Generate 30-minute slots from availability window
  // Parse start_time and end_time from "HH:MM:SS" format
  const [startHour, startMin] = availability.start_time.split(':').map(Number);
  const [endHour, endMin] = availability.end_time.split(':').map(Number);

  // Build availability window in minutes from midnight
  const availStartMinutes = startHour * 60 + startMin;
  const availEndMinutes = endHour * 60 + endMin;

  const slots = [];
  // Step through in 30-min increments, but the slot must end by availEnd
  for (let slotStart = availStartMinutes; slotStart + durationMinutes <= availEndMinutes; slotStart += 30) {
    const slotEnd = slotStart + durationMinutes;

    // Build ISO strings for this slot
    const slotStartDate = new Date(date + 'T00:00:00.000Z');
    slotStartDate.setUTCHours(Math.floor(slotStart / 60), slotStart % 60, 0, 0);

    const slotEndDate = new Date(date + 'T00:00:00.000Z');
    slotEndDate.setUTCHours(Math.floor(slotEnd / 60), slotEnd % 60, 0, 0);

    // 5. Check overlap with existing appointments
    const hasOverlap = (existingAppointments || []).some((appt) => {
      const apptStart = new Date(appt.start_time).getTime();
      const apptEnd = new Date(appt.end_time).getTime();
      const proposedStart = slotStartDate.getTime();
      const proposedEnd = slotEndDate.getTime();

      // Overlap condition: proposed starts before appt ends AND proposed ends after appt starts
      return proposedStart < apptEnd && proposedEnd > apptStart;
    });

    if (!hasOverlap) {
      // Skip slots in the past
      if (slotStartDate.getTime() > Date.now()) {
        slots.push(slotStartDate.toISOString());
      }
    }
  }

  return res.json(slots);
});

export default router;
