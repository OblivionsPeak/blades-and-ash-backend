-- ============================================================
-- Blades & Ash Studio — Supabase Schema
-- Run this in the Supabase SQL Editor for your project.
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ──────────────────────────────────────────────────────────
-- PROFILES (extends auth.users)
-- ──────────────────────────────────────────────────────────
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text not null,
  phone text,
  role text not null default 'client' check (role in ('client', 'staff', 'admin')),
  avatar_url text,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

-- Helper: read the caller's role without triggering RLS recursion on
-- profiles. SECURITY DEFINER runs as owner and bypasses RLS.
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

-- Clients see only their own profile; staff/admin see all. Public booking
-- UI gets staff names via the API (service role), so no anon read here.
create policy "Profiles select"
  on profiles for select
  using (
    auth.uid() = id
    or public.current_user_role() in ('staff', 'admin')
  );

-- A user may edit their own profile but may NOT change their role.
-- Admins change roles through the API (service role bypasses RLS).
create policy "Own profile update"
  on profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = public.current_user_role()
  );

-- Auto-create a profile when a new user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'phone',
    'client'
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ──────────────────────────────────────────────────────────
-- SERVICES
-- ──────────────────────────────────────────────────────────
create table if not exists services (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  duration_minutes int not null default 60,
  price_cents int not null,
  deposit_required boolean default false,
  deposit_cents int,
  category text,
  active boolean default true,
  created_at timestamptz default now()
);

alter table services enable row level security;

create policy "Anyone can read services"
  on services for select
  using (active = true);

create policy "Admin manages services"
  on services for all
  using (
    exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- ──────────────────────────────────────────────────────────
-- STAFF <-> SERVICES MAPPING
-- ──────────────────────────────────────────────────────────
create table if not exists staff_services (
  staff_id uuid references profiles(id) on delete cascade,
  service_id uuid references services(id) on delete cascade,
  primary key (staff_id, service_id)
);

alter table staff_services enable row level security;

create policy "Public read staff_services"
  on staff_services for select
  using (true);

create policy "Admin manages staff_services"
  on staff_services for all
  using (
    exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- ──────────────────────────────────────────────────────────
-- STAFF WEEKLY AVAILABILITY
-- ──────────────────────────────────────────────────────────
create table if not exists staff_availability (
  id uuid default gen_random_uuid() primary key,
  staff_id uuid references profiles(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  unique (staff_id, day_of_week)
);

alter table staff_availability enable row level security;

create policy "Public read availability"
  on staff_availability for select
  using (true);

create policy "Staff edits own availability"
  on staff_availability for all
  using (
    auth.uid() = staff_id or
    exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- ──────────────────────────────────────────────────────────
-- APPOINTMENTS
-- ──────────────────────────────────────────────────────────
create table if not exists appointments (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references profiles(id),
  staff_id uuid references profiles(id),
  service_id uuid references services(id),
  start_time timestamptz not null,
  end_time timestamptz not null,
  -- Guest booking: when client_id is null the appointment was booked without an
  -- account; these hold the guest's contact details for confirmation/reminders.
  guest_name text,
  guest_email text,
  guest_phone text,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  notes text,
  client_notes text,
  stripe_payment_intent_id text,
  stripe_payment_status text,
  total_cents int not null,
  deposit_cents int not null default 0,
  amount_paid_cents int not null default 0,
  -- Code applied by the salon at checkout (admin-applied discounts). Null when
  -- no discount is in effect; the total is always recomputed from the price
  -- snapshot so the code can be changed or removed.
  discount_code text,
  created_at timestamptz default now()
);

alter table appointments enable row level security;

create policy "Client sees own appointments"
  on appointments for select
  using (
    auth.uid() = client_id or
    auth.uid() = staff_id or
    exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- A direct client insert may only create an unpaid, pending request for
-- themselves. Pricing, deposits, confirmation and conflict checks run in
-- the API (service role bypasses this policy).
create policy "Client creates pending appointment"
  on appointments for insert
  with check (
    auth.uid() = client_id
    and status = 'pending'
    and coalesce(amount_paid_cents, 0) = 0
    and coalesce(deposit_cents, 0) >= 0
  );

create policy "Staff/admin update appointments"
  on appointments for update
  using (
    auth.uid() = staff_id or
    exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Database-level guarantee: one stylist cannot hold two overlapping
-- (non-cancelled) appointments, even under a booking race.
create extension if not exists btree_gist;

alter table appointments
  add constraint appointments_no_overlap
  exclude using gist (
    staff_id with =,
    tstzrange(start_time, end_time) with &&
  ) where (status <> 'cancelled');

-- ──────────────────────────────────────────────────────────
-- APPOINTMENT <-> SERVICES (multi-service bookings)
-- ──────────────────────────────────────────────────────────
-- One row per service in an appointment. The appointment runs as one
-- back-to-back time block for a single stylist; price/duration are snapshotted
-- here at booking time. `appointments.service_id` stays the FIRST/primary
-- service so existing single-service joins keep working.
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

-- ──────────────────────────────────────────────────────────
-- DISCOUNTS (promo codes)
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
  -- admin_only codes (e.g. military) are applied by the salon at checkout and
  -- are rejected by the public validate + client payment flows.
  admin_only boolean not null default false,
  created_at timestamptz default now()
);

alter table discounts enable row level security;

-- Reads are public (the booking UI previews codes); writes happen only via the
-- service-role client in the API, which bypasses RLS.
create policy "Public read discounts"
  on discounts for select
  using (true);

-- ──────────────────────────────────────────────────────────
-- PAYMENTS LEDGER
-- ──────────────────────────────────────────────────────────
-- One row per payment event (cash, card, check) — the auditable source of
-- truth for money collected. appointments.amount_paid_cents is a cached SUM of
-- these rows, kept in sync by src/lib/payments.js. Cash and Stripe card
-- payments share this ledger so it reconciles against Stripe payouts + bank.
create table if not exists payments (
  id uuid default gen_random_uuid() primary key,
  appointment_id uuid references appointments(id) on delete set null,
  client_id uuid references profiles(id) on delete set null,
  amount_cents int not null,            -- positive = collected, negative = refund
  method text not null check (method in ('card', 'cash', 'check', 'other')),
  kind text not null default 'payment' check (kind in ('payment', 'fee', 'refund')),
  stripe_payment_intent_id text,
  note text,
  recorded_by uuid references profiles(id) on delete set null,
  created_at timestamptz default now()
);

create unique index if not exists payments_stripe_pi_unique
  on payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create index if not exists payments_appointment_idx on payments (appointment_id);
create index if not exists payments_created_idx on payments (created_at);

-- Server-only (service role bypasses RLS). No policies = closed to anon/auth.
alter table payments enable row level security;

-- ──────────────────────────────────────────────────────────
-- REMINDERS
-- ──────────────────────────────────────────────────────────
create table if not exists reminders (
  id uuid default gen_random_uuid() primary key,
  appointment_id uuid references appointments(id) on delete cascade,
  type text not null check (type in ('24h', '2h')),
  channel text not null check (channel in ('email', 'sms')),
  sent_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  created_at timestamptz default now()
);

-- Reminders are only accessed server-side via the service role key (which
-- bypasses RLS). Enable RLS with no policies to close the table to anon access.
alter table reminders enable row level security;
