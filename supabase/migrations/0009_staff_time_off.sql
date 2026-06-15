-- ============================================================
-- 0009: Staff time off / blocked dates
--
-- A weekly schedule (staff_availability) can't express one-off
-- closures like vacations or holidays. staff_time_off blocks a
-- whole-day date range [start_date, end_date] (inclusive, salon
-- local) during which the stylist has no bookable slots.
--
-- RLS is enabled with no policies: all access is through the API
-- (service-role client, which bypasses RLS). Idempotent.
-- ============================================================

create table if not exists staff_time_off (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text,
  created_at timestamptz default now()
);

create index if not exists idx_staff_time_off_lookup
  on staff_time_off (staff_id, start_date, end_date);

alter table staff_time_off enable row level security;
