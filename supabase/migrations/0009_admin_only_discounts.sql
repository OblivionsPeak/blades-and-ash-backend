-- ============================================================
-- Blades & Ash Studio — Admin-applied discounts
-- Run this in the Supabase SQL Editor on the existing project.
-- Idempotent: safe to run more than once.
--
-- Adds:
--   1. discounts.admin_only — eligibility-gated codes (e.g. military) that the
--      salon applies at checkout. Customers can never self-apply these: the
--      public validate endpoint and client payment flow reject them.
--   2. appointments.discount_code — records which code was applied to an
--      appointment, for receipts/audit and so an applied discount can be
--      cleanly removed (the total is recomputed from the price snapshot).
-- ============================================================

alter table discounts
  add column if not exists admin_only boolean not null default false;

alter table appointments
  add column if not exists discount_code text;
