import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { resolveDiscount, resolveDiscountForServices } from '../lib/discounts.js';

const router = Router();

// Validate a type/value pair. percent → 1..100, fixed → positive cents.
function validateTypeValue(type, value) {
  if (!['percent', 'fixed'].includes(type)) {
    return 'type must be one of: percent, fixed';
  }
  if (!Number.isInteger(value) || value <= 0) {
    return 'value must be a positive integer';
  }
  if (type === 'percent' && value > 100) {
    return 'percent value must be between 1 and 100';
  }
  return null;
}

// GET / — list all discounts (admin only)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('discounts')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// POST / — create discount (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { code, type, value, scope, expires_at, active, admin_only } = req.body;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'code is required' });
  }

  const typeValueError = validateTypeValue(type, value);
  if (typeValueError) return res.status(400).json({ error: typeValueError });

  const { data, error } = await supabase
    .from('discounts')
    .insert({
      code: code.trim().toUpperCase(),
      type,
      value,
      scope: scope || 'all',
      expires_at: expires_at || null,
      active: active !== undefined ? active : true,
      admin_only: admin_only === true,
    })
    .select()
    .single();

  if (error) {
    // 23505 = unique_violation on the code column
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A discount with that code already exists' });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json(data);
});

// PUT /:id — update discount (admin only)
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { code, type, value, scope, expires_at, active, admin_only } = req.body;

  // If type or value is being changed, validate the resulting pair.
  if (type !== undefined || value !== undefined) {
    const typeValueError = validateTypeValue(type, value);
    if (typeValueError) return res.status(400).json({ error: typeValueError });
  }

  const updates = {};
  if (code !== undefined) updates.code = String(code).trim().toUpperCase();
  if (type !== undefined) updates.type = type;
  if (value !== undefined) updates.value = value;
  if (scope !== undefined) updates.scope = scope;
  if (expires_at !== undefined) updates.expires_at = expires_at;
  if (active !== undefined) updates.active = active;
  if (admin_only !== undefined) updates.admin_only = admin_only === true;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  const { data, error } = await supabase
    .from('discounts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A discount with that code already exists' });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: 'Discount not found' });
  return res.json(data);
});

// DELETE /:id — delete discount (admin only)
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('discounts')
    .delete()
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Discount not found' });
  return res.json({ message: 'Discount deleted', discount: data });
});

// POST /validate — check a code against a service (no auth required).
// Returns the price math so the booking UI can preview the discount; the
// charged amount is re-validated server-side at payment time regardless.
router.post('/validate', async (req, res) => {
  const { code, service_id, service_ids } = req.body;

  // Back-compat: a single service_id is treated as a one-element list.
  const ids = Array.isArray(service_ids) && service_ids.length > 0
    ? service_ids
    : (service_id ? [service_id] : []);

  if (!code || ids.length === 0) {
    return res.status(400).json({ valid: false, error: 'code and service_id(s) are required' });
  }

  const { data: services, error: serviceError } = await supabase
    .from('services')
    .select('id, price_cents, category')
    .in('id', ids);

  if (serviceError) {
    return res.status(500).json({ valid: false, error: serviceError.message });
  }
  if (!services || services.length !== ids.length) {
    return res.status(404).json({ valid: false, error: 'Service not found' });
  }

  const result = await resolveDiscountForServices(supabase, { code, services });

  if (!result.ok) {
    return res.json({ valid: false, error: result.error });
  }

  // admin_only codes (e.g. military) are never self-serve — the salon applies
  // them at checkout. Treat as not found so they can't be previewed or used
  // from the public booking UI.
  if (result.discount.admin_only) {
    return res.json({ valid: false, error: 'Code not found' });
  }

  return res.json({
    valid: true,
    code: result.discount.code,
    type: result.discount.type,
    value: result.discount.value,
    label: result.label,
    original_cents: result.original_cents,
    discounted_cents: result.discounted_cents,
  });
});

export default router;
