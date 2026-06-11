import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveDiscountForServices } from '../lib/discounts.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /create-intent — create a Stripe PaymentIntent for an appointment
router.post('/create-intent', requireAuth, async (req, res) => {
  const { appointment_id, discount_code } = req.body;
  const userId = req.user.id;

  if (!appointment_id) {
    return res.status(400).json({ error: 'appointment_id is required' });
  }

  // Fetch the appointment (pull the service's price + category so we can
  // re-validate any promo code server-side — we never trust client amounts).
  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .select('*, service:services!appointments_service_id_fkey(name, price_cents, category)')
    .eq('id', appointment_id)
    .single();

  if (apptError && apptError.code === 'PGRST116') return res.status(404).json({ error: 'Appointment not found' });
  if (apptError) return res.status(500).json({ error: apptError.message });
  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

  // Verify the requesting user is the client
  if (appointment.client_id !== userId) {
    return res.status(403).json({ error: 'You are not authorized to pay for this appointment' });
  }

  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot create payment for a cancelled appointment' });
  }

  // ── Discount flow ──────────────────────────────────────────
  // If a promo code is supplied, re-validate it server-side against this
  // appointment's service. A valid code lowers the stored total_cents; an
  // invalid/expired/out-of-scope code is silently ignored (full price). The
  // deposit is a fixed up-front amount and is charged as-is — the discount
  // is reflected in total_cents (and therefore the remaining balance).
  let totalCents = appointment.total_cents;
  if (discount_code) {
    // Recompute from the per-service price snapshot, NOT the stored
    // total_cents — discounting the already-discounted total would let
    // repeated calls stack the same code until the total hit zero.
    const { data: itemRows } = await supabase
      .from('appointment_services')
      .select('price_cents, service:services(category)')
      .eq('appointment_id', appointment_id);

    let serviceSet = null;
    if (itemRows && itemRows.length > 0) {
      serviceSet = itemRows.map((r) => ({
        price_cents: r.price_cents,
        category: r.service?.category ?? null,
      }));
    } else if (appointment.service) {
      // Legacy appointment with no appointment_services rows.
      serviceSet = [{
        price_cents: appointment.service.price_cents,
        category: appointment.service.category,
      }];
    }

    if (serviceSet) {
      const result = await resolveDiscountForServices(supabase, {
        code: discount_code,
        services: serviceSet,
      });
      // Only persist if it improves on the current total (never raise it,
      // never overwrite a better discount already applied at booking).
      if (result.ok && result.discounted_cents < totalCents) {
        totalCents = result.discounted_cents;
        await supabase
          .from('appointments')
          .update({ total_cents: totalCents })
          .eq('id', appointment_id);
      }
    }
  }

  // Determine amount: use deposit_cents if set, otherwise the (possibly
  // discounted) total. A deposit is capped at the total in case a discount
  // drops the total below the configured deposit.
  const amountCents = appointment.deposit_cents > 0
    ? Math.min(appointment.deposit_cents, totalCents)
    : totalCents;

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

// The Stripe webhook lives at /api/webhooks/stripe in index.js, mounted on
// express.raw() BEFORE the JSON body parser. A handler here would receive a
// parsed body and could never pass signature verification.

export default router;
