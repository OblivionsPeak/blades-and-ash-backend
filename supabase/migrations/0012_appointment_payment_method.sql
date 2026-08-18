-- ============================================================
-- 0012: Pin each appointment to the card that was captured FOR IT
--
-- Until now, "the card on file" for an appointment meant "whatever
-- card currently sits on the Stripe customer". That is only correct
-- while one customer holds exactly one card, which stopped being
-- guaranteed the moment a customer could accumulate several (an
-- admin adding a second card, or a repeat client booking again).
--
-- Storing the payment method captured by this appointment's own
-- SetupIntent makes the display and the fee charge unambiguous: the
-- card shown is the card charged, and it is the card that person
-- actually presented for this booking.
--
-- Nullable on purpose. Rows created before this migration have no
-- pinned method, and both the card-display and charge-fee paths fall
-- back to the customer's first card for them, exactly as before.
-- Idempotent.
-- ============================================================

alter table appointments
  add column if not exists stripe_payment_method_id text;
