// Prospecting Lab persistence (migration 051). Thin SQL over the shared pool;
// firm-agnostic (047's line). All lifecycle moves go through guarded UPDATEs
// that enforce prospectLab.isLegalTransition — a stale click can't teleport a
// prospect, and terminals are dead ends at the writer, not just in the UI.

import { randomUUID } from 'node:crypto';

import { queryFirmDb } from '../firmDb.js';
import { TRIAGE_SOURCE } from './replyTriage.js';
import {
  CLOCK_SOURCE,
  PROSPECT_SOURCES,
  PROSPECT_TIERS,
  TERMINAL_PROSPECT_STATUSES,
  isLegalTransition,
  normalizeRejectReasons,
  validateDossier
} from './prospectLab.js';

// ── Source runs ──────────────────────────────────────────────────────────────

// Runs cover the mint sources PLUS the prospect clock's receipts (M2) PLUS
// the reply-triage sweep's receipts (M4) — mintProspect below still validates
// against PROSPECT_SOURCES alone, so a prospect can never claim the clock or
// the triage sweep as its provenance.
const RUN_SOURCES = Object.freeze([...PROSPECT_SOURCES, CLOCK_SOURCE, TRIAGE_SOURCE]);

export const startSourceRun = async ({ source, params = {}, startedBy } = {}) => {
  if (!RUN_SOURCES.includes(source)) throw new Error(`Unknown prospect source: ${source}`);
  const id = randomUUID();
  await queryFirmDb(
    `insert into marketing_source_run (id, source, params, started_by)
     values ($1, $2, $3, $4)`,
    [id, source, JSON.stringify(params), String(startedBy || 'unknown')]
  );
  return { id };
};

export const finishSourceRun = async ({ runId, candidatesFound = 0, prospectsMinted = 0, error = null } = {}) => {
  await queryFirmDb(
    `update marketing_source_run
        set finished_at = now(), candidates_found = $2, prospects_minted = $3, error = $4
      where id = $1`,
    [runId, candidatesFound, prospectsMinted, error ? String(error).slice(0, 500) : null]
  );
};

export const listSourceRuns = async ({ limit = 25 } = {}) => {
  const { rows } = await queryFirmDb(
    'select * from marketing_source_run order by started_at desc limit $1',
    [limit]
  );
  return rows;
};

// When the clock last escalated (its receipt rows ARE the nudge history —
// the sweep's cooldown keys off this). Null when it never has.
export const lastClockRunAt = async () => {
  const { rows } = await queryFirmDb(
    'select started_at from marketing_source_run where source = $1 order by started_at desc limit 1',
    [CLOCK_SOURCE]
  );
  return rows[0]?.started_at || null;
};

// The clock's read: every prospect NOT at legal terminal rest, oldest clock
// first. research_only is excluded here (a deliberate, queryable parking lane
// — reviewed on segment-status changes, not on a timer; prospecting doc §5).
export const listClockProspects = async ({ limit = 500 } = {}) => {
  const excluded = [...TERMINAL_PROSPECT_STATUSES, 'research_only'];
  const { rows } = await queryFirmDb(
    `select id, company_name, status, tier, next_action_at, updated_at
       from marketing_prospect
      where status not in (select jsonb_array_elements_text($1))
      order by coalesce(next_action_at, updated_at) asc nulls first
      limit $2`,
    [JSON.stringify(excluded), limit]
  );
  return rows;
};

// ── Prospects ────────────────────────────────────────────────────────────────

// Mint a candidate. Dedup: registry-keyed upsert when company_number exists
// (re-scans refresh campaigns, never duplicate); name-keyed manual entries
// dedup against LIVE (non-terminal) rows so a re-uploaded list reports
// "already live" instead of double-minting — a terminal row does not block a
// fresh mint (a converted/unfit verdict belongs to the old investigation).
export const mintProspect = async ({
  companyName,
  companyNumber = null,
  jurisdiction = 'UK',
  website = null,
  contactEmail = null,
  sourceNote = null,
  source,
  sourceRunId = null,
  campaigns = [],
  tier = 'green'
} = {}) => {
  if (!PROSPECT_SOURCES.includes(source)) throw new Error(`Unknown prospect source: ${source}`);
  if (!PROSPECT_TIERS.includes(tier)) throw new Error(`Unknown tier: ${tier}`);
  const id = randomUUID();
  if (companyNumber) {
    const { rows } = await queryFirmDb(
      `insert into marketing_prospect
         (id, company_name, company_number, jurisdiction, website, contact_email, source_note, source, source_run_id, campaigns, tier)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (jurisdiction, company_number) where company_number is not null
       do update set
         campaigns = (
           select jsonb_agg(distinct tag)
             from jsonb_array_elements(marketing_prospect.campaigns || excluded.campaigns) as tag
         ),
         contact_email = coalesce(marketing_prospect.contact_email, excluded.contact_email),
         source_note = coalesce(marketing_prospect.source_note, excluded.source_note),
         updated_at = now()
       returning *, (xmax = 0) as inserted`,
      [id, String(companyName), companyNumber, jurisdiction, website, contactEmail, sourceNote, source, sourceRunId, JSON.stringify(campaigns), tier]
    );
    return { prospect: rows[0], inserted: rows[0]?.inserted === true };
  }
  const { rows: existing } = await queryFirmDb(
    `select * from marketing_prospect
      where lower(company_name) = lower($1) and jurisdiction = $2 and company_number is null
        and status not in ('closed_no_reply', 'converted', 'unfit', 'suppressed')
      limit 1`,
    [String(companyName), jurisdiction]
  );
  if (existing[0]) {
    return { prospect: existing[0], inserted: false };
  }
  const { rows } = await queryFirmDb(
    `insert into marketing_prospect
       (id, company_name, jurisdiction, website, contact_email, source_note, source, source_run_id, campaigns, tier)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [id, String(companyName), jurisdiction, website, contactEmail, sourceNote, source, sourceRunId, JSON.stringify(campaigns), tier]
  );
  return { prospect: rows[0], inserted: true };
};

export const getProspect = async (prospectId) => {
  const { rows } = await queryFirmDb('select * from marketing_prospect where id = $1', [prospectId]);
  return rows[0] || null;
};

export const listProspects = async ({ statuses = null, limit = 100 } = {}) => {
  const { rows } = await queryFirmDb(
    `select * from marketing_prospect
      where ($1::jsonb is null or status in (select jsonb_array_elements_text($1)))
      order by updated_at desc limit $2`,
    [statuses ? JSON.stringify(statuses) : null, limit]
  );
  return rows;
};

// Guarded lifecycle hop. Returns the updated row, or null when the prospect
// was not in `from` (stale view) — the transition table is enforced HERE.
export const transitionProspect = async ({ prospectId, from, to, actor = null, patch = {} } = {}) => {
  if (!isLegalTransition(from, to)) {
    const error = new Error(`Illegal prospect transition ${from} → ${to}.`);
    error.statusCode = 409;
    error.code = 'ILLEGAL_TRANSITION';
    throw error;
  }
  const { rows } = await queryFirmDb(
    `update marketing_prospect
        set status = $3,
            decided_by = coalesce($4, decided_by),
            decided_at = case when $4 is null then decided_at else now() end,
            contact_email = coalesce($5, contact_email),
            next_action_at = coalesce($6, next_action_at),
            reject_reasons = case when $7::jsonb is null then reject_reasons else $7 end,
            updated_at = now()
      where id = $1 and status = $2
      returning *`,
    [
      prospectId,
      from,
      to,
      actor ? String(actor) : null,
      patch.contactEmail || null,
      patch.nextActionAt || null,
      patch.rejectReasons ? JSON.stringify(normalizeRejectReasons(patch.rejectReasons)) : null
    ]
  );
  return rows[0] || null;
};

// Hold: the prospect stays ON KARI (a legal resting state — it is his queue),
// with the decision attributed and an optional revisit date. Not a lifecycle
// hop, so it does not go through the transition table.
export const holdProspect = async ({ prospectId, actor, nextActionAt = null } = {}) => {
  const { rows } = await queryFirmDb(
    `update marketing_prospect
        set decided_by = $2, decided_at = now(),
            next_action_at = coalesce($3, next_action_at),
            updated_at = now()
      where id = $1 and status = 'on_kari'
      returning *`,
    [prospectId, String(actor || 'unknown'), nextActionAt]
  );
  return rows[0] || null;
};

// Attach a validated dossier and put the prospect on Kari. Validation is a
// writer precondition: an invalid dossier never reaches the queue.
export const attachDossier = async ({ prospectId, dossier, model, contactEmail = null } = {}) => {
  const violations = validateDossier(dossier);
  if (violations.length > 0) {
    return { ok: false, violations };
  }
  const { rows } = await queryFirmDb(
    `update marketing_prospect
        set dossier = $2, dossier_model = $3, contact_email = coalesce($4, contact_email),
            status = 'on_kari', updated_at = now()
      where id = $1 and status = 'investigating'
      returning *`,
    [prospectId, JSON.stringify(dossier), String(model), contactEmail]
  );
  if (!rows[0]) return { ok: false, violations: ['prospect is not in the investigating state'] };
  return { ok: true, prospect: rows[0] };
};
