import { Router } from 'express';
import Stripe from 'stripe';
import { DateTime } from 'luxon';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Day/month boundaries are computed in the salon's timezone so "today" and
// "this month" match the wall clock in Clarksville, not the UTC server clock.
const SALON_TZ = process.env.SALON_TZ || 'America/Chicago';

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
  // Anchor "today" and "this month" to salon-local wall-clock days, then
  // convert the bounds to UTC ISO instants for the timestamptz comparisons.
  const salonNow = DateTime.now().setZone(SALON_TZ);
  const todayStart = salonNow.startOf('day').toUTC().toISO();
  const todayEnd = salonNow.endOf('day').toUTC().toISO();
  const monthStart = salonNow.startOf('month').toUTC().toISO();
  const monthEnd = salonNow.endOf('month').toUTC().toISO();

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

      // Money actually collected this month: sum of amount_paid_cents across
      // all appointments in the window. This captures deposits, full
      // prepayments, in-person payments recorded at completion, and no-show
      // fees uniformly — not just online-paid bookings. Cancelled appointments
      // are excluded (a refunded/abandoned deposit shouldn't read as revenue).
      supabase
        .from('appointments')
        .select('amount_paid_cents')
        .neq('status', 'cancelled')
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

// POST /clients — manually create a client profile (admin only). Creates a
// real auth user (confirmed, passwordless) so the client can later claim the
// account with a password reset / magic link, then upserts the profile row.
router.post('/clients', requireAuth, requireRole('admin'), async (req, res) => {
  const fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';

  if (!fullName || !email) {
    return res.status(400).json({ error: 'full_name and email are required' });
  }
  if (fullName.length > 120 || email.length > 254 || phone.length > 30) {
    return res.status(400).json({ error: 'Client details are too long' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address' });
  }
  if (phone && !/^[\d\s()+.\-]{7,}$/.test(phone)) {
    return res.status(400).json({ error: 'Please provide a valid phone number' });
  }

  const { data: created, error: authError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (authError) {
    if (/already (been )?registered|already exists/i.test(authError.message)) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    return res.status(500).json({ error: authError.message });
  }

  // A handle_new_user trigger may or may not have created the profile row —
  // upsert covers both cases.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .upsert(
      { id: created.user.id, full_name: fullName, phone: phone || null, role: 'client' },
      { onConflict: 'id' },
    )
    .select()
    .single();

  if (profileError) {
    // Don't leave an orphaned auth user behind.
    await supabase.auth.admin.deleteUser(created.user.id).catch(() => {});
    return res.status(500).json({ error: profileError.message });
  }

  return res.status(201).json({ client: { ...profile, email } });
});

// POST /clients/:id/card-setup — start saving a card on file (admin only).
// Creates the Stripe Customer if needed and returns a SetupIntent client
// secret; the admin UI confirms it with Stripe Elements so the raw card
// number never touches this server.
router.post('/clients/:id/card-setup', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, full_name, stripe_customer_id')
    .eq('id', id)
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Client not found' });
  if (error) return res.status(500).json({ error: error.message });

  try {
    let customerId = profile.stripe_customer_id;

    if (!customerId) {
      const { data: authUser } = await supabase.auth.admin.getUserById(id);
      const customer = await stripe.customers.create({
        name: profile.full_name || undefined,
        email: authUser?.user?.email || undefined,
        metadata: { profile_id: id },
      });
      customerId = customer.id;

      const { error: saveError } = await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', id);
      if (saveError) return res.status(500).json({ error: saveError.message });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      payment_method_types: ['card'],
    });

    return res.json({ client_secret: setupIntent.client_secret });
  } catch (stripeError) {
    return res.status(500).json({ error: `Stripe error: ${stripeError.message}` });
  }
});

// GET /clients/:id/cards — list cards on file (admin only). Brand/last4 only.
router.get('/clients/:id/cards', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', id)
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Client not found' });
  if (error) return res.status(500).json({ error: error.message });
  if (!profile.stripe_customer_id) return res.json({ cards: [] });

  try {
    const methods = await stripe.paymentMethods.list({
      customer: profile.stripe_customer_id,
      type: 'card',
    });
    return res.json({
      cards: methods.data.map((pm) => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year,
      })),
    });
  } catch (stripeError) {
    return res.status(500).json({ error: `Stripe error: ${stripeError.message}` });
  }
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
