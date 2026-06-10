import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { sendBookingConfirmation } from '../lib/email.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /create-intent — create a Stripe PaymentIntent for an appointment
router.post('/create-intent', requireAuth, async (req, res) => {
  const { appointment_id } = req.body;
  const userId = req.user.id;

  if (!appointment_id) {
    return res.status(400).json({ error: 'appointment_id is required' });
  }

  // Fetch the appointment
  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .select('*, service:services(name)')
    .eq('id', appointment_id)
    .single();

  if (apptError) return res.status(500).json({ error: apptError.message });
  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

  // Verify the requesting user is the client
  if (appointment.client_id !== userId) {
    return res.status(403).json({ error: 'You are not authorized to pay for this appointment' });
  }

  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot create payment for a cancelled appointment' });
  }

  // Determine amount: use deposit_cents if set, otherwise total_cents
  const amountCents = appointment.deposit_cents > 0
    ? appointment.deposit_cents
    : appointment.total_cents;

  if (!amountCents || amountCents <= 0) {
    return res.status(400).json({ error: 'No payment amount found for this appointment' });
  }

  try {
    let paymentIntent;

    // If there's already a payment intent, retrieve it
    if (appointment.stripe_payment_intent_id) {
      paymentIntent = await stripe.paymentIntents.retrieve(appointment.stripe_payment_intent_id);

      // If the existing intent is in a state we can't reuse, create a new one
      if (['succeeded', 'canceled'].includes(paymentIntent.status)) {
        paymentIntent = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: 'usd',
          metadata: {
            appointment_id,
            client_id: userId,
          },
          automatic_payment_methods: { enabled: true },
        });

        // Update the appointment with the new payment intent id
        await supabase
          .from('appointments')
          .update({
            stripe_payment_intent_id: paymentIntent.id,
            stripe_payment_status: paymentIntent.status,
          })
          .eq('id', appointment_id);
      }
    } else {
      // Create a new PaymentIntent
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        metadata: {
          appointment_id,
          client_id: userId,
        },
        automatic_payment_methods: { enabled: true },
      });

      // Save payment intent ID to appointment
      await supabase
        .from('appointments')
        .update({
          stripe_payment_intent_id: paymentIntent.id,
          stripe_payment_status: paymentIntent.status,
        })
        .eq('id', appointment_id);
    }

    return res.json({ client_secret: paymentIntent.client_secret });
  } catch (stripeError) {
    return res.status(500).json({ error: `Stripe error: ${stripeError.message}` });
  }
});

// POST /webhook — Stripe webhook handler (raw body, no auth)
// NOTE: This route must be mounted with express.raw() middleware — handled in index.js
router.post('/webhook', async (req, res) => {
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

      // Find appointment by stripe_payment_intent_id
      const { data: appointment, error: fetchError } = await supabase
        .from('appointments')
        .select('*, client:profiles!appointments_client_id_fkey(email, full_name), service:services(name), staff:profiles!appointments_staff_id_fkey(full_name)')
        .eq('stripe_payment_intent_id', paymentIntent.id)
        .single();

      if (fetchError || !appointment) {
        console.error('No appointment found for payment intent:', paymentIntent.id);
        // Still return 200 to acknowledge receipt to Stripe
        return res.json({ received: true });
      }

      // Update appointment: mark as confirmed and record payment
      const { error: updateError } = await supabase
        .from('appointments')
        .update({
          stripe_payment_status: 'succeeded',
          status: 'confirmed',
          amount_paid_cents: paymentIntent.amount_received,
        })
        .eq('id', appointment.id);

      if (updateError) {
        console.error('Failed to update appointment after payment success:', updateError.message);
      }

      // Send confirmation email
      try {
        if (appointment.client?.email) {
          await sendBookingConfirmation({
            to: appointment.client.email,
            clientName: appointment.client.full_name,
            serviceName: appointment.service?.name || 'Your service',
            staffName: appointment.staff?.full_name || 'Your stylist',
            startTime: appointment.start_time,
            totalCents: appointment.total_cents,
            depositCents: appointment.deposit_cents > 0 ? paymentIntent.amount_received : null,
          });
        }
      } catch (emailError) {
        console.error('Failed to send booking confirmation email after payment:', emailError.message);
      }

      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;

      const { error: updateError } = await supabase
        .from('appointments')
        .update({
          stripe_payment_status: 'failed',
          status: 'pending',
        })
        .eq('stripe_payment_intent_id', paymentIntent.id);

      if (updateError) {
        console.error('Failed to update appointment after payment failure:', updateError.message);
      }

      break;
    }

    default:
      // Acknowledge other event types without processing them
      console.log(`Unhandled Stripe event type: ${event.type}`);
  }

  return res.json({ received: true });
});

export default router;
