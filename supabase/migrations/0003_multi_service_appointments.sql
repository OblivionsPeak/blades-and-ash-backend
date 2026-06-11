-- ============================================================
-- Blades & Ash Studio — Multi-Service Appointments Migration
-- Run this in the Supabase SQL Editor on the existing project.
-- Idempotent: safe to run more than once.
--
-- Adds:
--   appointment_services — join table letting one appointment (one stylist,
--   one back-to-back time block) contain multiple services. Price and duration
--   are snapshotted per service at booking time. `appointments.service_id`
--   stays the FIRST/primary service so existing single-service joins keep
--   working; total_cents / deposit_cents / end_time are computed from the full
--   set in the API.
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- APPOINTMENT <-> SERVICES (multi-service bookings)
-- ──────────────────────────────────────────────────────────
create table if not exists appointment_services (
  appointment_id uuid references appointments(id) on delete cascade,
  service_id uuid references services(id),
  price_cents int not null,
  duration_minutes int not null,
  primary key (appointment_id, service_id)
);

-- Accessed only server-side via the service role key (which bypasses RLS).
-- Enable RLS with no policies to close the table to anon access.
alter table appointment_services enable row level security;
