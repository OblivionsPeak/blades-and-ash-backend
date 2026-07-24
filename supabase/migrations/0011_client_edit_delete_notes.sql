-- ============================================================
-- 0011: Client editing, deletion, and service notes
--
-- 1. client_service_notes — the salon's private notes on a client
--    ("used 6N + 20vol, 45 min processing"). One row per note so the
--    history reads like a timeline. Distinct from the per-appointment
--    notes/client_notes columns on appointments. RLS is enabled with
--    no policies: all access is through the API (service-role client,
--    which bypasses RLS) and notes are never shown to clients.
--
-- 2. appointments.client_id becomes ON DELETE SET NULL so a client
--    can be deleted without destroying appointment history. The API
--    copies the client's name/phone into the guest_* columns before
--    deleting, so past appointments stay readable. (payments.client_id
--    is already ON DELETE SET NULL.)
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists client_service_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id) on delete cascade,
  -- Who wrote it. Kept if the author's account is ever removed.
  author_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz default now()
);

create index if not exists idx_client_service_notes_client
  on client_service_notes (client_id, created_at desc);

alter table client_service_notes enable row level security;

-- Keep the constraint name: PostgREST join hints in the API reference
-- profiles!appointments_client_id_fkey.
alter table appointments drop constraint if exists appointments_client_id_fkey;
alter table appointments add constraint appointments_client_id_fkey
  foreign key (client_id) references profiles(id) on delete set null;
