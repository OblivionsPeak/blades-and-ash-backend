import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();

// GET / — list all staff and admin profiles (public)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, avatar_url, role, phone')
    .in('role', ['staff', 'admin'])
    .order('full_name');

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// GET /:id/availability — get weekly availability for a staff member (public)
router.get('/:id/availability', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('staff_availability')
    .select('*')
    .eq('staff_id', id)
    .order('day_of_week');

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// PUT /:id/availability — upsert weekly availability (own staff or admin)
router.put('/:id/availability', requireAuth, async (req, res) => {
  const { id } = req.params;
  // Accept either a bare array body or { slots: [...] } — the admin UI posts
  // the array directly.
  const slots = Array.isArray(req.body) ? req.body : req.body.slots;

  // Check permissions: must be own profile or admin
  const userRole = req.user.profile.role;
  const userId = req.user.id;

  if (userId !== id && userRole !== 'admin') {
    return res.status(403).json({ error: 'You can only update your own availability' });
  }

  if (!Array.isArray(slots)) {
    return res.status(400).json({ error: 'slots must be an array of { day_of_week, start_time, end_time }' });
  }

  // Validate each slot. Times must be HH:MM[:SS] wall-clock strings — the
  // availability route parses them numerically, so anything else silently
  // produces NaN math and zero bookable slots for that day.
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
  for (const slot of slots) {
    if (slot.day_of_week === undefined || slot.day_of_week < 0 || slot.day_of_week > 6) {
      return res.status(400).json({ error: 'day_of_week must be between 0 (Sunday) and 6 (Saturday)' });
    }
    if (!timeRe.test(slot.start_time || '') || !timeRe.test(slot.end_time || '')) {
      return res.status(400).json({ error: 'Each slot requires start_time and end_time in HH:MM format' });
    }
    const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    if (toMinutes(slot.start_time) >= toMinutes(slot.end_time)) {
      return res.status(400).json({ error: 'start_time must be before end_time' });
    }
  }

  // Delete all existing availability for this staff member
  const { error: deleteError } = await supabase
    .from('staff_availability')
    .delete()
    .eq('staff_id', id);

  if (deleteError) return res.status(500).json({ error: deleteError.message });

  // Insert new availability if any slots provided
  if (slots.length > 0) {
    const rows = slots.map((slot) => ({
      staff_id: id,
      day_of_week: slot.day_of_week,
      start_time: slot.start_time,
      end_time: slot.end_time,
    }));

    const { data, error: insertError } = await supabase
      .from('staff_availability')
      .insert(rows)
      .select();

    if (insertError) return res.status(500).json({ error: insertError.message });
    return res.json(data);
  }

  return res.json([]);
});

// ──────────────────────────────────────────────
// Time off / blocked dates
// ──────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function canManageStaff(req, id) {
  return req.user.id === id || req.user.profile.role === 'admin';
}

// GET /:id/time-off — list a staff member's blocked date ranges (own or admin)
router.get('/:id/time-off', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!canManageStaff(req, id)) {
    return res.status(403).json({ error: 'You can only view your own time off' });
  }

  const { data, error } = await supabase
    .from('staff_time_off')
    .select('*')
    .eq('staff_id', id)
    .order('start_date');

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// POST /:id/time-off — block a date range (own staff or admin)
router.post('/:id/time-off', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!canManageStaff(req, id)) {
    return res.status(403).json({ error: 'You can only set your own time off' });
  }

  const start_date = typeof req.body.start_date === 'string' ? req.body.start_date.trim() : '';
  const end_date = typeof req.body.end_date === 'string' ? req.body.end_date.trim() : '';
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : null;

  if (!DATE_RE.test(start_date) || !DATE_RE.test(end_date)) {
    return res.status(400).json({ error: 'start_date and end_date are required in YYYY-MM-DD format' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ error: 'end_date must be on or after start_date' });
  }

  const { data, error } = await supabase
    .from('staff_time_off')
    .insert({ staff_id: id, start_date, end_date, reason: reason || null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json(data);
});

// DELETE /:id/time-off/:blockId — remove a blocked range (own staff or admin)
router.delete('/:id/time-off/:blockId', requireAuth, async (req, res) => {
  const { id, blockId } = req.params;
  if (!canManageStaff(req, id)) {
    return res.status(403).json({ error: 'You can only remove your own time off' });
  }

  const { error } = await supabase
    .from('staff_time_off')
    .delete()
    .eq('id', blockId)
    .eq('staff_id', id);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ message: 'Time off removed' });
});

// GET /:id/services — get services offered by this staff member (public)
router.get('/:id/services', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('staff_services')
    .select('service_id, services(*)')
    .eq('staff_id', id);

  if (error) return res.status(500).json({ error: error.message });

  // Return the services directly
  const services = data.map((row) => row.services).filter(Boolean);
  return res.json(services);
});

// POST /:id/services — assign a service to a staff member (admin only)
router.post('/:id/services', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { service_id } = req.body;

  if (!service_id) {
    return res.status(400).json({ error: 'service_id is required' });
  }

  const { data, error } = await supabase
    .from('staff_services')
    .insert({ staff_id: id, service_id })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Service already assigned to this staff member' });
    }
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json(data);
});

// DELETE /:id/services/:service_id — remove service assignment (admin only)
router.delete('/:id/services/:service_id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id, service_id } = req.params;

  const { error } = await supabase
    .from('staff_services')
    .delete()
    .eq('staff_id', id)
    .eq('service_id', service_id);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ message: 'Service assignment removed' });
});

export default router;
