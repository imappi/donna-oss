-- 131 — a live document match and a bank-line disposition verdict can never
-- coexist on the same line (the verdict fence).
--
-- Migration 028's own law: "a live match row always outranks this stamp". The
-- write plane never enforced it, and the burst regime (a fresh book imported
-- all at once — every onboarding's first hour) exposed the race on
-- 2026-08-31: the disposition sweep's candidate scan snapshots bare lines,
-- the strong-model call takes ~20s, and a document matcher minting a match
-- mid-flight does not retract the in-flight verdict (Honeybee LAND LEASE:
-- match minted 23:32:14, stale `no_match · receipt_needed` stamped 23:32:34 —
-- the card then asked the owner for a lease document already on file and
-- matched). The sweep's scan-time exclusion only covers the opposite order.
--
-- Fix, at the write plane so every reader stays untouched (the projection,
-- the SQL hanging count, the feed summarizer keep their exact semantics):
-- whenever a live (suggested/auto_matched/confirmed) non-bank_line match
-- exists for a line, the line's bank_line_disposition evaluation row is
-- SUPERSEDED — verdict 'superseded', prior verdict/payload preserved inside
-- the new payload, and an audit receipt in the writer's transaction (nothing
-- silent). Both interleavings are fenced: a match minting over a stale stamp
-- (trigger on reconciliation_matches), and a stamp landing over a live match
-- (trigger on reconciliation_evaluations). Downstream effects fall out of the
-- payload replacement: payload->>'disposition' disappears so the convergence
-- projection and the hanging-count SQL stop binding on the verdict, and
-- payload->>'policy_version' disappears so the sweep's incremental guard
-- re-evaluates the line if it ever becomes bare again (a rejected match).
--
-- This does NOT terminalize anything: a line with a suggested match stays
-- hanging (firm-side limbo) under the two-terminal principle — the fence only
-- removes the stale contradictory verdict so the hang is attributed honestly.

create or replace function supersede_bank_line_disposition_for_match(
  fence_firm_id text,
  fence_client_id text,
  fence_bank_transaction_id text,
  fence_match_id text
) returns void
  language plpgsql as $$
declare
  evaluation reconciliation_evaluations%rowtype;
begin
  if fence_firm_id is null or fence_client_id is null or fence_bank_transaction_id is null then
    return;
  end if;
  select * into evaluation
    from reconciliation_evaluations
   where firm_id = fence_firm_id
     and client_id = fence_client_id
     and target_type = 'transaction'
     and target_id = fence_bank_transaction_id
     and matcher_family = 'bank_line_disposition'
     and verdict <> 'superseded'
   for update;
  if not found then
    return;
  end if;

  update reconciliation_evaluations
     set verdict = 'superseded',
         unmatchable_reason = null,
         payload = jsonb_build_object(
           'superseded_by_match_id', fence_match_id,
           'superseded_at', now(),
           'prior_verdict', evaluation.verdict,
           'prior_payload', evaluation.payload
         ),
         evaluated_at = now()
   where id = evaluation.id;

  insert into audit_events
    (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
  values
    (fence_firm_id, fence_client_id, 'system', 'reconciliationVerdictFence',
     'reconciliation.disposition.superseded_by_match',
     'reconciliation_evaluation', evaluation.id,
     jsonb_build_object(
       'contract_version', 'donna.disposition-supersede.v1',
       'bank_transaction_id', fence_bank_transaction_id,
       'match_id', fence_match_id,
       'prior_verdict', evaluation.verdict,
       'prior_disposition', evaluation.payload->>'disposition'
     ));
end;
$$;

-- Interleaving 1: a match mints (or re-arms) over a stale stamp. Only a live
-- non-bank_line match owns a line — the same exclusion the disposition
-- producer applies at scan time (bankLineDispositionLlm.js step 2).
create or replace function supersede_disposition_from_match() returns trigger
  language plpgsql as $$
begin
  if new.matched_object_type is distinct from 'bank_line'
     and new.status in ('suggested', 'auto_matched', 'confirmed')
     and new.bank_transaction_id is not null then
    perform supersede_bank_line_disposition_for_match(
      new.firm_id, new.client_id, new.bank_transaction_id, new.id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists reconciliation_matches_supersede_disposition on reconciliation_matches;
create trigger reconciliation_matches_supersede_disposition
  after insert or update of status on reconciliation_matches
  for each row execute function supersede_disposition_from_match();

-- Interleaving 2: a stamp lands while a live match already owns the line
-- (the sweep's scan predates the match; the stamp commits after). The stamp
-- is born superseded. The early return on verdict 'superseded' also breaks
-- the recursion when the fence function's own UPDATE re-fires this trigger.
create or replace function supersede_disposition_on_stamp() returns trigger
  language plpgsql as $$
declare
  live_match_id text;
begin
  if new.matcher_family <> 'bank_line_disposition'
     or new.target_type <> 'transaction'
     or new.verdict = 'superseded' then
    return new;
  end if;
  select id into live_match_id
    from reconciliation_matches
   where firm_id = new.firm_id
     and client_id = new.client_id
     and bank_transaction_id = new.target_id
     and matched_object_type is distinct from 'bank_line'
     and status in ('suggested', 'auto_matched', 'confirmed')
   order by created_at desc, id desc
   limit 1;
  if live_match_id is not null then
    perform supersede_bank_line_disposition_for_match(
      new.firm_id, new.client_id, new.target_id, live_match_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists reconciliation_evaluations_supersede_on_stamp on reconciliation_evaluations;
create trigger reconciliation_evaluations_supersede_on_stamp
  after insert or update on reconciliation_evaluations
  for each row execute function supersede_disposition_on_stamp();

-- Data fix: supersede every existing stale stamp that already coexists with a
-- live document match (each gets its own audit receipt via the function).
do $$
declare
  stale record;
begin
  for stale in
    select distinct on (e.id)
           e.firm_id, e.client_id, e.target_id, m.id as match_id
      from reconciliation_evaluations e
      join reconciliation_matches m
        on m.firm_id = e.firm_id
       and m.client_id = e.client_id
       and m.bank_transaction_id = e.target_id
       and m.matched_object_type is distinct from 'bank_line'
       and m.status in ('suggested', 'auto_matched', 'confirmed')
     where e.matcher_family = 'bank_line_disposition'
       and e.target_type = 'transaction'
       and e.verdict <> 'superseded'
     order by e.id, m.created_at desc, m.id desc
  loop
    perform supersede_bank_line_disposition_for_match(
      stale.firm_id, stale.client_id, stale.target_id, stale.match_id
    );
  end loop;
end;
$$;
