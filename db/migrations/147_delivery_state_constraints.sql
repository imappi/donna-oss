-- 147 — DMEM-R1 W2 (audit §4.3 reservation 147): honest delivery state on
-- `client_evidence_requests` — enforced in the database — and the canonical
-- object-ownership identity on `local_evidence_objects`.
--
-- ADDITIVE, DARK, ARMED PER TRANSACTION. The law (INV-14, INV-04; F-11 / S03 /
-- S10): a sent state — `first_sent_at`, `last_sent_at`, `send_count > 0`, or a
-- `request_payload.sent_at` — may exist on an ask ONLY when a channel receipt
-- exists for it: a `message_delivery_ledger` row with `ask_id = the ask` and
-- `sent_at` set (the deliverers write exactly that row after a genuine send,
-- db/channels.js). A sent stamp without a receipt is a lie about delivery, and
-- once this constraint is armed the database refuses it.
--
-- Why armed, not unconditional, in W2: the mint on this tree STILL stamps
-- first_sent_at / last_sent_at at creation (audit F-11 — W1 makes the writers
-- honest; audit §4.2). An unconditional constraint would break the live ask
-- mint today, which is a behaviour change while MEMORY_MODEL_V2 is off. So the
-- constraint follows migration 133's pattern: the law lives HERE, in the
-- database, and a writer arms it for its own transaction with the transaction-
-- local GUC `donna.delivery_state_constraints = 'enforce'`
-- (set_config(..., true) — it cannot outlive the transaction or leak to another
-- connection). memoriesDb.js `armDeliveryStateConstraints` is the one helper
-- that sets it, under the MEMORY_MODEL_V2 posture (the ONE resolver + its kill
-- switch). W6A's cutover makes it unconditional by deleting the GUC test — a
-- one-line change in a follow-up migration, never a second law.
--
-- It is a DEFERRABLE, INITIALLY DEFERRED constraint trigger: the check runs at
-- COMMIT over the row's final state, so a deliverer may stamp and receipt in
-- either order inside one transaction (db/channels.js records the ledger row
-- and then bumps send_count; both shapes pass; a stamp whose receipt never
-- arrives before commit fails the commit).
--
-- local_evidence_objects gains the resolved ownership identity (INV-15: trusted
-- identity is resolved BEFORE object keys are constructed): `owner_firm_id` /
-- `owner_client_id` are the canonical owner of the object independent of the
-- key prefix. Nullable, never backfilled here — LR-3's relocation manifest
-- (audit §4.8) writes them for the mis-keyed demo-prefix objects; new writes
-- fill them when W5 declares the blob copy class.

create or replace function client_evidence_requests_delivery_state_check() returns trigger
  language plpgsql as $$
declare
  ask client_evidence_requests%rowtype;
  claims_sent boolean;
  has_receipt boolean;
begin
  if coalesce(current_setting('donna.delivery_state_constraints', true), '') <> 'enforce' then
    return null;
  end if;
  -- Deferred: evaluate the row as it stands at commit (it may have moved since
  -- the triggering statement, or be gone).
  select * into ask from client_evidence_requests where id = new.id;
  if ask.id is null then
    return null;
  end if;
  claims_sent := ask.first_sent_at is not null
              or ask.last_sent_at is not null
              or coalesce(ask.send_count, 0) > 0
              or nullif(ask.request_payload ->> 'sent_at', '') is not null;
  if not claims_sent then
    return null;
  end if;
  select exists (
    select 1 from message_delivery_ledger l
     where l.ask_id = ask.id and l.sent_at is not null
  ) into has_receipt;
  if not has_receipt then
    raise exception
      'client_evidence_requests_delivery_state: ask % claims a sent state (first_sent_at %, last_sent_at %, send_count %, payload sent_at %) with no channel receipt in message_delivery_ledger — a sent stamp without a delivery is refused (INV-14, DMEM-R1 W2)',
      ask.id, ask.first_sent_at, ask.last_sent_at, ask.send_count, ask.request_payload ->> 'sent_at'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists client_evidence_requests_delivery_state on client_evidence_requests;
create constraint trigger client_evidence_requests_delivery_state
  after insert or update on client_evidence_requests
  deferrable initially deferred
  for each row execute function client_evidence_requests_delivery_state_check();

-- ── canonical object ownership identity ──────────────────────────────────────
alter table local_evidence_objects add column if not exists owner_firm_id text;
alter table local_evidence_objects add column if not exists owner_client_id text;
create index if not exists local_evidence_objects_owner_idx
  on local_evidence_objects (owner_firm_id, owner_client_id) where owner_firm_id is not null;
