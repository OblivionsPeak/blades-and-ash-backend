-- ============================================================
-- 0006: Card-on-file support
--
-- Adds profiles.stripe_customer_id — the Stripe Customer a saved
-- payment method is attached to. Cards themselves never touch our
-- database; they live in Stripe, captured via SetupIntent in the
-- admin UI. Idempotent — safe to re-run.
-- ============================================================

alter table profiles
  add column if not exists stripe_customer_id text;
