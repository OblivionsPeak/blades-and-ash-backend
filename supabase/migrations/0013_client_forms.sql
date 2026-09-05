-- ============================================================
-- 0013: Client forms — signed waivers and consultation intakes
--
-- client_forms holds every form a client submits from the website:
--   kind = 'waiver'        the Client Service Agreement, Liability Waiver
--                          & Release, with the drawn signature (PNG data
--                          URL) and the agreement version they signed.
--   kind = 'consultation'  the pre-visit hair consultation questionnaire.
--
-- Rows are append-only from the client's side: a client who fills a form
-- twice gets two rows, newest wins for display. client_id is set when the
-- submitter was signed in, and nulled (not cascaded) if that account is
-- ever deleted — a signed waiver must outlive the account. Name/email/
-- phone are copied onto the row for the same reason, and so guests (no
-- account) can submit too.
--
-- RLS is enabled with no policies: all access goes through the API's
-- service-role client. Clients never read these rows directly.
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists client_forms (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('waiver', 'consultation')),
  client_id uuid references profiles(id) on delete set null,
  client_name text not null,
  client_email text,
  client_phone text,
  -- The answers (consultation) or the acknowledgment details (waiver).
  data jsonb not null default '{}'::jsonb,
  -- Waiver only: PNG data URL of the drawn signature, and which text they signed.
  signature_data_url text,
  agreement_version text,
  -- Where it came from, for the record.
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_client_forms_kind_created
  on client_forms (kind, created_at desc);

create index if not exists idx_client_forms_client
  on client_forms (client_id, created_at desc);

create index if not exists idx_client_forms_email
  on client_forms (lower(client_email));

alter table client_forms enable row level security;
