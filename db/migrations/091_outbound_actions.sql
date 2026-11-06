-- 091 — Outbound actions M0.3/M0.4 (G2 + G3 + G10): the action pipeline.
-- docs/design-donna-outbound-actions-execution-plan.md A1–A3; assembled on the
-- operator-contract shapes (034 — an outbound send is one more consequence; the
-- receipt is the consequence-diff's home) with receipts at the marketing bar
-- (050 — approver, authority, model id, exact content, provider message id).
--
-- Two-terminal-states for actions: a row RESTS only as
--   - executed / cancelled (terminal, receipted), or
--   - hold_for_approval (on the OWNER — the G9 digest surface).
-- scheduled / approved are transient hops the sweep drains; executing is a
-- short-lived provider-call lease (a stale lease is a MUST-REVIEW surface,
-- never silently retried — a possibly-sent send is not re-sent); failed is a
-- provider refusal awaiting deliberate re-mint (surfaced, never auto-retried
-- in M0).
--
-- Gate verdicts (M0.4, A2): auto_execute | hold_for_approval | blocked.
-- 'hold_for_internal_review' is RESERVED-UNUSED pending Kari's D1 call
-- (recommendation: owner-approve + earned auto only — the no-pod self-service
-- doctrine, 2026-07-23). The value exists in the CHECK so choosing an internal
-- lane later is a data change, not a retrofit; NOTHING writes it today.
--
-- Everything dies with its client via the client_id FK cascade (040/090
-- convention). RLS-native. Receipts are append-only.

create table if not exists outbound_actions (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- CLOSED action-type enum (the chat-surface discipline). Phase-1 set;
  -- actions #6–#20 are new enum values + templates, zero new pipeline.
  action_type text not null
    check (action_type in ('issue_invoice', 'send_quote', 'send_receivable_reminder', 'send_payable_notice')),
  target_party_id text not null references client_parties(id) on delete cascade,
  -- The document/invoice the action is about.
  anchor_type text not null,
  anchor_id text not null,
  -- Pack-supplied rendering inputs (A6/A7): pack id, template id, language,
  -- and the value map the renderer resolves. NO rendered content here — the
  -- exact content lives on the receipt at send time.
  pack_id text not null,
  template text,
  language text,
  payload jsonb not null default '{}'::jsonb,
  amount numeric,
  currency text,
  confidence numeric,
  gate_verdict text
    check (gate_verdict is null or gate_verdict in (
      'auto_execute', 'hold_for_approval', 'blocked', 'hold_for_internal_review'
    )),
  gate_basis jsonb not null default '{}'::jsonb,
  status text not null default 'hold_for_approval'
    check (status in (
      'scheduled', 'hold_for_approval', 'approved', 'executing',
      'executed', 'cancelled', 'failed'
    )),
  scheduled_for timestamptz,
  cadence_step integer,
  -- Deterministic idempotency (A3): (client, action_type, target, anchor,
  -- step) — the unique index makes a duplicate mint a no-op.
  idempotency_key text not null,
  claimed_at timestamptz,
  cancel_reason text,
  send_error text,
  approved_by_actor_type text,
  approved_by_actor_id text,
  approved_at timestamptz,
  created_by text not null default 'system',
  model text,
  config_snapshot_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists outbound_actions_idempotency_idx
  on outbound_actions(firm_id, client_id, idempotency_key);
-- The due-sweep scan: claimable work in claimable states.
create index if not exists outbound_actions_due_idx
  on outbound_actions(firm_id, client_id, status, scheduled_for);
create index if not exists outbound_actions_party_idx
  on outbound_actions(target_party_id, action_type);
create index if not exists outbound_actions_anchor_idx
  on outbound_actions(firm_id, client_id, anchor_type, anchor_id);

-- Append-only send/outcome receipts at the marketing bar (050): who approved,
-- under what authority, which model (or deterministic renderer) produced the
-- content, the EXACT content, the provider message id — plus the checks the
-- executor ran (the consequence-diff). Cancels are receipted too (A3: a
-- cancel is a terminal, not a silent skip).
create table if not exists outbound_action_receipts (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  action_id text not null references outbound_actions(id) on delete cascade,
  action_type text not null,
  target_party_id text,
  channel text not null,
  recipient text,
  outcome text not null
    check (outcome in ('sent', 'cancelled', 'refused', 'failed')),
  reason text,
  -- Attribution (NOT NULL — risk #3: the outbound pipeline meets the bar from
  -- day one, independent of the global audit-spine fix).
  approved_by text not null,
  authority text not null,
  model text not null,
  rendered_subject text,
  rendered_body text,
  provider_message_id text,
  checks jsonb not null default '[]'::jsonb,
  config_snapshot_id text,
  created_at timestamptz not null default now()
);

create index if not exists outbound_action_receipts_action_idx
  on outbound_action_receipts(action_id);
create index if not exists outbound_action_receipts_client_idx
  on outbound_action_receipts(firm_id, client_id, created_at desc);

-- Counterparty-level suppression, scoped per client (the same address may be
-- another client's counterparty who did not unsubscribe). Checked at mint AND
-- send (A3), alongside party-level do_not_contact. Writer-normalized reason
-- (unsubscribed | bounced | complaint | manual) — no CHECK, mirroring 050's
-- posture: a new source must never reject a suppress.
create table if not exists outbound_suppression (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  channel_kind text not null,
  normalized_value text not null,
  reason text not null default 'manual',
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create unique index if not exists outbound_suppression_value_idx
  on outbound_suppression(firm_id, client_id, channel_kind, normalized_value);

-- ── RLS-native (mirror 090) ──────────────────────────────────────────────────
alter table outbound_actions enable row level security;
alter table outbound_action_receipts enable row level security;
alter table outbound_suppression enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on outbound_actions, outbound_action_receipts, outbound_suppression from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on outbound_actions, outbound_action_receipts, outbound_suppression from authenticated;
  end if;
end $$;
