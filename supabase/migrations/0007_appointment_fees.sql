-- ============================================================
-- 0007: No-show / late-cancellation fee tracking
--
-- Records a fee charged against a saved card on file (Stripe
-- off-session PaymentIntent). The charge itself lives in Stripe;
-- these columns are the local audit trail. Idempotent.
-- ============================================================

alter table appointments
  add column if not exists fee_charged_cents int not null default 0,
  add column if not exists fee_type text,
  add column if not exists fee_payment_intent_id text;

-- Constrain fee_type to the known kinds (or null when no fee charged).
-- Dropped first so re-running with a changed list is safe.
alter table appointments drop constraint if exists appointments_fee_type_check;
alter table appointments
  add constraint appointments_fee_type_check
  check (fee_type is null or fee_type in ('no_show', 'late_cancel'));
