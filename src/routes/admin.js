import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();

// Clamp user-supplied pagination to sane integers so `limit=abc` or a huge
// offset can't produce a NaN range or dump the whole table.
function clampPagination(limit, offset, { maxLimit = 200 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), maxLimit);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  return { lim, off };
}

// GET /dashboard — dashboard stats (admin and staff)
router.get('/dashboard', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();

  try {
    // Run queries in parallel
    const [
      upcomingResult,
      todayResult,
      revenueResult,
      clientCountResult,
      staffCountResult,
    ] = await Promise.all([
      // Upcoming appointments (future, not cancelled)
      supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .gte('start_time', now.toISOString())
        .neq('status', 'cancelled'),

      // Today's appointments (not cancelled)
      supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .gte('start_time', todayStart)
        .lte('start_time', todayEnd)
        .neq('status', 'cancelled'),

      // Revenue this month: sum of amount_paid_cents for confirmed/completed appointments
      supabase
        .from('appointments')
        .select('amount_paid_cents')
        .in('status', ['confirmed', 'completed'])
        .gte('start_time', monthStart)
        .lte('start_time', monthEnd),

      // Total unique clients
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'client'),

      // Total staff members
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .in('role', ['staff', 'admin']),
    ]);

    // Handle errors
    if (upcomingResult.error) throw new Error(upcomingResult.error.message);
    if (todayResult.error) throw new Error(todayResult.error.message);
    if (revenueResult.error) throw new Error(revenueResult.error.message);
    if (clientCountResult.error) throw new Error(clientCountResult.error.message);
    if (staffCountResult.error) throw new Error(staffCountResult.error.message);

    // Calculate revenue sum
    const revenueThisMonthCents = (revenueResult.data || []).reduce(
      (sum, appt) => sum + (appt.amount_paid_cents || 0),
      0
    );

    return res.json({
      upcoming_count: upcomingResult.count || 0,
      today_count: todayResult.count || 0,
      revenue_this_month_cents: revenueThisMonthCents,
      client_count: clientCountResult.count || 0,
      staff_count: staffCountResult.count || 0,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /appointments — admin view of all appointments with filters
router.get('/appointments', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { status, staff_id, date, from, to, limit, offset } = req.query;
  const userRole = req.user.profile.role;
  const userId = req.user.id;
  const { lim, off } = clampPagination(limit, offset);

  let query = supabase
    .from('appointments')
    .select(`
      *,
      client:profiles!appointments_client_id_fkey(id, full_name, phone, avatar_url),
      staff:profiles!appointments_staff_id_fkey(id, full_name, avatar_url),
      service:services!appointments_service_id_fkey(id, name, duration_minutes, price_cents)
    `, { count: 'exact' })
    .order('start_time', { ascending: false })
    .range(off, off + lim - 1);

  // Staff can only see their own appointments
  if (userRole === 'staff') {
    query = query.eq('staff_id', userId);
  } else if (staff_id) {
    // Admin filtering by staff_id
    query = query.eq('staff_id', staff_id);
  }

  if (status) query = query.eq('status', status);

  if (date) {
    const dayStart = date + 'T00:00:00.000Z';
    const dayEnd = date + 'T23:59:59.999Z';
    query = query.gte('start_time', dayStart).lte('start_time', dayEnd);
  }

  if (from) query = query.gte('start_time', from);
  if (to) query = query.lte('start_time', to);

  const { data, error, count } = await query;

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ appointments: data, total: count });
});

// GET /clients — list all client profiles (admin only)
router.get('/clients', requireAuth, requireRole('admin'), async (req, res) => {
  const { search, limit, offset } = req.query;
  const { lim, off } = clampPagination(limit, offset);

  let query = supabase
    .from('profiles')
    .select('*', { count: 'exact' })
    .eq('role', 'client')
    .order('full_name')
    .range(off, off + lim - 1);

  if (search) {
    // The PostgREST .or() filter string parses commas/parens as syntax —
    // strip them (plus wildcards) so a search term can't alter the filter.
    const safe = String(search).replace(/[,()%_]/g, ' ').trim().slice(0, 100);
    if (safe) {
      query = query.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
    }
  }

  const { data, error, count } = await query;

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ clients: data, total: count });
});

// PUT /profiles/:id/role — change a user's role (admin only)
router.put('/profiles/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  const validRoles = ['client', 'staff', 'admin'];
  if (!role || !validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Profile not found' });
  return res.json(data);
});

export default router;
