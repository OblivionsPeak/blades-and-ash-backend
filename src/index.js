import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';

import servicesRouter from './routes/services.js';
import staffRouter from './routes/staff.js';
import appointmentsRouter from './routes/appointments.js';
import availabilityRouter from './routes/availability.js';
import paymentsRouter from './routes/payments.js';
import discountsRouter from './routes/discounts.js';
import adminRouter from './routes/admin.js';
import { startReminderJob, processReminders } from './jobs/reminders.js';
import { supabase } from './supabase.js';
import { sendBookingConfirmation, sendOwnerBookingAlert } from './lib/email.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Render terminates TLS at a proxy, so trust the first proxy hop — this makes
// req.ip the real client IP, which the rate limiter keys on.
app.set('trust proxy', 1);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ──────────────────────────────────────────────
// CORS
// ──────────────────────────────────────────────
// Origins allowed to call the API from a browser. We hardcode the known
// production domains so a missing or partial FRONTEND_URL can't lock the
// live site out of its own API, then merge in FRONTEND_URL plus local dev.
// Never falls open to '*'.
const defaultOrigins = [
  'https://bladeandash.com',
  'https://www.bladeandash.com',
  'https://blades-and-ash.vercel.app',
  'http://localhost:5173',
];
const envOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser requests (no Origin header) and any allowed origin
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ──────────────────────────────────────────────
// Stripe Webhook — MUST use raw body BEFORE express.json()
// ──────────────────────────────────────────────
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return res.status(400).json({ error: 'Missing stripe signature or webhook secret' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;

      const { data: appointment, error: fetchError } = await supabase
        .from('appointments')
        .select(`
          *,
          client:profiles!appointments_client_id_fkey(id, full_name, phone),
          service:services!appointments_service_id_fkey(name),
          staff:profiles!appointments_staff_id_fkey(full_name)
        `)
        .eq('stripe_payment_intent_id', paymentIntent.id)
        .single();

      if (fetchError || !appointment) {
        console.error('No appointment found for payment intent:', paymentIntent.id);
        return res.json({ received: true });
      }

      await supabase
        .from('appointments')
        .update({
          stripe_payment_status: 'succeeded',
          status: 'confirmed',
          amount_paid_cents: paymentIntent.amount_received,
        })
        .eq('id', appointment.id);

      // Notify client + owner. Signed-in clients are looked up in auth.users;
      // guest bookings (client_id null) use the stored guest_email/guest_name.
      try {
        let to = null;
        let clientName = 'Valued Client';
        let clientPhone = null;

        if (appointment.client_id) {
          const { data: userData } = await supabase.auth.admin.getUserById(appointment.client_id);
          to = userData?.user?.email || null;
          clientName = appointment.client?.full_name || 'Valued Client';
          clientPhone = appointment.client?.phone || null;
        } else {
          to = appointment.guest_email || null;
          clientName = appointment.guest_name || 'Valued Client';
          clientPhone = appointment.guest_phone || null;
        }

        // metadata.payment_type tells whether this was a deposit or a full
        // prepayment, so both emails label the amount correctly.
        const paidInFull = paymentIntent.metadata?.payment_type === 'full';
        const paymentLabel = paidInFull ? 'Paid in full' : 'Deposit paid';
        const serviceName = appointment.service?.name || 'Your service';
        const staffName = appointment.staff?.full_name || 'Your stylist';

        if (to) {
          await sendBookingConfirmation({
            to,
            clientName,
            serviceName,
            staffName,
            startTime: appointment.start_time,
            totalCents: appointment.total_cents,
            amountPaidCents: paymentIntent.amount_received,
            paymentLabel,
          });
        }

        await sendOwnerBookingAlert({
          clientName,
          clientEmail: to,
          clientPhone,
          serviceName,
          staffName,
          startTime: appointment.start_time,
          totalCents: appointment.total_cents,
          amountPaidCents: paymentIntent.amount_received,
          paymentLabel,
          notes: appointment.client_notes || null,
          isGuest: !appointment.client_id,
        });
      } catch (emailError) {
        console.error('Failed to send booking notifications after payment:', emailError.message);
      }

      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;

      await supabase
        .from('appointments')
        .update({
          stripe_payment_status: 'failed',
          status: 'pending',
        })
        .eq('stripe_payment_intent_id', paymentIntent.id);

      break;
    }

    default:
      console.log(`Unhandled Stripe event type: ${event.type}`);
  }

  return res.json({ received: true });
});

// ──────────────────────────────────────────────
// Body Parsers (after Stripe webhook raw route)
// ──────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────────────────
// Health Check
// ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ──────────────────────────────────────────────
// Reminder trigger (for an external scheduler)
// ──────────────────────────────────────────────
// Lets a cron service (e.g. cron-job.org) run the reminder sweep without
// relying on the in-process cron, which is unreliable when a free-tier
// instance sleeps. Protected by a shared secret in the X-Cron-Secret header.
// Disabled (503) unless CRON_SECRET is configured, so it's never an open hook.
app.post('/api/internal/run-reminders', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Reminder trigger is not configured (CRON_SECRET unset).' });
  }
  if (req.get('X-Cron-Secret') !== secret) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }

  const summary = await processReminders();
  return res.json({ ok: true, ...summary });
});

// ──────────────────────────────────────────────
// Rate limiting on public / abuse-prone write endpoints
// ──────────────────────────────────────────────
// Limits anonymous booking spam, discount-code brute forcing, and availability
// scraping to 30 requests/min/IP. Applied as targeted middleware (NOT to the
// Stripe webhook, which is verified by signature and called by Stripe, and NOT
// to authenticated admin/staff routes). Returns 429 with a JSON error.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

// POST /api/appointments (guest/auth booking). The limiter only fires for the
// booking write; reads on this router are governed by their own auth.
app.use('/api/appointments', (req, res, next) =>
  req.method === 'POST' ? publicLimiter(req, res, next) : next()
);
// POST /api/discounts/validate (public promo-code check).
app.use('/api/discounts/validate', publicLimiter);
// GET /api/availability (public slot lookup).
app.use('/api/availability', publicLimiter);

// ──────────────────────────────────────────────
// API Routes
// ──────────────────────────────────────────────
app.use('/api/services', servicesRouter);
app.use('/api/staff', staffRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/availability', availabilityRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/discounts', discountsRouter);
app.use('/api/admin', adminRouter);

// ──────────────────────────────────────────────
// 404 Handler
// ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ──────────────────────────────────────────────
// Global Error Handler
// ──────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Error]', err.stack || err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ──────────────────────────────────────────────
// Start Server
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Blades & Ash Studio API running on port ${PORT}`);
  startReminderJob();
});

export default app;
