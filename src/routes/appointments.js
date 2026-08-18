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
import { isBookingBlocked } from '../lib/timeoff.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SALON_TZ = process.env.SALON_TZ || 'America/Chicago';

// Whether the salon requires a card on file for HER OWN bookings too lives in
// the settings object (one JSON file in a private Storage bucket — see
// routes/settings.js). It is read server-side only; the request body never gets
// a say in it. Booking is a hot path, so the flag is cached in memory: a toggle
// taking up to a minute to take effect is fine, a Storage download on every
// booking is not.
const SETTINGS_BUCKET = 'settings';
const SETTINGS_OBJECT = 'salon-info.json';
const SETTINGS_TTL_MS = 60 * 1000;
// A salon that has never saved settings has no object in the bucket. That is a
// legitimate "the toggle is off", not a failure — same not-found shapes
// routes/settings.js treats as `{}`.
const SETTINGS_NOT_FOUND_RE = /not.?found|does not exist|400/i;
let cachedRequireCard = false;
let cachedRequireCardAt = 0;

// Never throws: a settings read failure must not be able to break booking, so
// the last known value stands (false on a cold cache — the pre-setting
// behaviour) and the next booking retries. Only GENUINE failures retry; a
// missing settings object caches like any other answer, so the common
// never-configured salon doesn't pay a failed round trip on every booking.
async function requireCardOnFileSetting() {
  if (cachedRequireCardAt && Date.now() - cachedRequireCardAt < SETTINGS_TTL_MS) {
    return cachedRequireCard;
  }
  try {
    const { data, error } = await supabase.storage
      .from(SETTINGS_BUCKET)
      .download(SETTINGS_OBJECT);
    if (error) {
      if (SETTINGS_NOT_FOUND_RE.test(error.message || '')) {
        cachedRequireCard = false;
        cachedRequireCardAt = Date.now();
        return cachedRequireCard;
      }
      throw new Error(error.message);
    }
    const parsed = JSON.parse(await data.text());
    cachedRequireCard = parsed?.require_card_on_file === true;
    cachedRequireCardAt = Date.now();
  } catch (settingsError) {
    console.error('Could not read require_card_on_file setting:', settingsError.message);
  }
  return cachedRequireCard;
}

// Called by PUT /settings after a successful save. Without this the salon can
// flip the toggle, immediately test a booking, get the OLD behaviour for up to a
// minute, and reasonably conclude the setting is broken. Only the timestamp is
// cleared, never the value: if the very next read fails transiently the last
// known answer still stands, exactly as above.
export function invalidateRequireCardOnFileCache() {
  cachedRequireCardAt = 0;
}

// A saved card is only reusable if it is still valid when the fee could be
// charged — that's AFTER the visit, not at booking, so the appointment's start
// month is the bar. `paymentMethods.list` does not filter expired cards, so
// without this a card that expired last year gets pinned and the booking
// confirms silently. Anything we can't read an expiry from is treated as
// unusable: falling through to collecting a card is always the safe direction.
function isCardUsableAt(method, startTime) {
  const card = method?.card;
  if (!card || !card.exp_year || !card.exp_month) return false;
  const start = DateTime.fromISO(startTime, { zone: SALON_TZ });
  if (!start.isValid) return false;
  // Cards are valid through the END of their expiry month.
  return card.exp_year * 12 + card.exp_month >= start.year * 12 + start.month;
}

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

  // Reject bookings that fall in the stylist's time off. The availability
  // endpoint already hides these slots; this guards against a direct POST.
  // A whole-day block rejects the date outright; a partial-day block only
  // rejects bookings that overlap its time window (lib/timeoff.js).
  const bookingDate = DateTime.fromISO(start_time, { zone: SALON_TZ }).toISODate();
  if (bookingDate) {
    const { data: blocked, error: blockedError } = await supabase
      .from('staff_time_off')
      .select('start_time, end_time')
      .eq('staff_id', staff_id)
      .lte('start_date', bookingDate)
      .gte('end_date', bookingDate);
    if (blockedError) return res.status(500).json({ error: blockedError.message });
    if (isBookingBlocked({
      blocks: blocked || [],
      date: bookingDate,
      salonTz: SALON_TZ,
      bookingStartMs: startTimeDate.getTime(),
      bookingEndMs: endTimeDate.getTime(),
    })) {
      return res.status(409).json({ error: 'The stylist is unavailable at that time. Please choose another time.' });
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
  // bookings are settled in person and skip card capture — UNLESS the salon
  // has turned on require_card_on_file, which extends the same rule to the
  // bookings she takes herself so those clients can be charged a fee too.
  const requireCardForAdmin = isAdminBooking ? await requireCardOnFileSetting() : false;
  const cardRequired = !isAdminBooking || requireCardForAdmin;

  // If an admin booking now needs a card and the client ALREADY has one saved,
  // don't make her ask for it again: pin the newest saved method to this
  // appointment (an explicit pin, so it can't drift to a different card later)
  // and confirm immediately. Same resolvers the card display and charge-fee use,
  // so what gets pinned is what would actually be charged. If anything about the
  // lookup is uncertain we fall through and collect a card rather than book
  // without one.
  let reusedCustomerId = null;
  let reusedMethod = null;
  if (requireCardForAdmin) {
    try {
      const customerId = await resolveAppointmentCustomer({
        client_id: clientId,
        stripe_customer_id: null,
      });
      if (customerId) {
        const method = await resolveAppointmentMethod({ stripe_payment_method_id: null }, customerId);
        if (method && isCardUsableAt(method, start_time)) {
          reusedCustomerId = customerId;
          reusedMethod = method;
        } else if (method) {
          // Saved but expired by the time of the visit — collecting a fresh card
          // is the whole point of the setting for exactly this client.
          console.log('Saved card is expired for this appointment; collecting a new one instead.');
        }
      }
    } catch (cardLookupError) {
      console.error('Saved-card lookup failed for admin booking:', cardLookupError.message);
    }
  }
  const cardReused = !!reusedMethod;

  // A card still has to be COLLECTED whenever one is required and none was
  // reused. This is what drives the SetupIntent, the pending status, and the
  // "confirmed now" notification block below.
  const collectCard = cardRequired && !cardReused;

  // Create appointment. service_id is the FIRST/primary service so existing
  // single-service joins keep working; the full set is stored in
  // appointment_services below.
  const appointmentData = {
    client_id: clientId,
    staff_id,
    service_id: primaryService.id,
    start_time,
    end_time,
    status: collectCard ? 'pending' : 'confirmed',
    client_notes: client_notes || null,
    total_cents: totalCents,
    deposit_cents: 0,
    amount_paid_cents: 0,
    // Guest contact details (null for signed-in clients).
    guest_name: guestName,
    guest_email: guestEmail,
    guest_phone: guestPhone,
  };

  // Card already on file: pin it to this appointment and it's confirmed as-is —
  // no Stripe customer creation, no SetupIntent, nothing for the admin to do.
  if (cardReused) {
    appointmentData.stripe_customer_id = reusedCustomerId;
    appointmentData.stripe_payment_method_id = reusedMethod.id;
    appointmentData.card_on_file = true;
  }

  // Set up the Stripe customer + SetupIntent that captures the card on file.
  let setupIntent = null;
  if (collectCard) {
    try {
      let customerId = null;
      if (isGuest) {
        // One Stripe customer per guest booking, deliberately. Reusing a prior
        // guest's customer by email was tried and reverted: guest_email is
        // unverified public input, so anyone typing a previous guest's address
        // would inherit their saved card — visible via GET /:id/card and
        // chargeable via charge-fee. Safe reuse needs the appointment to pin
        // its own payment_method, not to share a customer.
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

      const setupIntentParams = {
        usage: 'off_session',
        payment_method_types: ['card'],
        metadata: { service_name: primaryService.name },
      };

      try {
        setupIntent = await stripe.setupIntents.create({ ...setupIntentParams, customer: customerId });
      } catch (setupError) {
        const code = setupError.code || setupError.raw?.code;
        // A profile can hold a stripe_customer_id for a customer that no longer
        // exists in Stripe (deleted, or restored from another Stripe account).
        // Failing here would make that client unbookable — turning a policy ON
        // must never do that — so replace the dead id and retry exactly once.
        if (code !== 'resource_missing' || isGuest || !clientId) throw setupError;
        const customer = await stripe.customers.create({
          name: bookedForName || undefined,
          email: bookedForEmail || undefined,
          metadata: { profile_id: clientId },
        });
        customerId = customer.id;
        await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', clientId);
        setupIntent = await stripe.setupIntents.create({ ...setupIntentParams, customer: customerId });
      }

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

  // Bookings with no card step (admin in-person, or an admin booking that
  // reused a card already on file) are confirmed immediately, so notify the
  // client and owner now. Bookings still awaiting a card instead fire these
  // from the Stripe webhook once it's saved (setup_intent.succeeded).
  if (!collectCard) {
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
  // ADDED for the admin card-on-file flow — the public flow's fields above are
  // unchanged. `card_status` tells the caller which of the three outcomes it got:
  //   'reused'       — a card already on file was pinned; booking is confirmed
  //   'collect'      — a card must be collected now (setup_client_secret is set)
  //   'not_required' — this booking needs no card at all
  response.card_status = cardReused ? 'reused' : (setupIntent ? 'collect' : 'not_required');

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

// Resolve the Stripe customer holding this appointment's card. The appointment's
// own id wins (that's what makes guest bookings work); the profile is only a
// fallback for older rows and admin-created bookings. Returns null when there's
// nothing to resolve. Throws on a Supabase failure so callers can fail loudly.
async function resolveAppointmentCustomer(appointment) {
  if (appointment.stripe_customer_id) return appointment.stripe_customer_id;
  if (!appointment.client_id) return null;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', appointment.client_id)
    .single();
  if (error) throw new Error(error.message);
  return profile?.stripe_customer_id || null;
}

// Resolve the card that belongs to this appointment, as a Stripe PaymentMethod.
//
// Shared deliberately by the display endpoint and the charge endpoint: if these
// two ever disagree, the admin is shown one card and a different one is charged.
// They were separate implementations once and had exactly that bug.
//
// The method pinned at booking wins, but only while it is still attached to this
// customer — a detached method still resolves and still reports its brand/last4,
// so returning it unchecked would display a card that cannot be charged.
//
// Transient Stripe failures THROW rather than falling back. Falling back on a
// timeout would quietly switch which card gets charged, and the fallback picks
// the newest card, which for anyone with two saved cards is the wrong one.
// Note: `customer` is compared as a string id — do not add `expand: ['customer']`
// here or the comparison silently fails and pins stop being honoured.
async function resolveAppointmentMethod(appointment, customerId) {
  if (appointment.stripe_payment_method_id) {
    let pinned = null;
    try {
      pinned = await stripe.paymentMethods.retrieve(appointment.stripe_payment_method_id);
    } catch (stripeError) {
      const code = stripeError.code || stripeError.raw?.code;
      if (code !== 'resource_missing') throw stripeError;
    }
    if (pinned && pinned.customer === customerId) return pinned;
  }

  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  return methods.data[0] || null;
}

// GET /:id/card — the card on file for this appointment (admin only). Read-only
// display for the admin UI: brand/last4/expiry only, never the payment method or
// customer id. Uses the same resolver as charge-fee, so what's shown is always
// the card that would actually be charged. No card on file is a normal state
// here, not an error: it returns { card: null } plus a `reason` so the UI can
// say WHY, since "no card" has several innocent causes and one telling one.
router.get('/:id/card', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .select('id, client_id, stripe_customer_id, stripe_payment_method_id, stripe_setup_intent_id, card_on_file')
    .eq('id', id)
    .single();

  if (apptError && apptError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (apptError) return res.status(500).json({ error: apptError.message });
  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

  // Why is there no card? Inferred from what the booking actually recorded:
  //   never_requested — no SetupIntent was ever created, so nothing asked for a
  //                     card. Staff-created bookings skip capture by design,
  //                     as do bookings predating the card-on-file requirement.
  //   not_completed   — a SetupIntent exists but never succeeded: the client
  //                     abandoned the card step. This is the one worth chasing.
  //   removed         — a card WAS captured and is now gone (detached, or the
  //                     customer was deleted).
  const noCardReason = () => {
    if (appointment.card_on_file) return 'removed';
    if (appointment.stripe_setup_intent_id) return 'not_completed';
    return 'never_requested';
  };

  try {
    const customerId = await resolveAppointmentCustomer(appointment);
    if (!customerId) return res.json({ card: null, reason: noCardReason() });

    const method = await resolveAppointmentMethod(appointment, customerId);
    if (!method?.card) return res.json({ card: null, reason: noCardReason() });

    return res.json({
      card: {
        brand: method.card.brand,
        last4: method.card.last4,
        exp_month: method.card.exp_month,
        exp_year: method.card.exp_year,
      },
    });
  } catch (lookupError) {
    return res.status(500).json({ error: `Stripe error: ${lookupError.message}` });
  }
});

// Send the client confirmation + owner alert for an appointment that has just
// become confirmed OUTSIDE the booking request — i.e. skip-card, where no
// setup_intent.succeeded webhook will ever fire to do it. Deliberately a
// separate loader rather than a refactor of the inline block in POST /, which
// depends on a dozen in-scope variables from that request.
//
// Loads the same joins POST sends from and reproduces its multi-service
// "X and N more" naming and its isGuest handling: guests are contacted at
// guest_email, account holders at their auth email. Throws on failure — every
// caller treats notification as non-fatal.
async function sendConfirmationEmails(appointmentId) {
  const { data: appointment, error } = await supabase
    .from('appointments')
    .select(`
      *,
      client:profiles!appointments_client_id_fkey(id, full_name, phone),
      service:services!appointments_service_id_fkey(name),
      staff:profiles!appointments_staff_id_fkey(full_name)
    `)
    .eq('id', appointmentId)
    .single();

  if (error) throw new Error(error.message);
  if (!appointment) throw new Error(`Appointment ${appointmentId} not found`);

  const isGuest = !appointment.client_id;

  let to = null;
  let clientDisplayName;
  if (isGuest) {
    to = appointment.guest_email || null;
    clientDisplayName = appointment.guest_name || 'there';
  } else {
    const { data: userData } = await supabase.auth.admin.getUserById(appointment.client_id);
    to = userData?.user?.email || null;
    clientDisplayName = appointment.client?.full_name || 'there';
  }

  // Same naming POST uses: the primary service, plus a count of the rest.
  const primaryName = appointment.service?.name || 'Your service';
  const { data: items } = await supabase
    .from('appointment_services')
    .select('id')
    .eq('appointment_id', appointmentId);
  const extraCount = (items?.length || 0) - 1;
  const serviceName = extraCount > 0 ? `${primaryName} and ${extraCount} more` : primaryName;
  const staffName = appointment.staff?.full_name || 'Your stylist';

  if (to) {
    await sendBookingConfirmation({
      to,
      clientName: clientDisplayName,
      serviceName,
      staffName,
      startTime: appointment.start_time,
      totalCents: appointment.total_cents,
      amountPaidCents: null,
    });
  }

  await sendOwnerBookingAlert({
    clientName: clientDisplayName,
    clientEmail: to,
    clientPhone: isGuest ? appointment.guest_phone || null : null,
    serviceName,
    staffName,
    startTime: appointment.start_time,
    totalCents: appointment.total_cents,
    amountPaidCents: null,
    notes: appointment.client_notes || null,
    isGuest,
  });
}

// POST /:id/skip-card — confirm a booking the salon has decided to take without
// a card (admin only). The appointment already exists and is sitting pending on
// a live SetupIntent, so this cancels that intent and clears the reference.
// Without it the booking is indistinguishable from a client who abandoned the
// card step — the card display would report exactly that, which is the opposite
// of what happened — and an uncompletable SetupIntent would sit in Stripe.
router.post('/:id/skip-card', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .select('id, status, card_on_file, stripe_setup_intent_id')
    .eq('id', id)
    .single();

  if (apptError && apptError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (apptError) return res.status(500).json({ error: apptError.message });
  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

  if (appointment.card_on_file) {
    return res.status(409).json({ error: 'A card was saved for this appointment — nothing to skip.' });
  }

  // Only a booking still waiting on a card can be skipped. Without this an
  // admin hitting this endpoint on a cancelled or completed appointment would
  // resurrect it to 'confirmed' — re-double-booking a slot that may have been
  // rebooked since — and email the client a fresh confirmation for it.
  if (appointment.status !== 'pending') {
    return res.status(409).json({
      error: `This appointment is ${appointment.status}, not awaiting a card — nothing to skip.`,
    });
  }

  // STRIPE IS THE SOURCE OF TRUTH FOR "did a card arrive?", not card_on_file:
  // the column is only written by the webhook, which lags the client's card by
  // seconds. Ask Stripe BEFORE doing anything destructive, because the failure
  // mode is silent and bad — Stripe refuses to cancel a succeeded intent, and
  // clearing the reference on top of that would strand the webhook (it looks
  // the row up by stripe_setup_intent_id) leaving a card attached in Stripe
  // that the DB says doesn't exist.
  let intentCancelled = false;
  if (appointment.stripe_setup_intent_id) {
    let intent = null;
    try {
      intent = await stripe.setupIntents.retrieve(appointment.stripe_setup_intent_id);
    } catch (retrieveError) {
      // Couldn't check. Confirm the booking anyway (that part is safe) but touch
      // nothing in Stripe and keep the reference so the webhook can reconcile.
      console.error('Could not retrieve SetupIntent before skip-card:', retrieveError.message);
    }

    if (intent?.status === 'succeeded') {
      return res.status(409).json({
        error: 'A card was saved for this appointment — nothing to skip.',
      });
    }

    if (intent?.status === 'canceled') {
      // Already gone: nothing left that a late webhook could match.
      intentCancelled = true;
    } else if (intent) {
      try {
        await stripe.setupIntents.cancel(appointment.stripe_setup_intent_id);
        intentCancelled = true;
      } catch (cancelError) {
        // Leave the reference in place so a late webhook can still find and
        // reconcile this row. The booking is still confirmed below.
        console.error('Could not cancel SetupIntent during skip-card:', cancelError.message);
      }
    }
  }

  // Only drop the reference when the intent is provably dead. Guard the write on
  // card_on_file still being false: the webhook could have landed between the
  // read above and here, and confirming-without-a-card must never throw away a
  // card that just arrived.
  const updates = { status: 'confirmed' };
  if (intentCancelled) updates.stripe_setup_intent_id = null;

  // The filters ARE the concurrency guard — a compare-and-swap, not the earlier
  // read. Two simultaneous clicks (double click, two tabs, a retried request)
  // would both have read 'pending' above; only one can match here, so only one
  // confirms and only one email goes out.
  const { data: updated, error: updateError } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', id)
    .eq('card_on_file', false)
    .eq('status', 'pending')
    .select()
    .single();

  if (updateError && updateError.code === 'PGRST116') {
    // Nothing matched, so something changed underneath us. Re-read to say which.
    const { data: current } = await supabase
      .from('appointments')
      .select('status, card_on_file')
      .eq('id', id)
      .single();
    if (current?.card_on_file) {
      return res.status(409).json({ error: 'A card was saved for this appointment — nothing to skip.' });
    }
    return res.status(409).json({ error: 'This appointment was already confirmed — nothing to skip.' });
  }
  if (updateError) return res.status(500).json({ error: updateError.message });

  // This booking is now confirmed and NO setup_intent.succeeded webhook will
  // ever fire for it, so this is the only chance to tell anyone it exists.
  // Without it the client's first contact is a 24h reminder (jobs/reminders.js)
  // for an appointment they were never told about.
  // Reaching here means this request is the one that moved it pending ->
  // confirmed, so exactly one confirmation goes out.
  try {
    await sendConfirmationEmails(id);
  } catch (emailError) {
    // Non-fatal, exactly like POST /: never fail the request over an email.
    console.error('Failed to send booking notification after skip-card:', emailError.message);
  }

  return res.json({ appointment: updated });
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
    .select('id, client_id, total_cents, amount_paid_cents, fee_charged_cents, stripe_customer_id, stripe_payment_method_id')
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

  // Same resolver the card display uses, so the admin is never shown one card
  // and charged another.
  let customerId;
  let paymentMethod;
  try {
    customerId = await resolveAppointmentCustomer(appointment);
    if (!customerId) {
      return res.status(400).json({ error: 'No card on file for this appointment.' });
    }
    paymentMethod = await resolveAppointmentMethod(appointment, customerId);
  } catch (lookupError) {
    // Fail closed: we could not confirm which card belongs to this appointment,
    // so charge nothing rather than guess.
    return res.status(502).json({ error: 'Could not verify the card on file. Please try again.' });
  }

  if (!paymentMethod) {
    return res.status(400).json({ error: 'No card on file for this appointment.' });
  }

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: chargeableCents,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      metadata: { appointment_id: id, fee_type, kind: 'fee' },
    }, {
      // Two quick clicks both pass the "already covered" check above (both read
      // the pre-charge amount_paid_cents), so without this the client is charged
      // the fee twice. Keyed on the appointment and fee type, which is exactly
      // the operation that must happen at most once.
      idempotencyKey: `fee_${id}_${fee_type}_${chargeableCents}`,
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
