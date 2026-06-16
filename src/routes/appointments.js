import { Router } from 'express';
import Stripe from 'stripe';
import { DateTime } from 'luxon';
import { supabase } from '../supabase.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendBookingConfirmation, sendOwnerBookingAlert } from '../lib/email.js';
import { resolveDiscountForServices } from '../lib/discounts.js';
import { computeFee, isValidFeeType } from '../lib/fees.js';
import { recordPayment } from '../lib/payments.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SALON_TZ = process.env.SALON_TZ || 'America/Chicago';

// Attach an `items` array to each appointment from appointment_services
// (joined to services for the name). For LEGACY appointments with no
// appointment_services rows, synthesize a single item from the primary
// `service` join so old bookings still render. Mutates and returns the input.
async function attachItems(appointments) {
  if (!appointments || appointments.length === 0) return appointments;

  const ids = appointments.map((a) => a.id);
  const { data: rows, error } = await supabase
    .from('appointment_services')
    .select('appointment_id, service_id, price_cents, duration_minutes, service:services(name)')
    .in('appointment_id', ids);

  if (error) throw new Error(error.message);

  const byAppointment = new Map();
  for (const row of rows || []) {
    if (!byAppointment.has(row.appointment_id)) byAppointment.set(row.appointment_id, []);
    byAppointment.get(row.appointment_id).push({
      service_id: row.service_id,
      name: row.service?.name ?? null,
      price_cents: row.price_cents,
      duration_minutes: row.duration_minutes,
    });
  }

  for (const appt of appointments) {
    const items = byAppointment.get(appt.id);
    if (items && items.length > 0) {
      appt.items = items;
    } else if (appt.service) {
      // Legacy fallback: synthesize from the primary service join.
      appt.items = [{
        service_id: appt.service.id,
        name: appt.service.name,
        price_cents: appt.service.price_cents,
        duration_minutes: appt.service.duration_minutes,
      }];
    } else {
      appt.items = [];
    }
  }

  return appointments;
}

// For appointments booked by a guest (client_id is null), the `client` join is
// null. Synthesize a display object from the stored guest_* fields so admin/staff
// lists can render "the client" uniformly. Mutates each appointment in place.
function attachGuestDisplay(appointments) {
  if (!appointments) return appointments;
  const list = Array.isArray(appointments) ? appointments : [appointments];
  for (const appt of list) {
    if (!appt.client_id && !appt.client) {
      appt.client = {
        id: null,
        full_name: appt.guest_name || 'Guest',
        phone: appt.guest_phone || null,
        avatar_url: null,
        is_guest: true,
      };
    }
  }
  return appointments;
}

// GET / — list appointments (role-filtered)
router.get('/', requireAuth, async (req, res) => {
  const { status, staff_id, date, from, to } = req.query;
  const userRole = req.user.profile.role;
  const userId = req.user.id;

  let query = supabase
    .from('appointments')
    .select(`
      *,
      client:profiles!appointments_client_id_fkey(id, full_name, phone, avatar_url),
      staff:profiles!appointments_staff_id_fkey(id, full_name, avatar_url),
      service:services!appointments_service_id_fkey(id, name, duration_minutes, price_cents)
    `)
    .order('start_time', { ascending: false });

  // Filter by role
  if (userRole === 'client') {
    query = query.eq('client_id', userId);
  } else if (userRole === 'staff') {
    query = query.eq('staff_id', userId);
  }
  // admin sees all — no filter

  // Apply optional filters
  if (status) query = query.eq('status', status);

  // Admin/staff can filter by specific staff_id
  if (staff_id && userRole === 'admin') {
    query = query.eq('staff_id', staff_id);
  }

  if (date) {
    const dayStart = date + 'T00:00:00.000Z';
    const dayEnd = date + 'T23:59:59.999Z';
    query = query.gte('start_time', dayStart).lte('start_time', dayEnd);
  }

  if (from) query = query.gte('start_time', from);
  if (to) query = query.lte('start_time', to);

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });

  try {
    await attachItems(data);
  } catch (itemsError) {
    return res.status(500).json({ error: itemsError.message });
  }

  attachGuestDisplay(data);

  return res.json(data);
});

// POST / — create appointment. Auth is OPTIONAL: signed-in clients book against
// their own client_id; guests (no token) must supply guest_name/email/phone and
// are stored with client_id = null. Pricing/duration/discount are always
// computed server-side — guest amounts from the client are never trusted.
router.post('/', optionalAuth, async (req, res) => {
  const {
    staff_id, service_id, service_ids, start_time, client_notes, discount_code,
    guest_name, guest_email, guest_phone, client_id,
  } = req.body;

  const isGuest = !req.user;

  // Admins may book ON BEHALF of a client (walk-in / phone booking) by
  // passing client_id. Non-admins always book for themselves.
  const isAdminBooking = !!(req.user && req.user.profile.role === 'admin'
    && client_id && client_id !== req.user.id);
  const clientId = isGuest ? null : (isAdminBooking ? client_id : req.user.id);

  // The booked-for client's name/email, used for the confirmation email. For
  // self-bookings this is the requesting user; for admin bookings it's looked
  // up below; for guests it's the guest_* fields.
  let bookedForName = req.user?.profile?.full_name || null;
  let bookedForEmail = req.user?.email || null;
  if (isAdminBooking) {
    const { data: clientProfile, error: clientError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('id', client_id)
      .single();
    if (clientError && clientError.code === 'PGRST116') {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (clientError) return res.status(500).json({ error: clientError.message });
    bookedForName = clientProfile.full_name;
    const { data: authUser } = await supabase.auth.admin.getUserById(client_id);
    bookedForEmail = authUser?.user?.email || null;
  }

  // Guests must identify themselves so we can send a confirmation / contact
  // them. The frontend validates too, but this endpoint is public — validate
  // shape and length server-side so junk can't reach the DB or the mailer.
  let guestName = null;
  let guestEmail = null;
  let guestPhone = null;
  if (isGuest) {
    guestName = typeof guest_name === 'string' ? guest_name.trim() : '';
    guestEmail = typeof guest_email === 'string' ? guest_email.trim() : '';
    guestPhone = typeof guest_phone === 'string' ? guest_phone.trim() : '';

    if (!guestName || !guestEmail || !guestPhone) {
      return res.status(400).json({ error: 'guest_name, guest_email, and guest_phone are required to book as a guest' });
    }
    if (guestName.length > 120 || guestEmail.length > 254 || guestPhone.length > 30) {
      return res.status(400).json({ error: 'Guest contact details are too long' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    if (!/^[\d\s()+.\-]{7,}$/.test(guestPhone)) {
      return res.status(400).json({ error: 'Please provide a valid phone number' });
    }
  }

  // Back-compat: accept either service_ids (array, one or more) or a single
  // service_id (treated as a one-element list).
  const ids = Array.isArray(service_ids) && service_ids.length > 0
    ? service_ids
    : (service_id ? [service_id] : []);

  if (!staff_id || ids.length === 0 || !start_time) {
    return res.status(400).json({ error: 'staff_id, service_id(s), and start_time are required' });
  }
  if (ids.length > 10 || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'service_ids must be at most 10 unique services' });
  }
  if (client_notes && (typeof client_notes !== 'string' || client_notes.length > 2000)) {
    return res.status(400).json({ error: 'client_notes must be a string of at most 2000 characters' });
  }

  // Validate start_time is in the future
  const startTimeDate = new Date(start_time);
  if (isNaN(startTimeDate.getTime())) {
    return res.status(400).json({ error: 'Invalid start_time format' });
  }
  if (startTimeDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'start_time must be in the future' });
  }

  // Fetch services for duration and pricing. Every requested service must
  // exist and be active.
  const { data: fetchedServices, error: serviceError } = await supabase
    .from('services')
    .select('*')
    .in('id', ids)
    .eq('active', true);

  if (serviceError) {
    return res.status(500).json({ error: serviceError.message });
  }
  if (!fetchedServices || fetchedServices.length !== ids.length) {
    return res.status(404).json({ error: 'Service not found or inactive' });
  }

  // Preserve the caller's order; ids[0] is the primary service.
  const services = ids.map((id) => fetchedServices.find((s) => s.id === id));
  const primaryService = services[0];

  // SUMMED duration → end_time
  const totalDuration = services.reduce((sum, s) => sum + s.duration_minutes, 0);
  const endTimeDate = new Date(startTimeDate.getTime() + totalDuration * 60 * 1000);
  const end_time = endTimeDate.toISOString();

  // Reject bookings on a date the stylist has blocked off (vacation/holiday).
  // The availability endpoint already hides these slots; this guards against a
  // direct POST.
  const bookingDate = DateTime.fromISO(start_time, { zone: SALON_TZ }).toISODate();
  if (bookingDate) {
    const { data: blocked, error: blockedError } = await supabase
      .from('staff_time_off')
      .select('id')
      .eq('staff_id', staff_id)
      .lte('start_date', bookingDate)
      .gte('end_date', bookingDate)
      .limit(1);
    if (blockedError) return res.status(500).json({ error: blockedError.message });
    if (blocked && blocked.length > 0) {
      return res.status(409).json({ error: 'The stylist is unavailable on that date. Please choose another time.' });
    }
  }

  // Double-book prevention: check for conflicting appointments
  const { data: conflicts, error: conflictError } = await supabase
    .from('appointments')
    .select('id')
    .eq('staff_id', staff_id)
    .neq('status', 'cancelled')
    .lt('start_time', end_time)
    .gt('end_time', start_time);

  if (conflictError) return res.status(500).json({ error: conflictError.message });

  if (conflicts && conflicts.length > 0) {
    return res.status(409).json({ error: 'This time slot is no longer available. Please choose a different time.' });
  }

  // Determine payment details. total is the SUM of service prices. If a promo
  // code is supplied, re-validate it server-side against the full set and apply
  // it to the total — never trust a client-sent amount. An invalid/expired/
  // out-of-scope code is silently ignored (full price). The deposit is the SUM
  // of per-service deposits (where deposit_required), capped at the (possibly
  // discounted) total.
  let totalCents = services.reduce((sum, s) => sum + s.price_cents, 0);
  if (discount_code) {
    const result = await resolveDiscountForServices(supabase, { code: discount_code, services });
    if (result.ok) {
      totalCents = result.discounted_cents;
    }
  }

  // Card-on-file replaces deposits: nothing is charged at booking. Public
  // (self-service) bookings MUST save a card via a Stripe SetupIntent so a
  // no-show / late-cancel fee can be charged later. Admin walk-in/phone
  // bookings are settled in person and skip card capture.
  const cardRequired = !isAdminBooking;

  // Create appointment. service_id is the FIRST/primary service so existing
  // single-service joins keep working; the full set is stored in
  // appointment_services below.
  const appointmentData = {
    client_id: clientId,
    staff_id,
    service_id: primaryService.id,
    start_time,
    end_time,
    status: cardRequired ? 'pending' : 'confirmed',
    client_notes: client_notes || null,
    total_cents: totalCents,
    deposit_cents: 0,
    amount_paid_cents: 0,
    // Guest contact details (null for signed-in clients).
    guest_name: guestName,
    guest_email: guestEmail,
    guest_phone: guestPhone,
  };

  // Set up the Stripe customer + SetupIntent that captures the card on file.
  let setupIntent = null;
  if (cardRequired) {
    try {
      let customerId = null;
      if (isGuest) {
        const customer = await stripe.customers.create({
          name: guestName || undefined,
          email: guestEmail || undefined,
          metadata: { guest: 'true' },
        });
        customerId = customer.id;
      } else {
        // Account holder: reuse the profile's Stripe customer, creating one the
        // first time they book.
        const { data: profile } = await supabase
          .from('profiles')
          .select('stripe_customer_id')
          .eq('id', clientId)
          .single();
        customerId = profile?.stripe_customer_id || null;
        if (!customerId) {
          const customer = await stripe.customers.create({
            name: bookedForName || undefined,
            email: bookedForEmail || undefined,
            metadata: { profile_id: clientId },
          });
          customerId = customer.id;
          await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', clientId);
        }
      }

      setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        payment_method_types: ['card'],
        metadata: { service_name: primaryService.name },
      });

      appointmentData.stripe_customer_id = customerId;
      appointmentData.stripe_setup_intent_id = setupIntent.id;
    } catch (stripeError) {
      return res.status(500).json({ error: `Card setup failed: ${stripeError.message}` });
    }
  }

  const { data: appointment, error: insertError } = await supabase
    .from('appointments')
    .insert(appointmentData)
    .select()
    .single();

  if (insertError) {
    // If appointment creation fails and we already made a SetupIntent, cancel it.
    if (setupIntent) {
      await stripe.setupIntents.cancel(setupIntent.id).catch(() => {});
    }
    // 23P01 = exclusion_violation: the DB overlap constraint caught a booking
    // race that slipped past the pre-check above.
    if (insertError.code === '23P01') {
      return res.status(409).json({ error: 'This time slot is no longer available. Please choose a different time.' });
    }
    return res.status(500).json({ error: insertError.message });
  }

  // Insert one appointment_services row per service (price/duration snapshot).
  const itemRows = services.map((s) => ({
    appointment_id: appointment.id,
    service_id: s.id,
    price_cents: s.price_cents,
    duration_minutes: s.duration_minutes,
  }));

  const { error: itemsError } = await supabase
    .from('appointment_services')
    .insert(itemRows);

  if (itemsError) {
    // Roll back the appointment (and any SetupIntent) so we never leave an
    // appointment without its service line items.
    await supabase.from('appointments').delete().eq('id', appointment.id);
    if (setupIntent) {
      await stripe.setupIntents.cancel(setupIntent.id).catch(() => {});
    }
    return res.status(500).json({ error: itemsError.message });
  }

  // Insert reminder rows (24h and 2h before, both email + sms)
  const reminderRows = [
    { appointment_id: appointment.id, type: '24h', channel: 'email', status: 'pending' },
    { appointment_id: appointment.id, type: '24h', channel: 'sms', status: 'pending' },
    { appointment_id: appointment.id, type: '2h', channel: 'email', status: 'pending' },
    { appointment_id: appointment.id, type: '2h', channel: 'sms', status: 'pending' },
  ];

  await supabase.from('reminders').insert(reminderRows);

  // Admin (in-person) bookings have no card step and are confirmed immediately,
  // so notify the client and owner now. Card-required bookings instead fire
  // these from the Stripe webhook once the card is saved (setup_intent.succeeded).
  if (!cardRequired) {
    try {
      const { data: staffProfile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', staff_id)
        .single();

      const serviceName = services.length > 1
        ? `${primaryService.name} and ${services.length - 1} more`
        : primaryService.name;
      const staffName = staffProfile?.full_name || 'Your stylist';
      const clientDisplayName = isGuest ? guestName : (bookedForName || 'there');
      const confirmTo = isGuest ? guestEmail : bookedForEmail;

      if (confirmTo) {
        await sendBookingConfirmation({
          to: confirmTo,
          clientName: clientDisplayName,
          serviceName,
          staffName,
          startTime: start_time,
          totalCents,
          amountPaidCents: null,
        });
      }

      await sendOwnerBookingAlert({
        clientName: clientDisplayName,
        clientEmail: confirmTo,
        clientPhone: isGuest ? guestPhone : null,
        serviceName,
        staffName,
        startTime: start_time,
        totalCents,
        amountPaidCents: null,
        notes: client_notes || null,
        isGuest,
      });
    } catch (emailError) {
      // Non-fatal: log but don't fail the request
      console.error('Failed to send booking notification:', emailError.message);
    }
  }

  const response = { appointment };
  if (setupIntent) {
    response.setup_client_secret = setupIntent.client_secret;
  }

  return res.status(201).json(response);
});

// GET /:id — get single appointment
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userRole = req.user.profile.role;
  const userId = req.user.id;

  const { data: appointment, error } = await supabase
    .from('appointments')
    .select(`
      *,
      client:profiles!appointments_client_id_fkey(id, full_name, phone, avatar_url),
      staff:profiles!appointments_staff_id_fkey(id, full_name, avatar_url),
      service:services!appointments_service_id_fkey(id, name, duration_minutes, price_cents)
    `)
    .eq('id', id)
    .single();

  // PGRST116 = no rows matched .single() — a missing id, not a server fault.
  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (error) return res.status(500).json({ error: error.message });
  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

  // Authorization: clients see only their own, staff only theirs, admin all.
  const canView =
    userRole === 'admin' ||
    (userRole === 'client' && appointment.client_id === userId) ||
    (userRole === 'staff' && appointment.staff_id === userId);

  if (!canView) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    await attachItems([appointment]);
  } catch (itemsError) {
    return res.status(500).json({ error: itemsError.message });
  }

  attachGuestDisplay(appointment);

  return res.json(appointment);
});

// PUT /:id — update appointment (staff/admin)
router.put('/:id', requireAuth, requireRole('staff', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { status, notes, start_time, end_time, amount_paid_cents } = req.body;

  const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];

  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
  if (amount_paid_cents !== undefined
      && (typeof amount_paid_cents !== 'number' || amount_paid_cents < 0 || !Number.isFinite(amount_paid_cents))) {
    return res.status(400).json({ error: 'amount_paid_cents must be a non-negative number' });
  }

  const updates = {};
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  if (start_time !== undefined) updates.start_time = start_time;
  if (end_time !== undefined) updates.end_time = end_time;
  if (amount_paid_cents !== undefined) updates.amount_paid_cents = Math.round(amount_paid_cents);

  // Recording revenue: most services are settled in person, so marking an
  // appointment completed should record that the service total was collected
  // (unless an explicit amount was given, or more was already paid online).
  // Without this the revenue dashboard only ever sees online deposits.
  if (status === 'completed' && amount_paid_cents === undefined) {
    const { data: current, error: fetchErr } = await supabase
      .from('appointments')
      .select('total_cents, amount_paid_cents')
      .eq('id', id)
      .single();
    if (fetchErr && fetchErr.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if ((current.amount_paid_cents || 0) < current.total_cents) {
      updates.amount_paid_cents = current.total_cents;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  const { data, error } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Appointment not found' });
  return res.json(data);
});

// DELETE /:id — cancel appointment (own client or staff/admin)
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userRole = req.user.profile.role;
  const userId = req.user.id;

  // Fetch the appointment first to verify ownership/permissions
  const { data: appointment, error: fetchError } = await supabase
    .from('appointments')
    .select('id, client_id, staff_id, status')
    .eq('id', id)
    .single();

  if (fetchError && fetchError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

  // Authorization check
  const isOwner = appointment.client_id === userId;
  const isStaffOrAdmin = userRole === 'staff' || userRole === 'admin';

  if (!isOwner && !isStaffOrAdmin) {
    return res.status(403).json({ error: 'You are not authorized to cancel this appointment' });
  }

  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Appointment is already cancelled' });
  }

  const { data, error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ message: 'Appointment cancelled', appointment: data });
});

// POST /:id/charge-fee — charge a no-show / late-cancellation fee to the
// client's saved card (admin only). The fee policy lives in lib/fees.js;
// already-collected payments (deposits) reduce what's charged now.
router.post('/:id/charge-fee', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { fee_type, amount_cents } = req.body;

  if (!isValidFeeType(fee_type)) {
    return res.status(400).json({ error: "fee_type must be 'no_show' or 'late_cancel'" });
  }
  if (amount_cents !== undefined
      && (typeof amount_cents !== 'number' || amount_cents <= 0 || !Number.isFinite(amount_cents))) {
    return res.status(400).json({ error: 'amount_cents, if provided, must be a positive number' });
  }

  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .select('id, client_id, total_cents, amount_paid_cents, fee_charged_cents, stripe_customer_id')
    .eq('id', id)
    .single();

  if (apptError && apptError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (apptError) return res.status(500).json({ error: apptError.message });

  const { feeCents, chargeableCents } = computeFee({
    feeType: fee_type,
    totalCents: appointment.total_cents,
    amountPaidCents: appointment.amount_paid_cents,
    overrideCents: amount_cents,
  });

  if (chargeableCents <= 0) {
    return res.json({
      charged: false,
      message: 'Payments already collected cover this fee — nothing to charge.',
      fee_cents: feeCents,
    });
  }

  // Resolve the Stripe customer holding the saved card. New bookings store it
  // on the appointment (so guests work too); fall back to the account profile
  // for older bookings or admin-saved cards.
  let customerId = appointment.stripe_customer_id || null;
  if (!customerId && appointment.client_id) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', appointment.client_id)
      .single();
    if (profileError) return res.status(500).json({ error: profileError.message });
    customerId = profile?.stripe_customer_id || null;
  }
  if (!customerId) {
    return res.status(400).json({ error: 'No card on file for this appointment.' });
  }

  let paymentIntent;
  try {
    const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    if (!methods.data.length) {
      return res.status(400).json({ error: 'No card on file for this appointment.' });
    }

    paymentIntent = await stripe.paymentIntents.create({
      amount: chargeableCents,
      currency: 'usd',
      customer: customerId,
      payment_method: methods.data[0].id,
      off_session: true,
      confirm: true,
      metadata: { appointment_id: id, fee_type, kind: 'fee' },
    });
  } catch (stripeError) {
    // off_session charges can fail if the card needs authentication or is
    // declined — surface a clear, actionable message to the admin.
    const code = stripeError.code || stripeError.raw?.code;
    if (code === 'authentication_required') {
      return res.status(402).json({ error: 'The card on file requires authentication and could not be charged off-session. Ask the client to pay this fee directly.' });
    }
    return res.status(402).json({ error: `Card could not be charged: ${stripeError.message}` });
  }

  if (paymentIntent.status !== 'succeeded') {
    return res.status(402).json({ error: `Charge did not complete (status: ${paymentIntent.status}).` });
  }

  // Record the fee in the ledger first — this recomputes amount_paid_cents — then
  // persist the fee bookkeeping fields and return the refreshed appointment.
  try {
    await recordPayment({
      appointmentId: id,
      clientId: appointment.client_id,
      amountCents: chargeableCents,
      method: 'card',
      kind: 'fee',
      stripePaymentIntentId: paymentIntent.id,
      note: fee_type === 'no_show' ? 'No-show fee' : 'Late-cancellation fee',
    });
  } catch (ledgerError) {
    return res.status(500).json({ error: ledgerError.message });
  }

  const { data: updated, error: updateError } = await supabase
    .from('appointments')
    .update({
      fee_type,
      fee_charged_cents: (appointment.fee_charged_cents || 0) + chargeableCents,
      fee_payment_intent_id: paymentIntent.id,
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });

  return res.json({ charged: true, amount_cents: chargeableCents, fee_cents: feeCents, appointment: updated });
});

// POST /:id/record-payment — log an in-person payment (cash/check/other) to the
// ledger, admin only. Card payments come through Stripe; this is how cash gets
// into the books so the dashboard revenue and the payments report include it.
router.post('/:id/record-payment', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { amount_cents, method, note } = req.body;

  if (!['cash', 'check', 'other'].includes(method)) {
    return res.status(400).json({ error: "method must be 'cash', 'check', or 'other'" });
  }
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return res.status(400).json({ error: 'amount_cents must be a positive integer' });
  }

  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .select('id, client_id')
    .eq('id', id)
    .single();

  if (apptError && apptError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (apptError) return res.status(500).json({ error: apptError.message });

  try {
    await recordPayment({
      appointmentId: id,
      clientId: appointment.client_id,
      amountCents: amount_cents,
      method,
      kind: 'payment',
      note: note ? String(note).slice(0, 500) : null,
      recordedBy: req.user.id,
    });
  } catch (ledgerError) {
    return res.status(500).json({ error: ledgerError.message });
  }

  const { data: updated, error: updateError } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', id)
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });

  return res.json({ recorded: true, amount_cents, method, appointment: updated });
});

// POST /:id/apply-discount — apply (or remove) a discount on an appointment,
// admin only. This is how eligibility-gated codes (e.g. military) get used:
// the customer can never self-apply them, so the salon applies them here at
// checkout. The new total is recomputed from the per-service price snapshot —
// never from the stored total — so applying is idempotent and removable.
// Pass discount_code: null (or "") to clear any applied discount.
router.post('/:id/apply-discount', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { discount_code } = req.body;
  const code = typeof discount_code === 'string' ? discount_code.trim() : '';

  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .select('*, service:services!appointments_service_id_fkey(price_cents, category)')
    .eq('id', id)
    .single();

  if (apptError && apptError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (apptError) return res.status(500).json({ error: apptError.message });
  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot change pricing on a cancelled appointment' });
  }

  // Build the service set from the price snapshot (multi-service rows, or the
  // single primary service for legacy appointments) and derive the full
  // un-discounted subtotal.
  const { data: itemRows } = await supabase
    .from('appointment_services')
    .select('price_cents, service:services(category)')
    .eq('appointment_id', id);

  let serviceSet = null;
  if (itemRows && itemRows.length > 0) {
    serviceSet = itemRows.map((r) => ({ price_cents: r.price_cents, category: r.service?.category ?? null }));
  } else if (appointment.service) {
    serviceSet = [{ price_cents: appointment.service.price_cents, category: appointment.service.category }];
  }
  if (!serviceSet) {
    return res.status(400).json({ error: 'No service pricing found for this appointment' });
  }

  const subtotalCents = serviceSet.reduce((sum, s) => sum + s.price_cents, 0);

  let newTotal = subtotalCents;
  let appliedCode = null;
  let label = null;

  if (code) {
    const result = await resolveDiscountForServices(supabase, { code, services: serviceSet });
    if (!result.ok) return res.status(400).json({ error: result.error });
    newTotal = result.discounted_cents;
    appliedCode = result.discount.code;
    label = result.label;
  }

  const { data: updated, error: updateError } = await supabase
    .from('appointments')
    .update({ total_cents: newTotal, discount_code: appliedCode })
    .eq('id', id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });

  // If a payment intent is already open (customer reached the pay step before
  // the discount was applied), keep its amount in sync so they're not charged
  // the old, higher figure. Only touch intents still awaiting payment — never a
  // succeeded/processing one. Best-effort: a Stripe hiccup here must not undo
  // the saved discount.
  const amountCents = appointment.deposit_cents > 0
    ? Math.min(appointment.deposit_cents, newTotal)
    : newTotal;
  if (appointment.stripe_payment_intent_id && amountCents > 0) {
    try {
      const pi = await stripe.paymentIntents.retrieve(appointment.stripe_payment_intent_id);
      const editable = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
      if (editable.includes(pi.status) && pi.amount !== amountCents) {
        await stripe.paymentIntents.update(appointment.stripe_payment_intent_id, { amount: amountCents });
      }
    } catch (stripeError) {
      // Non-fatal — the stored total is the source of truth; a fresh intent
      // (or the POS charge) will use the corrected amount.
    }
  }

  return res.json({
    appointment: updated,
    original_cents: subtotalCents,
    total_cents: newTotal,
    discount_code: appliedCode,
    label,
  });
});

// PUT /:id/reschedule — move an appointment to a new start time. A client may
// reschedule their own booking; staff/admin may reschedule any. Duration and
// services are preserved (the new end is derived from the existing length).
router.put('/:id/reschedule', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { start_time } = req.body;
  const userRole = req.user.profile.role;
  const userId = req.user.id;

  if (!start_time) {
    return res.status(400).json({ error: 'start_time is required' });
  }
  const newStart = new Date(start_time);
  if (isNaN(newStart.getTime())) {
    return res.status(400).json({ error: 'Invalid start_time format' });
  }
  if (newStart.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'start_time must be in the future' });
  }

  const { data: appointment, error: fetchError } = await supabase
    .from('appointments')
    .select('id, client_id, staff_id, status, start_time, end_time')
    .eq('id', id)
    .single();

  if (fetchError && fetchError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (fetchError) return res.status(500).json({ error: fetchError.message });

  const isOwner = appointment.client_id === userId;
  const isStaffOrAdmin = userRole === 'staff' || userRole === 'admin';
  if (!isOwner && !isStaffOrAdmin) {
    return res.status(403).json({ error: 'You are not authorized to reschedule this appointment' });
  }
  if (['cancelled', 'completed', 'no_show'].includes(appointment.status)) {
    return res.status(400).json({ error: `A ${appointment.status.replace('_', ' ')} appointment cannot be rescheduled.` });
  }

  // Preserve the booked duration — the services don't change on reschedule.
  const durationMs = new Date(appointment.end_time).getTime() - new Date(appointment.start_time).getTime();
  const newEnd = new Date(newStart.getTime() + durationMs);
  const newStartIso = newStart.toISOString();
  const newEndIso = newEnd.toISOString();

  // Conflict check against the same staff, excluding this appointment.
  const { data: conflicts, error: conflictError } = await supabase
    .from('appointments')
    .select('id')
    .eq('staff_id', appointment.staff_id)
    .neq('id', id)
    .neq('status', 'cancelled')
    .lt('start_time', newEndIso)
    .gt('end_time', newStartIso);

  if (conflictError) return res.status(500).json({ error: conflictError.message });
  if (conflicts && conflicts.length > 0) {
    return res.status(409).json({ error: 'That time is no longer available. Please choose a different time.' });
  }

  const { data: updated, error: updateError } = await supabase
    .from('appointments')
    .update({ start_time: newStartIso, end_time: newEndIso })
    .eq('id', id)
    .select()
    .single();

  // 23P01 = exclusion_violation: the DB overlap constraint caught a race.
  if (updateError && updateError.code === '23P01') {
    return res.status(409).json({ error: 'That time is no longer available. Please choose a different time.' });
  }
  if (updateError) return res.status(500).json({ error: updateError.message });

  // Reset reminders so the 24h/2h notices fire relative to the new time.
  await supabase.from('reminders').delete().eq('appointment_id', id).eq('status', 'pending');
  await supabase.from('reminders').insert([
    { appointment_id: id, type: '24h', channel: 'email', status: 'pending' },
    { appointment_id: id, type: '24h', channel: 'sms', status: 'pending' },
    { appointment_id: id, type: '2h', channel: 'email', status: 'pending' },
    { appointment_id: id, type: '2h', channel: 'sms', status: 'pending' },
  ]);

  return res.json({ message: 'Appointment rescheduled', appointment: updated });
});

export default router;
