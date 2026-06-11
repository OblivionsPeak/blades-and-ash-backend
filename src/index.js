import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

import servicesRouter from './routes/services.js';
import staffRouter from './routes/staff.js';
import appointmentsRouter from './routes/appointments.js';
import availabilityRouter from './routes/availability.js';
import paymentsRouter from './routes/payments.js';
import discountsRouter from './routes/discounts.js';
import adminRouter from './routes/admin.js';
import { startReminderJob } from './jobs/reminders.js';
import { supabase } from './supabase.js';
import { sendBookingConfirmation } from './lib/email.js';

const app = express();
const PORT = process.env.PORT || 3001;

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
          client:profiles!appointments_client_id_fkey(id, full_name),
          service:services(name),
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

      // Send confirmation email
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(appointment.client_id);
        if (userData?.user?.email) {
          await sendBookingConfirmation({
            to: userData.user.email,
            clientName: appointment.client?.full_name || 'Valued Client',
            serviceName: appointment.service?.name || 'Your service',
            staffName: appointment.staff?.full_name || 'Your stylist',
            startTime: appointment.start_time,
            totalCents: appointment.total_cents,
            depositCents: appointment.deposit_cents > 0 ? paymentIntent.amount_received : null,
          });
        }
      } catch (emailError) {
        console.error('Failed to send confirmation email after payment:', emailError.message);
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
