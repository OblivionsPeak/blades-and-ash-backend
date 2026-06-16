// Payments ledger helpers. The `payments` table is the source of truth for
// money collected; `appointments.amount_paid_cents` is a cached SUM kept in
// sync here so existing reads (dashboard revenue, balance-due math) keep working.
import { supabase } from '../supabase.js';

// Recompute an appointment's cached amount_paid_cents from its ledger rows.
export async function recalcAmountPaid(appointmentId) {
  if (!appointmentId) return 0;
  const { data, error } = await supabase
    .from('payments')
    .select('amount_cents')
    .eq('appointment_id', appointmentId);
  if (error) throw new Error(error.message);
  const sum = (data || []).reduce((s, r) => s + (r.amount_cents || 0), 0);
  const { error: updateError } = await supabase
    .from('appointments')
    .update({ amount_paid_cents: sum })
    .eq('id', appointmentId);
  if (updateError) throw new Error(updateError.message);
  return sum;
}

// Record one payment in the ledger, then refresh the appointment's cached total.
// Card payments pass stripePaymentIntentId and are deduped on it, so a retried
// Stripe webhook never double-counts. Returns the new amount_paid_cents.
export async function recordPayment({
  appointmentId,
  clientId = null,
  amountCents,
  method,
  kind = 'payment',
  stripePaymentIntentId = null,
  note = null,
  recordedBy = null,
}) {
  const row = {
    appointment_id: appointmentId,
    client_id: clientId,
    amount_cents: amountCents,
    method,
    kind,
    stripe_payment_intent_id: stripePaymentIntentId,
    note,
    recorded_by: recordedBy,
  };

  if (stripePaymentIntentId) {
    // Idempotent on the Stripe PaymentIntent (unique index).
    const { error } = await supabase
      .from('payments')
      .upsert(row, { onConflict: 'stripe_payment_intent_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('payments').insert(row);
    if (error) throw new Error(error.message);
  }

  return recalcAmountPaid(appointmentId);
}
