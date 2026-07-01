-- ============================================================
-- 0010: Partial-day time off
--
-- staff_time_off (0009) could only block whole days. This adds an
-- optional time window so a stylist can block a *section* of a day
-- (e.g. "out 12:00–14:00 for an appointment") instead of the whole
-- thing.
--
--   start_time / end_time NULL      -> whole-day block (unchanged;
--                                      existing rows stay whole-day)
--   start_time / end_time both set  -> block only [start_time, end_time)
--                                      (salon wall-clock) on each date in
--                                      the [start_date, end_date] range
--
-- Idempotent.
-- ============================================================

alter table staff_time_off
  add column if not exists start_time time,
  add column if not exists end_time   time;

-- Both times must be present together, and end must be after start.
-- (NULL/NULL passes -> whole-day block.)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'staff_time_off_partial_window_chk'
  ) then
    alter table staff_time_off
      add constraint staff_time_off_partial_window_chk check (
        (start_time is null and end_time is null)
        or (start_time is not null and end_time is not null and end_time > start_time)
      );
  end if;
end $$;
