-- ============================================================
-- Blades & Ash Studio — Payments ledger
-- Run this in the Supabase SQL Editor on the existing project.
-- Idempotent: safe to run more than once.
--
-- Adds a `payments` table: one row per payment event (cash, card, check), the
-- auditable source of truth for money collected. `appointments.amount_paid_cents`
-- becomes a cached SUM of these rows. This lets cash and Stripe card payments
-- live in one ledger that reconciles against Stripe payouts and the bank.
-- ============================================================

create table if not exists payments (
  id uuid default gen_random_uuid() primary key,
  appointment_id uuid references appointments(id) on delete set null,
  client_id uuid references profiles(id) on delete set null,
  -- positive = money collected, negative = refund/correction
  amount_cents int not null,
  method text not null check (method in ('card', 'cash', 'check', 'other')),
  kind text not null default 'payment' check (kind in ('payment', 'fee', 'refund')),
  -- Set for Stripe card payments so a row ties to a specific Stripe charge.
  stripe_payment_intent_id text,
  note text,
  -- Who recorded it (admin who logged a cash payment); null = automated (Stripe).
  recorded_by uuid references profiles(id) on delete set null,
  created_at timestamptz default now()
);

-- One ledger row per Stripe PaymentIntent — makes retried webhooks and the fee
-- charge idempotent (upsert on conflict does nothing).
create unique index if not exists payments_stripe_pi_unique
  on payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create index if not exists payments_appointment_idx on payments (appointment_id);
create index if not exists payments_created_idx on payments (created_at);

-- Server-only: the service-role key bypasses RLS. Enable RLS with no policies
-- so the table is closed to anon/auth clients (mirrors appointment_services).
alter table payments enable row level security;

-- Backfill the ledger from money already recorded on appointments, so it's
-- complete from day one. All historical collection ran through Stripe (card).
-- Guarded so re-running the migration doesn't duplicate rows.
insert into payments (appointment_id, client_id, amount_cents, method, kind, note, created_at)
select a.id, a.client_id, a.amount_paid_cents, 'card', 'payment',
       'Historical (pre-ledger backfill)', a.created_at
from appointments a
where coalesce(a.amount_paid_cents, 0) > 0
  and not exists (select 1 from payments p where p.appointment_id = a.id);
