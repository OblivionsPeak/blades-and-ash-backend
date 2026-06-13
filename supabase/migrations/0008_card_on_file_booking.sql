-- ============================================================
-- 0008: Mandatory card-on-file at booking
--
-- Deposits are replaced by a required card on file (Stripe
-- SetupIntent, no charge). These columns let a booking — guest
-- or account holder — carry its own Stripe customer + setup
-- intent so the no-show/late-cancel fee can later be charged to
-- the saved card. Idempotent.
-- ============================================================

alter table appointments
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_setup_intent_id text,
  add column if not exists card_on_file boolean not null default false;
