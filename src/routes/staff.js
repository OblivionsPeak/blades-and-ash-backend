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

  // Validate each slot
  for (const slot of slots) {
    if (slot.day_of_week === undefined || slot.day_of_week < 0 || slot.day_of_week > 6) {
      return res.status(400).json({ error: 'day_of_week must be between 0 (Sunday) and 6 (Saturday)' });
    }
    if (!slot.start_time || !slot.end_time) {
      return res.status(400).json({ error: 'Each slot requires start_time and end_time' });
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
