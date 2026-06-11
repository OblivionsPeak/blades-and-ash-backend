-- ============================================================
-- Blades & Ash Studio — Guest Booking Migration
-- Run this in the Supabase SQL Editor on the existing project.
-- Idempotent: safe to run more than once.
--
-- Adds guest contact columns to appointments so a visitor can book WITHOUT an
-- account. When client_id is null the booking is a guest booking and these
-- columns carry the contact details used for the confirmation email and
-- reminders. client_id is already nullable (no change needed there).
--
-- Guest inserts happen only through the API's service-role client, which
-- bypasses RLS — the existing "Client creates pending appointment" insert
-- policy (which requires auth.uid() = client_id) is unaffected and still
-- governs any direct anon/authenticated inserts.
-- ============================================================

alter table appointments add column if not exists guest_name text;
alter table appointments add column if not exists guest_email text;
alter table appointments add column if not exists guest_phone text;
