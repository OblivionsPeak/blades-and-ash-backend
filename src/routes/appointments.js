import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendBookingConfirmation } from '../lib/email.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
      service:services(id, name, duration_minutes, price_cents)
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
  return res.json(data);
});

// POST / — create appointment (requireAuth)
router.post('/', requireAuth, async (req, res) => {
  const { staff_id, service_id, start_time, client_notes } = req.body;
  const clientId = req.user.id;

  if (!staff_id || !service_id || !start_time) {
    return res.status(400).json({ error: 'staff_id, service_id, and start_time are required' });
  }

  // Validate start_time is in the future
  const startTimeDate = new Date(start_time);
  if (isNaN(startTimeDate.getTime())) {
    return res.status(400).json({ error: 'Invalid start_time format' });
  }
  if (startTimeDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'start_time must be in the future' });
  }

  // Fetch service for duration and pricing
  const { data: service, error: serviceError } = await supabase
    .from('services')
    .select('*')
    .eq('id', service_id)
    .eq('active', true)
    .single();

  if (serviceError || !service) {
    return res.status(404).json({ error: 'Service not found or inactive' });
  }

  // Calculate end_time
  const endTimeDate = new Date(startTimeDate.getTime() + service.duration_minutes * 60 * 1000);
  const end_time = endTimeDate.toISOString();

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

  // Determine payment details
  const totalCents = service.price_cents;
  const depositRequired = service.deposit_required && service.deposit_cents > 0;
  const depositCents = depositRequired ? service.deposit_cents : 0;

  // Create appointment
  const appointmentData = {
    client_id: clientId,
    staff_id,
    service_id,
    start_time,
    end_time,
    status: depositRequired ? 'pending' : 'confirmed',
    client_notes: client_notes || null,
    total_cents: totalCents,
    deposit_cents: depositCents,
    amount_paid_cents: 0,
  };

  let stripePaymentIntent = null;

  // If deposit required, create Stripe PaymentIntent first
  if (depositRequired) {
    try {
      stripePaymentIntent = await stripe.paymentIntents.create({
        amount: depositCents,
        currency: 'usd',
        metadata: {
          client_id: clientId,
          staff_id,
          service_id,
          service_name: service.name,
        },
        automatic_payment_methods: { enabled: true },
      });

      appointmentData.stripe_payment_intent_id = stripePaymentIntent.id;
      appointmentData.stripe_payment_status = 'requires_payment_method';
    } catch (stripeError) {
      return res.status(500).json({ error: `Payment setup failed: ${stripeError.message}` });
    }
  }

  const { data: appointment, error: insertError } = await supabase
    .from('appointments')
    .insert(appointmentData)
    .select()
    .single();

  if (insertError) {
    // If appointment creation fails and we already made a PaymentIntent, cancel it
    if (stripePaymentIntent) {
      await stripe.paymentIntents.cancel(stripePaymentIntent.id).catch(() => {});
    }
    // 23P01 = exclusion_violation: the DB overlap constraint caught a booking
    // race that slipped past the pre-check above.
    if (insertError.code === '23P01') {
      return res.status(409).json({ error: 'This time slot is no longer available. Please choose a different time.' });
    }
    return res.status(500).json({ error: insertError.message });
  }

  // Insert reminder rows (24h and 2h before, both email + sms)
  const reminderRows = [
    { appointment_id: appointment.id, type: '24h', channel: 'email', status: 'pending' },
    { appointment_id: appointment.id, type: '24h', channel: 'sms', status: 'pending' },
    { appointment_id: appointment.id, type: '2h', channel: 'email', status: 'pending' },
    { appointment_id: appointment.id, type: '2h', channel: 'sms', status: 'pending' },
  ];

  await supabase.from('reminders').insert(reminderRows);

  // Send booking confirmation email if status is confirmed (no deposit required)
  if (!depositRequired) {
    try {
      const { data: staffProfile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', staff_id)
        .single();

      await sendBookingConfirmation({
        to: req.user.email,
        clientName: req.user.profile.full_name,
        serviceName: service.name,
        staffName: staffProfile?.full_name || 'Your stylist',
        startTime: start_time,
        totalCents,
        depositCents: null,
      });
    } catch (emailError) {
      // Non-fatal: log but don't fail the request
      console.error('Failed to send confirmation email:', emailError.message);
    }
  }

  const response = { appointment };
  if (stripePaymentIntent) {
    response.client_secret = stripePaymentIntent.client_secret;
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
      service:services(id, name, duration_minutes, price_cents)
    `)
    .eq('id', id)
    .single();

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

  return res.json(appointment);
});

// PUT /:id — update appointment (staff/admin)
router.put('/:id', requireAuth, requireRole('staff', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { status, notes, start_time, end_time } = req.body;

  const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];

  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  const updates = {};
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  if (start_time !== undefined) updates.start_time = start_time;
  if (end_time !== undefined) updates.end_time = end_time;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  const { data, error } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

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

export default router;
