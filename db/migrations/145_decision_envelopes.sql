-- 145 — DMEM-R1 W2 (audit §4.3 reservation 145): the immutable pre-action
-- decision envelope, the ordered post-action result receipts, and the reference
-- from `llm_decisions` to its envelope.
--
-- ADDITIVE ONLY, DARK. No consequential path on this tree writes an envelope yet
-- (W4 wires the coder, the matcher and the owner turn — audit §4.5); the tables
-- exist so the receipts W4 writes have a home whose immutability the DATABASE
-- guarantees, and so `llm_decisions.envelope_id` / `pre_action_envelope_digest`
-- are on the row the moment a writer can fill them (the S12 fixture's L3 layer
-- reads these two columns).
--
-- The contract (doctrine INV-10 / INV-28; MX-1's receipt shapes,
-- docs/session-handoff-2026-09-04-dmem-mx1.md §2, are what these rows must be
-- expressible in — ordinals 1..n, digests over canonical JSON, closed vocabularies):
--   decision_envelopes  the FULL pre-action envelope, persisted BEFORE the action:
--                       scope, purpose, principal / ACL, as-of + decision time,
--                       build / schema / configuration identity, model lane +
--                       prompt version + tool protocol, the claim / source
--                       generations and memory refs used, and the NESTED canonical
--                       outbound payload or deterministic evaluated input with its
--                       own digest (`input_digest`). `envelope_digest` covers the
--                       whole envelope minus itself and is therefore DISTINCT from
--                       `input_digest` (INV-28). Immutable: the only UPDATE the
--                       trigger admits is the privacy-erasure scrub (input_payload
--                       → null, erased_at stamped, everything else byte-identical),
--                       so exact replay can honestly answer
--                       `historical_input_erased` (doctrine §2.7) instead of
--                       fabricating. DELETE only as the tail of the firm cascade.
--   decision_results    the ordered post-action receipts bound to ONE envelope:
--                       attempt / tool_turn / response / decision / application /
--                       accounting_outcome, ordinals exactly 1..n per envelope.
--                       For an 'attempt' the adapter's captured input digest MUST
--                       equal the envelope's input_digest (INV-28: "the capture of
--                       bytes actually sent must equal the nested digest") — refused
--                       otherwise. Same immutability as the envelope; a result's
--                       firm is its envelope's firm.
--   llm_decisions       gains `envelope_id` (the reference) and
--                       `pre_action_envelope_digest` (the digest copy, so a
--                       detached / archived decision stays self-describing). Both
--                       nullable, no backfill: a decision retained WITHOUT them is
--                       exactly LR-4's `historical_context_unavailable` class
--                       (audit §6.3), never reconstructed. Migration 045/129's
--                       freeze trigger covers the new columns automatically
--                       (fail-closed): they are written at insert, before the
--                       action's result, never patched in afterwards.

create table if not exists decision_envelopes (
  envelope_id          text primary key,
  firm_id              text not null references firms(id) on delete cascade,
  -- Plain (the llm_decisions / 129 posture): the client may be detached later.
  client_id            text,
  decision_kind        text not null check (decision_kind in
                         ('coding', 'match', 'disposition', 'ask_draft', 'owner_turn', 'extraction', 'evaluation', 'deterministic')),
  target_type          text,
  target_id            text,
  purpose              text not null,
  principal_type       text,
  principal_id         text,
  acl_digest           text,
  scope                jsonb not null default '{}'::jsonb,
  as_of                timestamptz not null,
  decision_time        timestamptz not null default now(),
  build_commit_sha     text,
  schema_fingerprint   text,
  config_snapshot_id   text,
  model_lane           text,
  model_id             text,
  prompt_version       text,
  tool_protocol        jsonb,
  -- The claim / source generations the decision used: { "<memory_id>": <generation>, ... }.
  claim_generations    jsonb not null default '{}'::jsonb,
  memory_refs          jsonb not null default '[]'::jsonb,
  input_kind           text not null check (input_kind in ('outbound_payload', 'evaluated_input')),
  input_payload        jsonb,
  input_digest         text not null,
  envelope_digest      text not null,
  erased_at            timestamptz,
  created_at           timestamptz not null default now(),
  constraint decision_envelopes_scope_shape check (jsonb_typeof(scope) = 'object'),
  constraint decision_envelopes_generations_shape check (jsonb_typeof(claim_generations) = 'object'),
  constraint decision_envelopes_memory_refs_shape check (jsonb_typeof(memory_refs) = 'array'),
  constraint decision_envelopes_digests_distinct check (input_digest <> envelope_digest),
  constraint decision_envelopes_erased_is_scrubbed check (
    (erased_at is null and input_payload is not null)
    or (erased_at is not null and input_payload is null)
  )
);

create index if not exists decision_envelopes_firm_target_idx
  on decision_envelopes (firm_id, target_type, target_id);
create index if not exists decision_envelopes_firm_client_idx
  on decision_envelopes (firm_id, client_id, decision_time);

create or replace function decision_envelopes_immutable_guard() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from firms where id = old.firm_id) then
      return old;
    end if;
    raise exception
      'decision_envelopes_immutable: DELETE on decision_envelopes is forbidden (DMEM-R1 W2, INV-10) outside the firm cascade — a pre-action envelope is evidence'
      using errcode = 'restrict_violation';
  end if;
  -- The ONE admitted shape: the privacy-erasure scrub.
  if old.erased_at is null and new.erased_at is not null and new.input_payload is null
     and (to_jsonb(old) - array['input_payload', 'erased_at'])
         is not distinct from (to_jsonb(new) - array['input_payload', 'erased_at']) then
    return new;
  end if;
  raise exception
    'decision_envelopes_immutable: UPDATE on decision_envelopes is forbidden (DMEM-R1 W2, INV-28) outside the erasure scrub (input_payload → null, erased_at stamped, nothing else moves)'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists decision_envelopes_immutable on decision_envelopes;
create trigger decision_envelopes_immutable
  before update or delete on decision_envelopes
  for each row execute function decision_envelopes_immutable_guard();

create table if not exists decision_results (
  result_id             text primary key,
  firm_id               text not null references firms(id) on delete cascade,
  envelope_id           text not null references decision_envelopes(envelope_id) on delete cascade,
  ordinal               integer not null check (ordinal >= 1),
  result_kind           text not null check (result_kind in
                          ('attempt', 'tool_turn', 'response', 'decision', 'application', 'accounting_outcome')),
  -- INV-28: what the adapter / evaluator ACTUALLY sent or evaluated.
  adapter_input_digest  text,
  provider              text,
  provider_request_id   text,
  raw_output_digest     text,
  normalized_output_digest text,
  raw_output            jsonb,
  normalized_output     jsonb,
  outcome               text,
  -- The decision / application this receipt binds (llm_decisions id, the domain
  -- writer's ids, the accounting-effect hash).
  decision_ref          jsonb not null default '{}'::jsonb,
  accounting_effect_hash text,
  recorded_at           timestamptz not null default now(),
  erased_at             timestamptz,
  constraint decision_results_decision_ref_shape check (jsonb_typeof(decision_ref) = 'object'),
  constraint decision_results_erased_is_scrubbed check (
    erased_at is null or (raw_output is null and normalized_output is null)
  )
);

create unique index if not exists decision_results_envelope_ordinal_idx
  on decision_results (envelope_id, ordinal);
create index if not exists decision_results_firm_idx
  on decision_results (firm_id, recorded_at);

create or replace function decision_results_guard() returns trigger
  language plpgsql as $$
declare
  env decision_envelopes%rowtype;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from decision_envelopes where envelope_id = old.envelope_id)
       or not exists (select 1 from firms where id = old.firm_id) then
      return old;
    end if;
    raise exception
      'decision_results_immutable: DELETE on decision_results is forbidden (DMEM-R1 W2, INV-10) outside the envelope / firm cascade'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' then
    if old.erased_at is null and new.erased_at is not null
       and new.raw_output is null and new.normalized_output is null
       and (to_jsonb(old) - array['raw_output', 'normalized_output', 'erased_at'])
           is not distinct from (to_jsonb(new) - array['raw_output', 'normalized_output', 'erased_at']) then
      return new;
    end if;
    raise exception
      'decision_results_immutable: UPDATE on decision_results is forbidden (DMEM-R1 W2, INV-28) outside the erasure scrub'
      using errcode = 'restrict_violation';
  end if;
  select * into env from decision_envelopes where envelope_id = new.envelope_id;
  if env.envelope_id is null then
    raise exception
      'decision_results_binding: envelope % does not exist — a result must bind to a persisted pre-action envelope (INV-10)', new.envelope_id
      using errcode = 'foreign_key_violation';
  end if;
  if env.firm_id <> new.firm_id then
    raise exception
      'decision_results_binding: result firm % does not match envelope firm % (INV-12)', new.firm_id, env.firm_id
      using errcode = 'check_violation';
  end if;
  if new.result_kind = 'attempt' and new.adapter_input_digest is not null and new.adapter_input_digest <> env.input_digest then
    raise exception
      'decision_results_binding: the adapter input digest % does not equal the envelope input digest % — what was sent must be what the envelope declared (INV-28)',
      new.adapter_input_digest, env.input_digest
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists decision_results_guard on decision_results;
create trigger decision_results_guard
  before insert or update or delete on decision_results
  for each row execute function decision_results_guard();

-- ── llm_decisions: the reference + the digest copy ───────────────────────────
alter table llm_decisions add column if not exists envelope_id text;
alter table llm_decisions add column if not exists pre_action_envelope_digest text;
create index if not exists llm_decisions_envelope_idx
  on llm_decisions (envelope_id) where envelope_id is not null;

-- ── RLS-native (the 085 posture) ─────────────────────────────────────────────
alter table decision_envelopes enable row level security;
alter table decision_results enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on decision_envelopes from anon;
    revoke all on decision_results from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on decision_envelopes from authenticated;
    revoke all on decision_results from authenticated;
  end if;
end $$;
