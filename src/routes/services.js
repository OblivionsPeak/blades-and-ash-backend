import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();

// GET / — list all active services (public)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('active', true)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// POST / — create service (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, description, duration_minutes, price_cents, deposit_required, deposit_cents, category } = req.body;

  if (!name || !duration_minutes || price_cents === undefined) {
    return res.status(400).json({ error: 'name, duration_minutes, and price_cents are required' });
  }

  if (!Number.isInteger(price_cents) || price_cents < 0) {
    return res.status(400).json({ error: 'price_cents must be a non-negative integer' });
  }

  if (deposit_cents !== undefined && (!Number.isInteger(deposit_cents) || deposit_cents < 0)) {
    return res.status(400).json({ error: 'deposit_cents must be a non-negative integer' });
  }

  const { data, error } = await supabase
    .from('services')
    .insert({
      name,
      description: description || null,
      duration_minutes,
      price_cents,
      deposit_required: deposit_required || false,
      deposit_cents: deposit_cents || null,
      category: category || null,
      active: true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json(data);
});

// PUT /:id — update service (admin only)
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { name, description, duration_minutes, price_cents, deposit_required, deposit_cents, active, category } = req.body;

  // Validate monetary values if provided
  if (price_cents !== undefined && (!Number.isInteger(price_cents) || price_cents < 0)) {
    return res.status(400).json({ error: 'price_cents must be a non-negative integer' });
  }
  if (deposit_cents !== undefined && deposit_cents !== null && (!Number.isInteger(deposit_cents) || deposit_cents < 0)) {
    return res.status(400).json({ error: 'deposit_cents must be a non-negative integer' });
  }

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (duration_minutes !== undefined) updates.duration_minutes = duration_minutes;
  if (price_cents !== undefined) updates.price_cents = price_cents;
  if (deposit_required !== undefined) updates.deposit_required = deposit_required;
  if (deposit_cents !== undefined) updates.deposit_cents = deposit_cents;
  if (active !== undefined) updates.active = active;
  if (category !== undefined) updates.category = category || null;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  const { data, error } = await supabase
    .from('services')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Service not found' });
  return res.json(data);
});

// DELETE /:id — soft delete: set active = false (admin only)
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('services')
    .update({ active: false })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Service not found' });
  return res.json({ message: 'Service deactivated', service: data });
});

export default router;
