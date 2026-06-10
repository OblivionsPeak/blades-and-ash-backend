-- ============================================================
-- Blades & Ash Studio — Security Hardening Migration
-- Run this in the Supabase SQL Editor on the existing project.
-- Safe to run more than once (drops policies before recreating).
--
-- Fixes:
--   1. Privilege escalation — clients could set their own role to admin
--   2. Free bookings — clients could insert confirmed/paid appointments directly
--   3. PII exposure — every client's name + phone was world-readable
--   4. Double-booking race — adds a DB-level overlap constraint
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- Helper: read the caller's role WITHOUT triggering RLS on
-- profiles (a normal subquery on profiles inside a profiles
-- policy causes infinite recursion). SECURITY DEFINER runs as
-- the owner and bypasses RLS.
-- ──────────────────────────────────────────────────────────
create or replace function public.current_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to authenticated;

-- ──────────────────────────────────────────────────────────
-- PROFILES
-- ──────────────────────────────────────────────────────────
drop policy if exists "Public profiles readable" on profiles;
drop policy if exists "Own profile editable"     on profiles;
drop policy if exists "Profiles select"          on profiles;
drop policy if exists "Own profile update"       on profiles;

-- Fix #3: clients see only their own profile; staff/admin see all.
-- (Public booking UI gets staff names via the API's service-role client,
--  so no anonymous read of profiles is needed here.)
create policy "Profiles select"
  on profiles for select
  using (
    auth.uid() = id
    or public.current_user_role() in ('staff', 'admin')
  );

-- Fix #1: a user may edit their own profile but may NOT change their role.
-- Comparing the new role to current_user_role() (their stored role) blocks
-- self-promotion. Admins change roles through the API (service role, which
-- bypasses RLS), so no client-side path can escalate.
create policy "Own profile update"
  on profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = public.current_user_role()
  );

-- ──────────────────────────────────────────────────────────
-- APPOINTMENTS
-- ──────────────────────────────────────────────────────────
-- Fix #2: a direct client insert may only create an unpaid, pending
-- request for themselves. Real pricing, deposits, confirmation and
-- double-book checks all run in the API (service role bypasses this).
drop policy if exists "Authenticated can create appointments" on appointments;
drop policy if exists "Client creates pending appointment"     on appointments;

create policy "Client creates pending appointment"
  on appointments for insert
  with check (
    auth.uid() = client_id
    and status = 'pending'
    and coalesce(amount_paid_cents, 0) = 0
    and coalesce(deposit_cents, 0) >= 0
  );

-- Fix #4: database-level guarantee that one stylist can't hold two
-- overlapping (non-cancelled) appointments, even under a race between
-- two simultaneous bookings. The API keeps its friendly pre-check; this
-- is the backstop that actually enforces it.
create extension if not exists btree_gist;

alter table appointments
  drop constraint if exists appointments_no_overlap;

alter table appointments
  add constraint appointments_no_overlap
  exclude using gist (
    staff_id with =,
    tstzrange(start_time, end_time) with &&
  ) where (status <> 'cancelled');

-- ──────────────────────────────────────────────────────────
-- REMINDERS — enable RLS with no policies. Server uses the service
-- role key (bypasses RLS); this just closes the table to anon access.
-- ──────────────────────────────────────────────────────────
alter table reminders enable row level security;
