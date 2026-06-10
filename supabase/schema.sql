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

create policy "Public profiles readable"
  on profiles for select
  using (true);

create policy "Own profile editable"
  on profiles for update
  using (auth.uid() = id);

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
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  notes text,
  client_notes text,
  stripe_payment_intent_id text,
  stripe_payment_status text,
  total_cents int not null,
  deposit_cents int not null default 0,
  amount_paid_cents int not null default 0,
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

create policy "Authenticated can create appointments"
  on appointments for insert
  with check (auth.uid() = client_id);

create policy "Staff/admin update appointments"
  on appointments for update
  using (
    auth.uid() = staff_id or
    exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

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

-- No RLS needed for reminders — only accessed server-side via service role key
