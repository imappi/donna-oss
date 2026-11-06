// Donna — the twin-aging → owner-ask lane (Q1's second half; design
// docs/design-2026-07-06-loop-clock-decisions-twin-aging.md §1, Kari's dated
// 3-day answer, 2026-07-06).
//
// The population: reconciliation matches the strong matcher itself judged
// ambiguous — band 'suggested' with the twin reasons ('ambiguous_candidates' /
// 'insufficient_separation') — resting past the aging clock. Confidence ~0.65
// IS the twin verdict: the model already said "I cannot tell which candidate
// settles this line", so asking the OWNER is the fork's unsure branch
// (two-terminal-states, CLAUDE.md). Material holds are EXCLUDED — they reach
// terminal 1 via material_auto_fyi / grants (the Q1 staging runbook), never
// through this lane.
//
// Mechanism — assemble, don't duplicate (the no-third-spine guard):
//   - The GATHER here feeds the EXISTING ask pipeline: aged twin groups join
//     the draft builder's input (firmDb.__draftClientAskBatchWithClient,
//     flag-gated), the strong drafting model writes the "which of these pays
//     this line?" question as an ordinary 'ask' item, and the EXISTING send
//     chokepoint mints the client_evidence_requests row — no new send path,
//     and isSendableDraft counts the twin ask as a genuine question (so a
//     draft whose only other content is FYIs becomes sendable).
//   - The SWEEP here only gives the clock its tick: when aged twins exist and
//     the flag acts, it enqueues the EXISTING 'ask_draft.requested' outbox
//     event (coalesced to one in-flight request per client, gated on the same
//     canary+ proposal_creation authority the post-reconcile producer uses).
//     The dedicated consumer then drafts; the send lane then mints.
//   - The RECEIPT ('reconciliation_match.twin_aged_to_ask' + the match-payload
//     twin_aging marker) is stamped by the send chokepoint in the same
//     transaction as the mint — the mint IS the receipt's trigger. The match
//     rows are NOT re-banded: the open ask is the persisted verdict that moves
//     the line to terminal 2 (reconcileConvergenceState already counts an open
//     ask as on_owner; no projection change).
//
// Deliberately out (per the design): no LLM call in this module (the drafting
// call is the pipeline's own), no re-scoring, no re-banding, no new tables.
//
// Flag, born on the plane (CLAUDE.md rail): RECONCILIATION_TWIN_AGING_ASK via
// clientFlagActs with envFallback () => false — a DB stage row is the ONLY on.
// Ladder: off → shadow (log the would-mint) → canary (Honeybee) → auto.
// The aging window is a tuning knob (RECONCILIATION_TWIN_AGING_ASK_DAYS,
// default 3 — env-legitimate), never a rollout gate.

import {
  clientFlagActs, clientFlagObserves, readClientConfigSnapshot
} from './clientConfig.js';
import { enqueueOutbox } from './loopEventOutbox.js';
import { loopsTablesPresent } from './caseManager.js';
import { decideLoopExecution, readFirmExecutionContext } from './loopExecutionGate.js';
import { ASK_DRAFT_IDENTITY_CONTRACT } from './askPipeline.js';
import { toIsoDay } from './dates.js';
import { BANK_LINE_DISPOSITION_FAMILY, BANK_LINE_DISPOSITION_TARGET_TYPE } from './bankLineDispositionShape.js';

export const TWIN_AGING_ASK_FLAG_KEY = 'RECONCILIATION_TWIN_AGING_ASK';

// Kari's recorded clock (2026-07-06): 3 days at 'suggested', then the twin
// converts to an owner ask. Tuning knob only — the BEHAVIOUR is plane-gated.
export const twinAgingAskDays = (env = process.env) => {
  const n = Number(env?.RECONCILIATION_TWIN_AGING_ASK_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

// The twin gate: the authorization reasons that mean "the matcher itself
// surfaced an ambiguity between candidates" (authorizeMatch Gates B/D).
export const TWIN_AMBIGUITY_REASONS = Object.freeze([
  'ambiguous_candidates',
  'insufficient_separation'
]);

// Material holds never convert to a TWIN ask here (a twin is an ambiguity
// between candidates; a material hold is an authority gap on ONE candidate).
// AMENDED 2026-08-25 (the land-lease sighting, Kari's rule): the earlier
// assumption — "material_auto_fyi / grants drive material holds to terminal 1"
// — left a match with NO acting authority resting at 'suggested' forever, the
// forbidden third state. A material hold now has its OWN lane below
// (gatherHeldMaterialAskGroups): high-confidence, single-candidate, held only
// by authority ⇒ an owner CONFIRM ask, immediately (an authority hold never
// self-resolves, so unlike twins there is no aging clock). Staging decides
// whether the match auto-reconciles; it never decides whether the ask exists.
export const MATERIAL_HOLD_REASONS = Object.freeze([
  'above_materiality_ceiling',
  'materiality_ceiling_unset'
]);

// Does a 'suggested' match's hold have a lane that can still drive it to a
// terminal? The two gathers above ARE the lanes: a material/authority hold
// converts to an owner confirm (gatherHeldMaterialAskGroups), an ambiguity
// ages into a "which of these?" ask (gatherAgedTwinAskGroups). Every OTHER
// withhold reason — `below_floor` above all, the plain "the model wasn't
// confident enough" — has no lane at all: nothing settles it and nothing asks
// about it, so the line rests on NOBODY. That is the forbidden third state,
// and it is invisible because the line looks busy: it HAS a match.
//
// Live sighting (Desert Rose, 2026-09-01): a 238.50 Union Coop receipt matched
// at 0.55 confidence. The suggested match superseded the bank-line disposition
// (killing the drafter's input) AND tripped the coding sweep's
// `doc_match_pending` skip (killing the owner ask), so the only line in the
// book with NO terminal was one Donna had found evidence for. This predicate
// is what lets that skip apply only where a lane actually exists.
//
// RT-21a (2026-09-08, the Kultalanka Nets four): the predicate is the JS twin
// of the two gathers' SQL admission, and it must say what THEY say — not
// "some lane-shaped reason is present". HELD_MATERIAL_SQL admits a match
// whose reasons carry a material hold AND NO twin reason; AGED_TWIN_SQL admits
// a twin reason AND NO material hold. A hold carrying BOTH (the koontilasku
// shape: four weekly settlements each `partial_payment` against one monthly
// statement — `below_floor` + `insufficient_separation` +
// `above_materiality_ceiling`) is admitted by NEITHER gather, so the earlier
// `.some(...)` answered "lane" for a match no lane would ever pick up, and the
// sweep's doc_match_pending skip stood down on it forever: 10 206,48 € of
// February card sales resting on nobody with a correct model read and the
// document in hand. Mirror the admission exactly; a laneless hold then falls
// to rule 3.5 in codingAutoPost.js, which asks the owner to confirm the
// document — an honest terminal until RT-21c–f give the row its own contract.
export const suggestedMatchHasSettleLane = (reasons) => {
  const list = Array.isArray(reasons) ? reasons : [];
  const material = list.some((reason) => MATERIAL_HOLD_REASONS.includes(reason));
  const twin = list.some((reason) => TWIN_AMBIGUITY_REASONS.includes(reason));
  return (material && !twin) || (twin && !material);
};

// ── The stale-ask supersede law (2026-09-01, the Desert Rose February burst) ──
//
// During an upload burst the per-line coding sweep can mint its generic
// "we need a supporting document" ask BEFORE the document parses and matches.
// Once that open request exists, every later, better lane stands down forever:
// the two gathers below exclude the line (their spam guard), the sweep's
// evidence_request_pending skip holds, and the ordinary ask-batch gather skips
// it too — so a line with a 0.96 suggested match carries a stale "please send
// the document" ask, and the confirm/twin question that could settle the match
// can never be asked. Seen ~12× in one February book.
//
// The law: an open ask is SUPERSEDABLE — a better basis arriving later may
// re-feed the line to the drafter, whose send-time mint COLLAPSES onto the
// same request row and refreshes its wording/lane in place (the row is never
// closed, so the line never rests without an open ask — refresh, not orphan) —
// ONLY when ALL of these hold:
//   - it was minted by the per-line sweep (created_by 'coding_auto_post');
//   - it is the GENERIC evidence flavor (evidence_type 'supporting_document').
//     A purpose/fact question (business_purpose, owner_fact, …) is NEVER
//     superseded by evidence arriving: an amount-matched receipt proves a
//     charge exists, not what it was for (the Netflix RCM case) — resolution
//     semantics stay exactly as they are;
//   - it is addressed to the owner (audience 'client');
//   - the owner has NOT replied ('draft'/'open' only). A replied ask belongs
//     to the reply-recode lane, always.
// Anything else keeps blocking exactly as before.
export const SUPERSEDABLE_ASK_CREATED_BY = 'coding_auto_post';
export const SUPERSEDABLE_ASK_EVIDENCE_TYPE = 'supporting_document';

// JS twin of the SQL predicate below — the drafter-input filter and any other
// row-level consumer must agree byte-for-byte with what the gathers admit.
export const isSupersedableAskRow = (row = {}) =>
  ['draft', 'open'].includes(String(row?.status || '')) &&
  String(row?.created_by || '') === SUPERSEDABLE_ASK_CREATED_BY &&
  String(row?.evidence_type || '') === SUPERSEDABLE_ASK_EVIDENCE_TYPE &&
  String(row?.audience || 'client') === 'client';

// RT-21c: both gathers read the matched settlement row (migration 150,
// matched_line_id → document_lines) so a koontilasku row match is asked
// about as THAT row at its net, never as the whole statement. Pre-migration
// the missing column degrades both gathers to empty (42703), as before.
// SQL fragment: does a BLOCKING open ask exist on this bank line? Supersedable
// asks (above) do not block; everything else in ('draft','open','replied')
// still does. Interpolated into the gathers here and into the ask-batch
// candidate + send-time freshness SQL in firmDb.js — one definition so draft
// and send can never disagree about which open asks block (the #1952 lock-step
// law applied to admission).
export const blockingOpenAskExistsSql = ({ firmColumn, transactionColumn }) => `exists (
      select 1 from client_evidence_requests cer
       where cer.firm_id = ${firmColumn}
         and cer.transaction_id = ${transactionColumn}
         and cer.status in ('draft', 'open', 'replied')
         and not (
           cer.status in ('draft', 'open')
           and cer.created_by = '${SUPERSEDABLE_ASK_CREATED_BY}'
           and cer.evidence_type = '${SUPERSEDABLE_ASK_EVIDENCE_TYPE}'
           and coalesce(cer.audience, 'client') = 'client'
         )
    )`;

// ── Ask lifecycle honesty (RT-11, audit F-17; decisions D3 + D4, 2026-09-02) ──
//
// An ask carries the FACT it needs (evidence_type). Only evidence of THAT fact
// resolves it, and every later verdict on the same line re-evaluates the open
// asks against what it actually proved:
//
//   - A document MATCH proves the charge exists and what paper settles it. It
//     answers a document / statement ask (EVIDENCE_RESOLVABLE_ASK_TYPES) and
//     NOTHING else: "wholly for the café rather than personal?" is not answered
//     by an amount-matched receipt (round-4 §B — Union Coop / Amazon, closed by
//     a receipt and posted). reconciliationTriage.cascadeAutoMatch applies this:
//     a purpose ask stays OPEN with the match recorded on it so the drafter can
//     shorten the question to "we have the receipt — was it business?".
//   - Donna's OWN auto_explain ("clearly business, immaterial, needs no receipt
//     and no human") answers both the purpose and the document question on that
//     line (AUTO_EXPLAIN_RETRACTABLE_ASK_TYPES): an open ask of either kind is
//     RETRACTED, receipted, and told to the owner through the retraction lane.
//     Never a replied ask (the reply lane owns it), never an owner-fact /
//     statement-coverage / treatment ask (an equity movement is not operating
//     noise; coverage is not about the line), never a line the Keep layer
//     downgraded (material), never a line a DOCUMENT explained (the match law).
//
// Both are Keep-layer bookkeeping over PERSISTED verdicts (render the verdict,
// never re-infer): the retraction reads the disposition row the strong model
// already wrote and the tx stamp that settled the line.
//
// Flags, born on the plane (CLAUDE.md rail; envFallback () => false; seeded
// auto on desktop — hostPlaneSeed.js, admitted-entity-profiles.json):
//   - RECONCILE_AUTO_EXPLAIN_RETRACTS — may an auto_explain retract an open ask
//     (D4). No row / off: nothing. shadow: the would-retract is receipted.
//     canary / auto: retract + receipt (client_evidence_request.retracted).
//   - RECONCILE_RETRACTION_AUTOSEND — may the retraction lane tell the owner
//     "you can ignore what we asked" on its own (the former
//     RECONCILE_RETRACTION_AUTOSEND_ENABLED env pair, converted here; env can
//     only KILL it through CLIENT_CONFIG_FORCE_DISABLE, never enable it).
export const AUTO_EXPLAIN_RETRACTS_FLAG_KEY = 'RECONCILE_AUTO_EXPLAIN_RETRACTS';
export const RETRACTION_AUTOSEND_FLAG_KEY = 'RECONCILE_RETRACTION_AUTOSEND';
export const EVIDENCE_RESOLVABLE_ASK_TYPES = Object.freeze(['supporting_document', 'bank_statement']);
export const AUTO_EXPLAIN_RETRACTABLE_ASK_TYPES = Object.freeze(['business_purpose', 'supporting_document']);

// transactions.reconciliation_status values that mean the bank line is SETTLED
// (the same set codingAutoPost / reconcileConvergenceState read). A settled
// line is never asked about: the ask-batch draft gather and the send-time
// freshness check in firmDb.js both interpolate this fragment (the #1952
// lock-step law), so a line Donna auto-explains between draft and send goes
// STALE at send (superseded + re-drafted — the #1959 treatment) instead of
// minting a question about a line she already settled.
export const SETTLED_BANK_LINE_STATUSES = Object.freeze(['explained', 'auto_reconciled', 'reconciled', 'posted']);
export const settledBankLineSql = ({ statusColumn }) =>
  `coalesce(${statusColumn}, '') in (${SETTLED_BANK_LINE_STATUSES.map((s) => `'${s}'`).join(', ')})`;

const RETRACTION_ROW_LIMIT = 100;
const clampText = (value, max) => String(value || '').slice(0, max);

// The D4 candidates: open owner asks of a retractable kind whose line Donna
// settled with an IMMATERIAL auto_explain — the disposition pass's verdict row
// (auto_explained, disposition auto_explain, materiality immaterial, not
// downgraded by the F1 ceiling) behind the tx stamp, or the retired
// classifier's own stamp (bank_line_auto_explained: immaterial by its rule). A
// line a DOCUMENT explained is excluded (any live non-bank_line match). In
// observe mode the once-guard is the would_retract receipt itself.
const AUTO_EXPLAIN_RETRACTION_SQL = `
  select cer.id as request_id, cer.transaction_id, cer.evidence_type, cer.status as ask_status,
         cer.created_by,
         coalesce(t.payload->>'bank_line_disposition_explained', '') = 'true' as disposition_explained,
         coalesce(t.payload->>'bank_line_auto_explained', '') = 'true' as classifier_explained,
         e.id as evaluation_id, e.model as evaluation_model,
         e.payload->>'disposition' as disposition,
         e.payload->>'materiality' as materiality,
         e.payload->>'confidence' as confidence,
         e.payload->>'reasoning' as reasoning
  from client_evidence_requests cer
  join transactions t on t.id = cer.transaction_id and t.firm_id = cer.firm_id
  left join reconciliation_evaluations e
    on e.firm_id = t.firm_id and e.client_id = t.client_id
   and e.target_type = $3 and e.matcher_family = $4 and e.target_id = t.id
  where cer.firm_id = $1
    and cer.client_id = $2
    and cer.transaction_id is not null
    and cer.status in ('draft', 'open')
    and coalesce(cer.audience, 'client') = 'client'
    and cer.evidence_type = any($5::text[])
    and t.reconciliation_status = 'explained'
    -- Naming a statutory payment does not supply the filing required by coding.
    and coalesce(t.payload->>'bank_line_disposition', '') <> 'statutory_payment'
    and coalesce(e.payload->>'disposition', '') <> 'statutory_payment'
    and coalesce(t.payload->'ai_suggestion'->>'posting_requirement','') not in ('owner_fact','payroll_package','document_discrepancy')
    and (
      (
        coalesce(t.payload->>'bank_line_disposition_explained', '') = 'true'
        and e.verdict = 'auto_explained'
        and coalesce(e.payload->>'disposition', '') = 'auto_explain'
        and coalesce(e.payload->>'materiality', '') = 'immaterial'
        and coalesce(e.payload->>'downgraded_from', '') = ''
      )
      or coalesce(t.payload->>'bank_line_auto_explained', '') = 'true'
    )
    and not exists (
      select 1 from reconciliation_matches rm
       where rm.firm_id = t.firm_id
         and rm.bank_transaction_id = t.id
         and rm.matched_object_type <> 'bank_line'
         and rm.status in ('suggested', 'auto_matched', 'confirmed')
    )
    and (
      $6::boolean
      or not exists (
        select 1 from audit_events a
         where a.firm_id = cer.firm_id
           and a.action = 'client_evidence_request.would_retract'
           and a.resource_id = cer.id
      )
    )
  order by cer.created_at asc, cer.id asc
  limit $7`;

// One atomic statement per retraction: the status flip and its receipt land
// together whether the caller holds a transaction (the draft builder) or runs
// untransacted (the disposition sweep, the loop drain) — an ask can never be
// closed without its receipt (nothing silent).
const RETRACT_ONE_SQL = `
  with retracted as (
    update client_evidence_requests
       set status = 'resolved',
           resolved_at = now(),
           resolved_by = 'system',
           response_payload = coalesce(response_payload, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
     where firm_id = $1 and id = $2 and status in ('draft', 'open')
     returning id
  )
  insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
  select $1, $4, 'system', 'client_evidence_request.retracted', 'client_evidence_request', r.id, $5::jsonb
    from retracted r
  returning resource_id`;

// Keep the tx payload's embedded evidence_request copy consistent (the table row
// is authoritative; a stale copy confuses other readers) — only when the copy
// is the retracted ask (by id, or by kind when the copy carries no id).
const RETRACT_TX_COPY_SQL = `
  update transactions
     set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{evidence_request,status}', '"resolved"'),
         updated_at = now()
   where id = $1 and firm_id = $2
     and payload->'evidence_request'->>'status' in ('draft', 'open', 'replied')
     and (
       payload->'evidence_request'->>'id' = $3
       or (
         coalesce(payload->'evidence_request'->>'id', '') = ''
         and coalesce(payload->'evidence_request'->>'evidence_type', '') = $4
       )
     )`;

// Re-evaluate one client's open asks against Donna's own auto_explain verdicts
// (D4). Idempotent — a retracted ask is no longer open; an observed ask carries
// its would_retract receipt. Returns the ids it touched so callers can count.
// Soft-fails to "skipped" on a pre-migration schema, never breaks the sweep or
// the draft that runs it.
export const retractAsksSettledByAutoExplain = async (client, {
  firmId, clientId, configSnapshot = null, env = process.env, rowLimit = RETRACTION_ROW_LIMIT
} = {}) => {
  const empty = {
    skipped: true, reason: 'missing_ids', acts: false, observes: false,
    candidates: 0, truncated: false, retracted_request_ids: [], observed_request_ids: []
  };
  if (!client || !firmId || !clientId) return empty;
  const acts = clientFlagActs({
    flagKey: AUTO_EXPLAIN_RETRACTS_FLAG_KEY, snapshot: configSnapshot, envFallback: () => false, env
  });
  const observes = clientFlagObserves({
    flagKey: AUTO_EXPLAIN_RETRACTS_FLAG_KEY, snapshot: configSnapshot, envFallback: () => false, env
  });
  if (!acts && !observes) return { ...empty, reason: 'flag_off' };
  const flagRow = configSnapshot && typeof configSnapshot === 'object'
    ? configSnapshot[AUTO_EXPLAIN_RETRACTS_FLAG_KEY] || null
    : null;
  const bounded = Math.min(Math.max(Number(rowLimit) || RETRACTION_ROW_LIMIT, 1), 500);
  let result;
  try {
    result = await client.query(AUTO_EXPLAIN_RETRACTION_SQL, [
      firmId, clientId, BANK_LINE_DISPOSITION_TARGET_TYPE, BANK_LINE_DISPOSITION_FAMILY,
      [...AUTO_EXPLAIN_RETRACTABLE_ASK_TYPES], acts, bounded
    ]);
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return { ...empty, reason: 'tables_absent', acts, observes };
    throw error;
  }
  const rows = result.rows || [];
  const retracted = [];
  const observed = [];
  for (const row of rows) {
    const source = row.disposition_explained ? 'bank_line_disposition' : 'bank_line_auto_explain';
    const confidence = row.confidence == null ? NaN : Number(row.confidence);
    const receipt = {
      transaction_id: row.transaction_id,
      evidence_type: row.evidence_type,
      ask_status: row.ask_status,
      created_by: row.created_by || null,
      retracted_by: row.disposition_explained && row.disposition === 'statutory_payment' ? 'statutory_payment' : 'auto_explain',
      retraction_source: source,
      evaluation_id: row.disposition_explained ? (row.evaluation_id || null) : null,
      model: row.disposition_explained ? (row.evaluation_model || null) : null,
      materiality: row.disposition_explained ? (row.materiality || null) : 'rule_immaterial',
      confidence: row.disposition_explained && Number.isFinite(confidence) ? confidence : null,
      reasoning: row.disposition_explained ? clampText(row.reasoning, 300) : '',
      flag_stage: flagRow?.stage || null,
      flag_source: flagRow?.source || null
    };
    if (!acts) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'client_evidence_request.would_retract', 'client_evidence_request', $3, $4::jsonb)`,
        [firmId, clientId, row.request_id, JSON.stringify(receipt)]
      );
      observed.push(row.request_id);
      continue;
    }
    const retractedAt = new Date().toISOString();
    const stamped = await client.query(RETRACT_ONE_SQL, [
      firmId,
      row.request_id,
      JSON.stringify({
        retracted: true,
        retracted_by: row.disposition_explained && row.disposition === 'statutory_payment' ? 'statutory_payment' : 'auto_explain',
        retraction_source: source,
        retraction_evaluation_id: receipt.evaluation_id,
        retraction_model: receipt.model,
        retracted_at: retractedAt
      }),
      clientId,
      JSON.stringify({ ...receipt, retracted_at: retractedAt })
    ]);
    if (!(stamped.rows || []).length) continue; // lost a race — the ask is no longer open
    await client.query(RETRACT_TX_COPY_SQL, [row.transaction_id, firmId, row.request_id, row.evidence_type]);
    retracted.push(row.request_id);
  }
  return {
    skipped: false, reason: null, acts, observes,
    candidates: rows.length, truncated: rows.length >= bounded,
    retracted_request_ids: retracted, observed_request_ids: observed
  };
};

const DEFAULT_ROW_LIMIT = 40;
const DEFAULT_GROUP_LIMIT = 10;

// Aged twin matches, joined to their bank line + candidate document. The age
// clock is the match row's updated_at — the moment the 'suggested' verdict was
// (re)stamped (upsertMatchAndCascade sets updated_at at write and its status
// CASE freezes further updates once a row leaves 'suggested'), so no new
// column is needed (design §1: "measured by the sweep, not stored").
// Guards, in order:
//   - twin reasons present, material reasons absent (the twin gate);
//   - no twin_aging.asked_at marker (asked exactly once — the send chokepoint
//     stamps it in the same txn as the mint);
//   - no BLOCKING open/replied evidence request on the bank line (the ask
//     pipeline's spam guard, mirrored — the gather must not re-feed the
//     drafter a line the owner already has). A supersedable sweep-minted
//     generic ask (the stale-ask law above) does NOT block: the twin question
//     REPLACES it through the mint's collapse — the arrival of the ambiguity
//     is exactly the better basis the law admits.
const AGED_TWIN_SQL = `
  select m.id as match_id,
         m.bank_transaction_id,
         m.matched_object_type,
         m.matched_object_id,
         m.match_amount,
         m.match_confidence,
         m.payload->'match_reason'->>'reasoning' as matcher_reasoning,
         m.payload->'authorization'->'reasons' as authorization_reasons,
         m.updated_at as verdict_stamped_at,
         t.transaction_date, t.description, t.money_in, t.money_out, t.currency,
         d.document_type as doc_type, d.filename as doc_filename,
         coalesce(d.vendor_name, d.customer_name, '') as doc_counterparty,
         coalesce(dl.amount, d.total_amount) as doc_amount, d.currency as doc_currency,
         d.document_date as doc_date,
         m.matched_line_id, dl.line_no as matched_line_no, dl.description as matched_line_description
  from reconciliation_matches m
  join transactions t on t.id = m.bank_transaction_id and t.firm_id = m.firm_id
  left join documents d on d.id = m.matched_object_id and d.firm_id = m.firm_id
  left join document_lines dl on dl.id = m.matched_line_id and dl.firm_id = m.firm_id
  where m.firm_id = $1
    and m.client_id = $2
    and m.status = 'suggested'
    and m.payload->'authorization'->'reasons' ?| $5::text[]
    and not (m.payload->'authorization'->'reasons' ?| $6::text[])
    and m.updated_at < now() - ($3 || ' days')::interval
    and coalesce(m.payload->'twin_aging'->>'asked_at', '') = ''
    and not ${blockingOpenAskExistsSql({ firmColumn: 'm.firm_id', transactionColumn: 'm.bank_transaction_id' })}
  order by m.updated_at asc
  limit $4`;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Calendar day of a pg DATE / ISO string. Goes through the shared
// normalizer (dates.js) on purpose: the previous local `new Date(v)
// .toISOString()` turned pg's LOCAL-midnight Date into the PREVIOUS day on
// any positive-offset host — every held/twin confirm on the Desert Rose
// appliance (UTC+2/+4) dated a 1 Jan rent line "31 Dec" and its bill the
// same, bank line AND document (round-4 review, 2026-09-01 §B). Ordinary
// items already used toIsoDay and were right; this lane hand-rolled its own.
const isoDay = (v) => {
  if (!v) return null;
  const day = toIsoDay(v);
  return day || null;
};

const ageDays = (stampedAt, nowMs) => {
  const t = stampedAt ? new Date(stampedAt).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(((nowMs - t) / 86400000) * 10) / 10);
};

// Gather aged twin matches and group them per bank line (one owner question
// per line; its candidates are the line's aged suggested twin matches).
// Bounded + counted: `considered` is the raw row count, `truncated` says the
// row limit clipped (so a silently-capped sweep is observable — CLAUDE.md
// "no silent caps"). Returns { groups, considered, truncated }.
export const gatherAgedTwinAskGroups = async (client, {
  firmId, clientId, env = process.env, now = Date.now(),
  rowLimit = DEFAULT_ROW_LIMIT, groupLimit = DEFAULT_GROUP_LIMIT
} = {}) => {
  const empty = { groups: [], considered: 0, truncated: false };
  if (!client || !firmId || !clientId) return empty;
  const days = twinAgingAskDays(env);
  const boundedRows = Math.min(Math.max(Number(rowLimit) || DEFAULT_ROW_LIMIT, 1), 200);
  let result;
  try {
    result = await client.query(AGED_TWIN_SQL, [
      firmId, clientId, String(days), boundedRows,
      [...TWIN_AMBIGUITY_REASONS], [...MATERIAL_HOLD_REASONS]
    ]);
  } catch (error) {
    // Pre-migration / missing column degrades to "no twins", never breaks the
    // draft that gathers us (soft-fail, the clientConfig posture).
    if (error?.code === '42P01' || error?.code === '42703') return empty;
    throw error;
  }
  const rows = result.rows || [];
  const byTx = new Map();
  for (const row of rows) {
    const txId = row.bank_transaction_id;
    if (!txId) continue;
    if (!byTx.has(txId)) {
      byTx.set(txId, {
        transaction_id: txId,
        date: row.transaction_date ? isoDay(row.transaction_date) : null,
        description: row.description || '',
        money_in: num(row.money_in),
        money_out: num(row.money_out),
        currency: row.currency || '',
        aged_days: ageDays(row.verdict_stamped_at, now),
        match_ids: [],
        candidates: []
      });
    }
    const group = byTx.get(txId);
    group.match_ids.push(row.match_id);
    // The group's age is its OLDEST verdict — the clock that tripped.
    const rowAge = ageDays(row.verdict_stamped_at, now);
    if (rowAge != null && (group.aged_days == null || rowAge > group.aged_days)) {
      group.aged_days = rowAge;
    }
    group.candidates.push({
      match_id: row.match_id,
      document_id: row.matched_object_id || null,
      document_type: row.doc_type || row.matched_object_type || '',
      counterparty: row.doc_counterparty || '',
      filename: row.doc_filename || '',
      amount: num(row.doc_amount ?? row.match_amount),
      currency: row.doc_currency || '',
      date: row.doc_date ? isoDay(row.doc_date) : null,
      confidence: row.match_confidence != null ? Number(row.match_confidence) : null,
      matcher_reasoning: row.matcher_reasoning || '',
      // RT-21c: a row match is a settlement of THAT row — the owner is asked
      // about the row (its label and net), never the whole statement.
      ...(row.matched_line_id
        ? { matched_line_id: row.matched_line_id, matched_line_no: row.matched_line_no ?? null, matched_line_description: row.matched_line_description || '' }
        : {})
    });
  }
  const boundedGroups = Math.min(Math.max(Number(groupLimit) || DEFAULT_GROUP_LIMIT, 1), 40);
  const groups = [...byTx.values()].slice(0, boundedGroups);
  return {
    groups,
    considered: rows.length,
    truncated: rows.length >= boundedRows || byTx.size > groups.length
  };
};

// The material-hold → owner-confirm lane (two-terminal-states, applied to
// held matches). A 'suggested' match held ONLY by MATERIAL_HOLD_REASONS —
// no ambiguity reasons, so the matcher itself believes exactly this candidate
// — is the textbook owner ask: "we matched X to Y; confirm?". Gathered
// IMMEDIATELY (no aging window: an authority hold only moves on a flag flip
// or a human answer) and asked exactly once (the material_hold.asked_at
// marker, stamped by the send chokepoint in the mint transaction). Same
// spam guard as the twin lane — including the supersedable carve-out: the
// Desert Rose February race put a "we need a supporting document" ask on a
// line whose 0.96 DEWA match arrived minutes later, and the old guard then
// locked the confirm lane out forever. The confirm question replaces the
// stale generic ask via the mint's collapse.
const HELD_MATERIAL_SQL = `
  select m.id as match_id,
         m.bank_transaction_id,
         m.matched_object_type,
         m.matched_object_id,
         m.match_amount,
         m.match_confidence,
         m.payload->'match_reason'->>'reasoning' as matcher_reasoning,
         m.payload->'authorization'->'reasons' as authorization_reasons,
         m.updated_at as verdict_stamped_at,
         t.transaction_date, t.description, t.money_in, t.money_out, t.currency,
         d.document_type as doc_type, d.filename as doc_filename,
         coalesce(d.vendor_name, d.customer_name, '') as doc_counterparty,
         coalesce(dl.amount, d.total_amount) as doc_amount, d.currency as doc_currency,
         d.document_date as doc_date,
         m.matched_line_id, dl.line_no as matched_line_no, dl.description as matched_line_description
  from reconciliation_matches m
  join transactions t on t.id = m.bank_transaction_id and t.firm_id = m.firm_id
  left join documents d on d.id = m.matched_object_id and d.firm_id = m.firm_id
  left join document_lines dl on dl.id = m.matched_line_id and dl.firm_id = m.firm_id
  where m.firm_id = $1
    and m.client_id = $2
    and ($7::text is null or m.bank_transaction_id = $7)
    and m.status = 'suggested'
    and not exists (select 1 from ledger_journals j
      where j.firm_id=t.firm_id and j.client_id=t.client_id
        and j.source_type='transaction' and j.source_id=t.id
        and j.status in ('posted','closed') and j.reversed_at is null)
    and m.payload->'authorization'->'reasons' ?| $4::text[]
    and not (m.payload->'authorization'->'reasons' ?| $5::text[])
    and coalesce(m.payload->'material_hold'->>'asked_at', '') = ''
    and (not ${blockingOpenAskExistsSql({ firmColumn: 'm.firm_id', transactionColumn: 'm.bank_transaction_id' })}
      or ($6::boolean and exists (select 1 from client_evidence_requests portal_ask
        where portal_ask.firm_id=m.firm_id and portal_ask.client_id=m.client_id
          and portal_ask.transaction_id=m.bank_transaction_id
          and portal_ask.status='draft' and portal_ask.send_count=0 and portal_ask.first_sent_at is null
          and portal_ask.audience='client'
          and portal_ask.created_by='coding_auto_post' and portal_ask.evidence_type='business_purpose'
          and portal_ask.request_payload->>'channel'='portal'
          and portal_ask.request_payload->>'authority_basis'='persisted_match_requires_owner_confirmation')))
  order by case when $6::boolean then
    (select max(scan.created_at) from audit_events scan where scan.firm_id=m.firm_id
      and scan.client_id=m.client_id and scan.resource_id=m.bank_transaction_id
      and scan.action='pilot.processing.held_ask_scan') end asc nulls first,
    m.updated_at asc
  limit $3`;

// Gather authority-held suggested matches and group them per bank line (one
// owner confirm question per line). Same bounded/counted contract as the twin
// gather. Deliberately NOT plane-gated: the two-terminal first principle says
// the ask must exist wherever the auto-reconcile authority does not act, so
// gating this gather on staging would re-create the exact hole it closes.
export const gatherHeldMaterialAskGroups = async (client, {
  firmId, clientId, now = Date.now(),
  rowLimit = DEFAULT_ROW_LIMIT, groupLimit = DEFAULT_GROUP_LIMIT, includePortalAsks = false, transactionId = null
} = {}) => {
  const empty = { groups: [], considered: 0, truncated: false };
  if (!client || !firmId || !clientId) return empty;
  const boundedRows = Math.min(Math.max(Number(rowLimit) || DEFAULT_ROW_LIMIT, 1), 200);
  const selectedTransactionId = typeof transactionId === 'string' && transactionId.trim() ? transactionId.trim() : null;
  let result;
  try {
    result = await client.query(HELD_MATERIAL_SQL, [
      firmId, clientId, boundedRows + (selectedTransactionId ? 1 : 0),
      [...MATERIAL_HOLD_REASONS], [...TWIN_AMBIGUITY_REASONS], includePortalAsks === true, selectedTransactionId
    ]);
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return empty;
    throw error;
  }
  const rows = result.rows || [];
  // A locked single-target read must contain the complete group. Read one
  // overflow row to distinguish a full group at the cap from a truncated one;
  // never turn a partial candidate set into an owner-facing question.
  if (selectedTransactionId && rows.length > boundedRows) return {groups:[], considered:rows.length, truncated:true};
  const byTx = new Map();
  for (const row of rows) {
    const txId = row.bank_transaction_id;
    if (!txId) continue;
    if (!byTx.has(txId)) {
      byTx.set(txId, {
        transaction_id: txId,
        date: row.transaction_date ? isoDay(row.transaction_date) : null,
        description: row.description || '',
        money_in: num(row.money_in),
        money_out: num(row.money_out),
        currency: row.currency || '',
        held_days: ageDays(row.verdict_stamped_at, now),
        hold_reasons: Array.isArray(row.authorization_reasons)
          ? row.authorization_reasons.filter((r) => MATERIAL_HOLD_REASONS.includes(r))
          : [],
        match_ids: [],
        candidates: []
      });
    }
    const group = byTx.get(txId);
    group.match_ids.push(row.match_id);
    group.candidates.push({
      match_id: row.match_id,
      document_id: row.matched_object_id || null,
      document_type: row.doc_type || row.matched_object_type || '',
      counterparty: row.doc_counterparty || '',
      filename: row.doc_filename || '',
      amount: num(row.doc_amount ?? row.match_amount),
      currency: row.doc_currency || '',
      date: row.doc_date ? isoDay(row.doc_date) : null,
      confidence: row.match_confidence != null ? Number(row.match_confidence) : null,
      matcher_reasoning: row.matcher_reasoning || '',
      // RT-21c: a row match is a settlement of THAT row — the owner is asked
      // about the row (its label and net), never the whole statement.
      ...(row.matched_line_id
        ? { matched_line_id: row.matched_line_id, matched_line_no: row.matched_line_no ?? null, matched_line_description: row.matched_line_description || '' }
        : {})
    });
  }
  const boundedGroups = Math.min(Math.max(Number(groupLimit) || DEFAULT_GROUP_LIMIT, 1), 40);
  const groups = [...byTx.values()].slice(0, boundedGroups);
  return {
    groups,
    considered: rows.length,
    truncated: (!selectedTransactionId && rows.length >= boundedRows) || byTx.size > groups.length
  };
};

// The held-match receipt list the send chokepoint reads to stamp
// 'reconciliation_match.material_hold_to_ask' — twin receipts' sibling.
export const heldMatchGroupReceipts = (groups = []) =>
  (Array.isArray(groups) ? groups : []).map((g) => ({
    transaction_id: g.transaction_id,
    match_ids: (g.match_ids || []).filter(Boolean),
    candidate_document_ids: (g.candidates || []).map((c) => c.document_id).filter(Boolean),
    hold_reasons: Array.isArray(g.hold_reasons) ? g.hold_reasons : []
  }));

// The draft-payload receipt list — what the send chokepoint reads to stamp
// 'reconciliation_match.twin_aged_to_ask' on exactly the matches whose anchor
// line got a minted evidence request (the posted_fyi_match_ids pattern).
export const twinAskGroupReceipts = (groups = []) =>
  (Array.isArray(groups) ? groups : []).map((g) => ({
    transaction_id: g.transaction_id,
    match_ids: (g.match_ids || []).filter(Boolean),
    candidate_document_ids: (g.candidates || []).map((c) => c.document_id).filter(Boolean),
    aged_days: g.aged_days ?? null
  }));

// Shadow receipt — "log the would-mint" (the flag ladder's shadow stage).
// Best-effort, no-throw: an audit failure never breaks the draft/sweep that
// observed. One event per observation with the group receipts as metadata.
export const auditTwinAgingWouldAsk = async (client, {
  firmId, clientId, groups = [], source = 'ask_draft_gather'
} = {}) => {
  if (!client || !firmId || !clientId || !groups.length) return false;
  try {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'reconciliation_match.twin_aging_would_ask', 'client', $2, $3::jsonb)`,
      [firmId, clientId, JSON.stringify({ source, groups: twinAskGroupReceipts(groups) })]
    );
    return true;
  } catch {
    return false;
  }
};

// The CLOCK TICK — the bounded per-client sweep the daily cron runs
// (inngest/convergenceClocks.js). It decides nothing: when aged twins exist
// and the flag ACTS, OR an ungated material-authority confirmation is still
// owed, it requests a fresh ask-batch draft through the EXISTING
// 'ask_draft.requested' outbox lane. This also heals a previously dead-lettered
// draft request: cancelled is terminal and deliberately absent from the
// in-flight coalesce below, so the still-eligible source verdict mints one new
// request. At twin shadow it logs the would-mint. Mirrors loopsShadowProducers.
// onReconcileCompleteRequestAskDraft: same canary+ proposal_creation gate,
// same one-in-flight coalesce — so a below-canary firm never accrues a parked
// request. Untransacted by design (F5 posture): every write here is a single
// statement; the caller holds no open txn.
export const sweepTwinAgingAskDraftRequests = async ({
  client, firmId, clientId, env = process.env, now = Date.now()
} = {}) => {
  if (!client || !firmId || !clientId) return { skipped: true, reason: 'missing_args' };
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const acts = clientFlagActs({
    flagKey: TWIN_AGING_ASK_FLAG_KEY, snapshot, envFallback: () => false, env
  });
  const observes = clientFlagObserves({
    flagKey: TWIN_AGING_ASK_FLAG_KEY, snapshot, envFallback: () => false, env
  });
  const twinGathered = (acts || observes)
    ? await gatherAgedTwinAskGroups(client, { firmId, clientId, env, now })
    : { groups: [], considered: 0, truncated: false };
  // Material-held confirmations are deliberately not plane-gated (the same
  // two-terminal rule as the draft gather). The daily clock must therefore
  // inspect them even when the twin feature is off.
  const heldGathered = await gatherHeldMaterialAskGroups(client, {
    firmId, clientId, now
  });

  if (observes && !acts && twinGathered.groups.length) {
    await auditTwinAgingWouldAsk(client, {
      firmId, clientId, groups: twinGathered.groups, source: 'twin_aging_sweep'
    });
  }
  const actionableTwinGroups = acts ? twinGathered.groups : [];
  const actionableGroups = actionableTwinGroups.length + heldGathered.groups.length;
  if (!actionableGroups) {
    if (!acts && !observes) return { skipped: true, reason: 'flag_off', held_groups: 0 };
    return {
      skipped: false,
      groups: twinGathered.groups.length,
      held_groups: 0,
      considered: twinGathered.considered,
      held_considered: heldGathered.considered,
      truncated: twinGathered.truncated,
      ...(observes && !acts && twinGathered.groups.length ? { shadow: true } : {}),
      enqueued: 0
    };
  }

  if (!(await loopsTablesPresent(client))) {
    return {
      skipped: false,
      groups: actionableTwinGroups.length,
      held_groups: heldGathered.groups.length,
      considered: twinGathered.considered,
      held_considered: heldGathered.considered,
      enqueued: 0,
      reason: 'loop_tables_absent'
    };
  }
  // Same authority the post-reconcile draft-request producer runs under:
  // drafting is proposal_creation, canary+ — below that the request is not
  // even enqueued (never park a held row).
  const { firmMetadata } = await readFirmExecutionContext(client, firmId);
  const gate = decideLoopExecution({
    loopKey: 'coding_ask_batch_resolution', firmMetadata,
    requestedAction: 'proposal_creation', env
  });
  if (!gate.actionAllowed) {
    return {
      skipped: false,
      groups: actionableTwinGroups.length,
      held_groups: heldGathered.groups.length,
      considered: twinGathered.considered,
      held_considered: heldGathered.considered,
      enqueued: 0,
      reason: gate.actionBlockedReason || gate.blockedReason
    };
  }
  // Coalesce: one in-flight draft request per client (the consumer's draft
  // supersedes, so one request always (re)produces the latest draft).
  const existing = await client.query(
    `select 1 from loop_event_outbox
      where firm_id = $1 and client_id = $2 and event_type = 'ask_draft.requested'
        and status in ('pending', 'dispatching', 'failed')
      limit 1`,
    [firmId, clientId]
  );
  if (existing.rows[0]) {
    return {
      skipped: false,
      groups: actionableTwinGroups.length,
      held_groups: heldGathered.groups.length,
      considered: twinGathered.considered,
      held_considered: heldGathered.considered,
      enqueued: 0,
      reason: 'already_pending'
    };
  }
  const out = await enqueueOutbox({
    client, firmId, clientId,
    eventType: 'ask_draft.requested',
    objectType: 'client', objectId: clientId,
    payload: {
      requested_at: new Date(now).toISOString(),
      source: 'suggested_match_ask_sweep',
      identity_contract: ASK_DRAFT_IDENTITY_CONTRACT,
      aged_twin_groups: actionableTwinGroups.length,
      held_match_groups: heldGathered.groups.length
    }
  });
  return {
    skipped: false,
    groups: actionableTwinGroups.length,
    held_groups: heldGathered.groups.length,
    considered: twinGathered.considered,
    held_considered: heldGathered.considered,
    truncated: twinGathered.truncated || heldGathered.truncated,
    enqueued: out?.id ? 1 : 0
  };
};
