import { Router } from 'express';
import Stripe from 'stripe';
import { DateTime } from 'luxon';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { attachItems } from './appointments.js';

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

// GET /payments — payments ledger for reconciliation (admin only). Optional
// from/to (ISO) filters on created_at. Returns rows plus totals by method, so
// the card subset can be tied to Stripe and the cash subset to the drawer/bank.
router.get('/payments', requireAuth, requireRole('admin'), async (req, res) => {
  const { from, to } = req.query;

  let query = supabase
    .from('payments')
    .select(`
      *,
      appointment:appointments!payments_appointment_id_fkey(id, start_time, service:services!appointments_service_id_fkey(name)),
      client:profiles!payments_client_id_fkey(full_name),
      recorder:profiles!payments_recorded_by_fkey(full_name)
    `)
    .order('created_at', { ascending: false });

  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const byMethod = {};
  let total = 0;
  for (const p of data || []) {
    byMethod[p.method] = (byMethod[p.method] || 0) + (p.amount_cents || 0);
    total += p.amount_cents || 0;
  }

  return res.json({ payments: data || [], totals: { by_method: byMethod, total_cents: total } });
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
  // The admin UI loads this list once and searches it locally, so a short page
  // would hide every client past the cut — including one just added. Allow the
  // same 1000 the guests list does; the salon's roster is far below that.
  const { lim, off } = clampPagination(limit, offset, { maxLimit: 1000 });

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

  // Stamp each row with when they last signed the waiver / filled the
  // consultation, so the list can show it at a glance without a per-row fetch.
  const clients = await attachFormDates(data || []);
  return res.json({ clients, total: count });
});

// Latest waiver + consultation dates for a page of clients, in one query.
// Matches on client_id only — forms signed as a guest (before the account
// existed) show up in the client's full profile view, which also matches on
// email, but not in the list.
async function attachFormDates(rows) {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return rows;
  const { data: forms, error } = await supabase
    .from('client_forms')
    .select('client_id, kind, created_at')
    .in('client_id', ids)
    .order('created_at', { ascending: false });
  if (error) return rows;
  const latest = new Map(); // `${client_id}:${kind}` -> created_at
  for (const f of forms || []) {
    const key = `${f.client_id}:${f.kind}`;
    if (!latest.has(key)) latest.set(key, f.created_at);
  }
  return rows.map((r) => ({
    ...r,
    waiver_signed_at: latest.get(`${r.id}:waiver`) || null,
    consultation_at: latest.get(`${r.id}:consultation`) || null,
  }));
}

// GET /guests — list people who booked without an account (admin only).
// Guest bookings are appointments with a null client_id, so they never show up
// in /clients. Every guest booking also mints a fresh Stripe customer, so the
// same person booking three times looks like three unrelated rows — we group
// by lowercased guest_email in JS to collapse them back into one guest.
router.get('/guests', requireAuth, requireRole('admin'), async (req, res) => {
  const { search, limit, offset } = req.query;
  // Guests are already collapsed one-per-person here, and the admin UI loads
  // the list once and filters it locally — so allow a bigger page than the
  // 200 the paged /clients list uses, or the UI would silently show a subset.
  const { lim, off } = clampPagination(limit, offset, { maxLimit: 1000 });

  // Aggregating in memory, so cap how much we pull. The salon's guest volume
  // is far below this ceiling; newest bookings win if it's ever hit.
  const MAX_ROWS = 5000;

  const { data, error } = await supabase
    .from('appointments')
    .select('id, start_time, guest_name, guest_email, guest_phone, stripe_customer_id')
    .is('client_id', null)
    .not('guest_email', 'is', null)
    .neq('guest_email', '')
    .order('start_time', { ascending: false })
    .limit(MAX_ROWS);

  if (error) return res.status(500).json({ error: error.message });

  // Rows arrive newest-first, so the first row seen for an email is that
  // guest's most recent booking — name/phone/last_* all come from it.
  const byEmail = new Map();
  for (const appt of data || []) {
    const email = String(appt.guest_email || '').trim().toLowerCase();
    if (!email) continue;

    const existing = byEmail.get(email);
    if (existing) {
      existing.bookings += 1;
      if (appt.stripe_customer_id) existing.has_card = true;
      continue;
    }

    byEmail.set(email, {
      email,
      name: appt.guest_name || null,
      phone: appt.guest_phone || null,
      bookings: 1,
      last_appointment_at: appt.start_time,
      last_appointment_id: appt.id,
      has_card: Boolean(appt.stripe_customer_id),
    });
  }

  let guests = Array.from(byEmail.values());

  if (search) {
    // Filtering happens in JS, but sanitise and cap the term the same way the
    // query-side searches do so a pathological input can't be handed around.
    const safe = String(search).replace(/[,()%_]/g, ' ').trim().slice(0, 100).toLowerCase();
    if (safe) {
      guests = guests.filter((g) =>
        `${g.name || ''} ${g.email} ${g.phone || ''}`.toLowerCase().includes(safe)
      );
    }
  }

  // Most recently seen guests first.
  guests.sort((a, b) => new Date(b.last_appointment_at) - new Date(a.last_appointment_at));

  // Count the filtered set before paginating so the UI shows a true total.
  const total = guests.length;

  return res.json({ guests: guests.slice(off, off + lim), total });
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

// GET /clients/:id — one client profile plus their auth email (admin only).
// The profiles table has no email column, so the list endpoint can't return
// it; the edit form fetches it here.
router.get('/clients/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .eq('role', 'client')
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Client not found' });
  if (error) return res.status(500).json({ error: error.message });

  const { data: authUser } = await supabase.auth.admin.getUserById(id);
  return res.json({ client: { ...profile, email: authUser?.user?.email || null } });
});

// GET /clients/:id/summary — everything the salon wants at a glance before
// booking or serving a client: contact, card on file, forms on file (waiver +
// consultation, matched by account OR by the email they typed, so a waiver
// signed as a guest before they made an account still counts), and their
// appointments with what's been paid on each.
router.get('/clients/:id/summary', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Client not found' });
  if (error) return res.status(500).json({ error: error.message });

  const { data: authUser } = await supabase.auth.admin.getUserById(id);
  const email = authUser?.user?.email || null;

  // Forms: by account, plus by email for anything submitted before/without
  // the account being linked.
  let formsQuery = supabase
    .from('client_forms')
    .select('id, kind, client_id, client_name, client_email, agreement_version, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (email) {
    const safe = email.replace(/[,()%_]/g, '');
    formsQuery = formsQuery.or(`client_id.eq.${id},client_email.ilike.${safe}`);
  } else {
    formsQuery = formsQuery.eq('client_id', id);
  }
  const { data: forms } = await formsQuery;

  const latest = {};
  for (const f of forms || []) {
    if (!latest[f.kind]) latest[f.kind] = f;
  }

  // Appointments, newest first. `items` mirrors what the appointments API
  // returns so the UI can reuse apptServiceNames().
  const { data: appts, error: apptError } = await supabase
    .from('appointments')
    .select(`
      id, start_time, end_time, status, total_cents, deposit_cents, amount_paid_cents,
      card_on_file, stripe_payment_status, fee_charged_cents, fee_type, stripe_customer_id,
      staff:profiles!appointments_staff_id_fkey(id, full_name),
      service:services!appointments_service_id_fkey(id, name, price_cents, duration_minutes)
    `)
    .eq('client_id', id)
    .order('start_time', { ascending: false })
    .limit(40);

  if (apptError) return res.status(500).json({ error: apptError.message });

  let appointments = appts || [];
  try {
    appointments = await attachItems(appointments);
  } catch (e) {
    console.error('Client summary: could not attach items:', e.message);
  }

  return res.json({
    client: { ...profile, email },
    forms: { waiver: latest.waiver || null, consultation: latest.consultation || null, all: forms || [] },
    appointments,
  });
});

// PUT /clients/:id — edit a client's name, phone, and email (admin only)
router.put('/clients/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';

  if (!fullName) return res.status(400).json({ error: 'full_name is required' });
  if (fullName.length > 120 || email.length > 254 || phone.length > 30) {
    return res.status(400).json({ error: 'Client details are too long' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address' });
  }
  if (phone && !/^[\d\s()+.\-]{7,}$/.test(phone)) {
    return res.status(400).json({ error: 'Please provide a valid phone number' });
  }

  // Only rows that are actually clients — staff/admins are edited elsewhere.
  const { data: existing, error: findError } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', id)
    .eq('role', 'client')
    .single();

  if (findError && findError.code === 'PGRST116') return res.status(404).json({ error: 'Client not found' });
  if (findError) return res.status(500).json({ error: findError.message });

  if (email) {
    const { data: authUser } = await supabase.auth.admin.getUserById(id);
    if (authUser?.user && authUser.user.email !== email) {
      const { error: emailError } = await supabase.auth.admin.updateUserById(id, {
        email,
        email_confirm: true,
      });
      if (emailError) {
        if (/already (been )?registered|already exists/i.test(emailError.message)) {
          return res.status(409).json({ error: 'A user with this email already exists' });
        }
        return res.status(500).json({ error: emailError.message });
      }
    }
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .update({ full_name: fullName, phone: phone || null })
    .eq('id', existing.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ client: { ...profile, email: email || undefined } });
});

// DELETE /clients/:id — remove a client entirely (admin only). Their past
// appointments are kept: the client's contact details are copied into the
// guest_* columns first, then client_id goes null via ON DELETE SET NULL.
// Deleting the auth user cascades to the profile and their service notes.
router.delete('/clients/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, full_name, phone, role, stripe_customer_id')
    .eq('id', id)
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Client not found' });
  if (error) return res.status(500).json({ error: error.message });
  if (profile.role !== 'client') {
    return res.status(400).json({ error: 'Only clients can be deleted here. Demote staff/admins to client first.' });
  }

  const { data: authUser } = await supabase.auth.admin.getUserById(id);
  const email = authUser?.user?.email || null;

  // Keep the appointment history readable after the account is gone by copying
  // the contact details into the guest columns. Clear the Stripe references in
  // the same update: the customer is deleted just below, so leaving them behind
  // would make these rows claim a card on file that no longer exists — and
  // /guests, which reads exactly these columns, would report it as one.
  const { error: keepError } = await supabase
    .from('appointments')
    .update({
      guest_name: profile.full_name,
      guest_email: email,
      guest_phone: profile.phone,
      stripe_customer_id: null,
      stripe_payment_method_id: null,
      card_on_file: false,
    })
    .eq('client_id', id)
    .is('guest_name', null);
  if (keepError) return res.status(500).json({ error: keepError.message });

  // Best-effort: drop the Stripe customer so no saved card outlives the client.
  if (profile.stripe_customer_id) {
    await stripe.customers.del(profile.stripe_customer_id).catch(() => {});
  }

  const { error: deleteError } = await supabase.auth.admin.deleteUser(id);
  if (deleteError) return res.status(500).json({ error: deleteError.message });

  return res.json({ ok: true });
});

// GET /clients/:id/notes — the client's service-note history, newest first
// (admin only)
router.get('/clients/:id/notes', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('client_service_notes')
    .select('id, body, created_at, author:profiles!client_service_notes_author_id_fkey(id, full_name)')
    .eq('client_id', id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ notes: data });
});

// POST /clients/:id/notes — add a service note to a client (admin only)
router.post('/clients/:id/notes', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';

  if (!body) return res.status(400).json({ error: 'Note text is required' });
  if (body.length > 4000) return res.status(400).json({ error: 'Note is too long (4000 characters max)' });

  const { data: profile, error: findError } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', id)
    .single();

  if (findError && findError.code === 'PGRST116') return res.status(404).json({ error: 'Client not found' });
  if (findError) return res.status(500).json({ error: findError.message });

  const { data, error } = await supabase
    .from('client_service_notes')
    .insert({ client_id: profile.id, author_id: req.user.id, body })
    .select('id, body, created_at, author:profiles!client_service_notes_author_id_fkey(id, full_name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ note: data });
});

// PUT /clients/:id/notes/:noteId — edit a service note (admin only)
router.put('/clients/:id/notes/:noteId', requireAuth, requireRole('admin'), async (req, res) => {
  const { id, noteId } = req.params;
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';

  if (!body) return res.status(400).json({ error: 'Note text is required' });
  if (body.length > 4000) return res.status(400).json({ error: 'Note is too long (4000 characters max)' });

  const { data, error } = await supabase
    .from('client_service_notes')
    .update({ body })
    .eq('id', noteId)
    .eq('client_id', id)
    .select('id, body, created_at, author:profiles!client_service_notes_author_id_fkey(id, full_name)')
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Note not found' });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ note: data });
});

// DELETE /clients/:id/notes/:noteId — remove a service note (admin only)
router.delete('/clients/:id/notes/:noteId', requireAuth, requireRole('admin'), async (req, res) => {
  const { id, noteId } = req.params;

  const { error } = await supabase
    .from('client_service_notes')
    .delete()
    .eq('id', noteId)
    .eq('client_id', id);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
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
