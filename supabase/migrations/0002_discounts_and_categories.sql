-- ============================================================
-- Blades & Ash Studio — Discounts & Service Categories Migration
-- Run this in the Supabase SQL Editor on the existing project.
-- Idempotent: safe to run more than once.
--
-- Adds:
--   1. services.category — nullable text column for grouping services
--   2. discounts — promo-code table (percent/fixed, scoped to 'all' or a
--      service category), with public read + service-role writes.
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. SERVICE CATEGORIES
-- ──────────────────────────────────────────────────────────
alter table services
  add column if not exists category text;

-- ──────────────────────────────────────────────────────────
-- 2. DISCOUNTS (promo codes)
-- ──────────────────────────────────────────────────────────
-- Codes are stored/compared UPPERCASE. `scope` is either the literal 'all'
-- (applies to any service) or a service category name. `value` is a percent
-- (1–100) for type 'percent' or an absolute amount in cents for type 'fixed'.
create table if not exists discounts (
  id uuid default gen_random_uuid() primary key,
  code text unique not null,
  type text check (type in ('percent', 'fixed')),
  value int not null,
  scope text not null default 'all',
  expires_at timestamptz,
  active boolean default true,
  created_at timestamptz default now()
);

alter table discounts enable row level security;

-- Reads are public (the booking UI previews codes); writes happen only via the
-- service-role client in the API, which bypasses RLS. Drop-then-create so this
-- migration is safe to re-run.
drop policy if exists "Public read discounts" on discounts;

create policy "Public read discounts"
  on discounts for select
  using (true);
