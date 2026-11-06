// Structured bank-line reference capture (G12 — the approved post-parse
// enricher lane, Kari 2026-07-24; migration 098).
//
// Bank lines carry payment references only as free text, so issued-invoice
// settlement matches by substring — which can mis-hit on a reference embedded
// inside a longer digit run. This sweep captures the reference as STRUCTURED
// data: it extracts digit-run candidates from a parsed line's text, validates
// them with the PACK-declared reference scheme's deterministic validator
// (FI: the viitenumero check digit), and persists a capture ONLY on an
// unambiguous single-candidate hit. Ambiguity captures nothing — the
// substring status quo remains. Nothing here guesses; nothing here is an LLM.
//
// COUNTRY ABSTRACTION (mandatory — the M3 rule): the engine is scheme-keyed.
// WHICH validator applies is pack data (packs/<cc> reference.scheme) resolved
// through SCHEME_VALIDATORS below; adding a reference-scheme country is a
// pack + one registry binding (the "connectors" clause of the country rule),
// never an engine edit. AMERICA-FIRST GUARD: a pack with scheme 'none' (the
// US) exits after one pack resolution — zero transaction reads, zero writes,
// zero behavior change; pinned by test.
//
// Deliberately NOT the extractor lane: this module runs post-parse on
// persisted rows and touches neither parseDocumentsDb.js nor
// inngest/parseDocument.js (isolation-listed). If capture precision ever
// demands statement-format-level fields (camt structured references), that is
// a separate, explicitly greenlit slice.
//
// TWO capture lanes, one posture (both ride the hourly outbound cron BEFORE
// detection): the BANK-LINE sweep (captureStructuredReferences, migration
// 098) and the PARSED-INVOICE sweep (captureDocumentStructuredReferences,
// migration 101 — G12's invoice-side sibling, closing M3's named honest
// line: a parsed FI sales invoice's documents.reference_number is the
// INVOICE number, not the viite, so its chase rested on the owner as
// missing_reference_number until this lane).
//
// Flag: OUTBOUND_REFERENCE_CAPTURE, born 'off' on the config plane
// (envFallback false — the rollout-flags rail). shadow = count would-captures
// with one aggregate receipt, zero writes; canary/auto = capture. DB-only
// enrichment (no external side effect); the PR flagged the key for Kari's
// veto and he EXERCISED it (2026-07-24): the key sits in AUTO_FORBIDDEN_FLAGS
// with every other OUTBOUND_* terminal — no exceptions by category.

import {
  readClientConfigSnapshot, clientFlagActs, clientFlagObserves
} from '../clientConfig.js';
import { loadOutboundPack, resolvePackIdForJurisdiction } from './packs.js';
// gap 8, edge 3 — this module used to reach into `finland/verkkolasku.js` for
// the one scheme validator it needed, in parallel with `referenceSchemes.js`
// doing the same thing for the same scheme. TWO registries for one scheme is
// drift waiting to happen (a market bound in one and not the other captures
// references it cannot mint, or the reverse). There is now ONE registry —
// `referenceSchemes.REFERENCE_SCHEME_BINDINGS` — and this module reads its
// validator from it. That deletes this file's `finland/` import outright; the
// registry's own remaining binding is the single site left to invert, and it
// needs its own decision (see the gaps doc, gap 8).
import { REFERENCE_SCHEME_BINDINGS } from './referenceSchemes.js';
import { gateRoleSurfaceOperation } from '../roles/roleAuthority.js';

export const REFERENCE_CAPTURE_FLAG_KEY = 'OUTBOUND_REFERENCE_CAPTURE';

// Noise floor for CAPTURE (stricter than the settlement matcher's min-4
// substring floor): short runs pass a mod-10 check digit too easily. The
// settlement matcher's structured-disqualification rule shares this value —
// pinned equal by test (STRUCTURED_REFERENCE_MIN_DIGITS in
// issuedInvoiceSettlementMath.js — relocated there from finland/ 2026-07-27).
export const CAPTURE_MIN_DIGITS = 6;
const CAPTURE_MAX_DIGITS = 20;

const SWEEP_LIMIT = 200;

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

// scheme name (packs.js KNOWN_REFERENCE_SCHEMES) → deterministic validator.
// 'none' is deliberately absent from the registry: no scheme, no capture.
// THE registry is `referenceSchemes.REFERENCE_SCHEME_BINDINGS` (mint +
// validate); capture needs only the validate half, so it reads that half
// rather than keeping a second map. Binding a new market's scheme in one place
// now switches on BOTH minting and capture, which is the only honest coupling:
// a scheme Donna can mint but not capture would issue references its own
// settlement sweep ignores.
const SCHEME_VALIDATORS = REFERENCE_SCHEME_BINDINGS;

// Extract scheme-valid reference candidates from a line's free text. Two
// passes, composed conservatively:
//   1. plain digit runs (separators break runs) — the unspaced form;
//   2. space-joined digit groups ("12 34561" → "1234561") — banks display
//      grouped references; joining ACROSS other separators is deliberately
//      not attempted (commas/periods delimit amounts).
// A candidate from either pass counts; the DISTINCT set is returned. The
// caller captures only when exactly one distinct value survives — a glued
// pass-2 artifact that happens to validate alongside a real pass-1 reference
// yields two candidates and therefore no capture (never a wrong write).
export const extractSchemeReferences = (text, { validate } = {}) => {
  if (typeof validate !== 'function') return [];
  const source = String(text ?? '');
  const candidates = new Set();
  const consider = (run) => {
    if (run.length < CAPTURE_MIN_DIGITS || run.length > CAPTURE_MAX_DIGITS) return;
    const canonical = run.replace(/^0+(?=\d)/, '');
    if (validate(run)) candidates.add(canonical);
  };
  for (const run of source.match(/\d+/g) || []) consider(run);
  const spaceJoined = source.replace(/(\d) (?=\d)/g, '$1');
  for (const run of spaceJoined.match(/\d+/g) || []) consider(run);
  return [...candidates];
};

// Shared per-client lane resolution (flag posture → jurisdiction → pack →
// scheme binding), in the exact order the transaction sweep has always run
// it. Both sweeps exit here for a scheme-less pack (the America-first guard):
// neither the transactions nor the documents table is ever touched for such
// a client.
const resolveCaptureLane = async ({ client, firmId, clientId, env, snapshot }) => {
  const snap = snapshot || await readClientConfigSnapshot(client, { firmId, clientId });
  const acts = clientFlagActs({
    flagKey: REFERENCE_CAPTURE_FLAG_KEY, snapshot: snap, envFallback: () => false, env
  });
  const observes = clientFlagObserves({
    flagKey: REFERENCE_CAPTURE_FLAG_KEY, snapshot: snap, envFallback: () => false, env
  });
  if (!acts && !observes) return { skipped: true, reason: 'flag_off' };

  const clientRow = await client.query(
    `select coalesce(profile->>'jurisdiction', jurisdiction) as jurisdiction
       from clients where firm_id = $1 and id = $2`,
    [firmId, clientId]
  ).then((r) => r.rows[0] || null).catch((error) => {
    if (error?.code === '42703') return null;
    throw error;
  });
  if (!clientRow) return { skipped: true, reason: 'client_not_found' };

  const packId = resolvePackIdForJurisdiction(clientRow.jurisdiction);
  if (!packId) return { skipped: true, reason: 'no_pack_for_jurisdiction' };
  const pack = loadOutboundPack(packId);
  const scheme = pack.reference?.scheme || 'none';
  const binding = SCHEME_VALIDATORS[scheme];
  if (!binding) return { skipped: true, reason: 'no_reference_scheme' };
  return { skipped: false, acts, observes, scheme, packId, binding, snapshot: snap };
};

// The per-client capture sweep. Caller holds no open transaction; updates are
// per-row and idempotent (checked_at stamps examined lines, captured or not).
export const captureStructuredReferences = async ({
  client, firmId, clientId, env = process.env, snapshot = null,
  limit = SWEEP_LIMIT, logger = console
} = {}) => {
  const stats = {
    skipped: false, scanned: 0, captured: 0, ambiguous: 0, none_found: 0,
    shadow_would_capture: 0, errors: 0
  };
  if (!client || !firmId || !clientId) return { ...stats, skipped: true, reason: 'missing_args' };

  const lane = await resolveCaptureLane({ client, firmId, clientId, env, snapshot });
  if (lane.skipped) return { ...stats, skipped: true, reason: lane.reason };
  const { acts, scheme, packId, binding } = lane;

  // S1 role leash (INV-S2): reference capture is the invoicing_collections
  // role's audited surface operation (DB-only enrichment feeding paid-truth).
  const roleGate = await gateRoleSurfaceOperation({
    actionType: 'capture_structured_reference', snapshot: lane.snapshot, env,
    seam: 'outbound_sweep', firmId, clientId, logger,
    query: (sql, params) => client.query(sql, params)
  });
  if (!roleGate.proceed) return { ...stats, skipped: true, reason: 'role_leash_denied' };

  const bounded = Math.min(Math.max(Number(limit) || SWEEP_LIMIT, 1), 500);
  let rows;
  try {
    rows = await client.query(
      `select id, description, raw_description,
              payload->>'source_line' as source_line,
              payload->>'contact' as contact
         from transactions
        where firm_id = $1 and client_id = $2
          and money_in > 0
          and structured_reference_checked_at is null
        order by created_at asc
        limit $3`,
      [firmId, clientId, bounded]
    ).then((r) => r.rows);
  } catch (error) {
    if (missingTables(error)) return { ...stats, skipped: true, reason: 'tables_absent' };
    throw error;
  }
  stats.scanned = rows.length;
  if (!rows.length) return stats;

  const capturedIds = [];
  for (const row of rows) {
    try {
      // The SAME text set the settlement matcher reads (transactionText) —
      // the disqualification proof depends on capture and matching seeing
      // identical text.
      const text = [row.description, row.raw_description, row.source_line, row.contact]
        .map((v) => String(v ?? '')).join(' ');
      const candidates = extractSchemeReferences(text, binding);
      if (!acts) {
        // Shadow: count what WOULD capture; write nothing (not even
        // checked_at — shadow leaves zero mutation, the detector's shape).
        if (candidates.length === 1) stats.shadow_would_capture += 1;
        continue;
      }
      if (candidates.length === 1) {
        await client.query(
          `update transactions
              set structured_reference = $4, structured_reference_checked_at = now(), updated_at = now()
            where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId, clientId, row.id, candidates[0]]
        );
        stats.captured += 1;
        capturedIds.push(row.id);
      } else {
        await client.query(
          `update transactions
              set structured_reference_checked_at = now(), updated_at = now()
            where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId, clientId, row.id]
        );
        if (candidates.length === 0) stats.none_found += 1;
        else stats.ambiguous += 1;
      }
    } catch (error) {
      try {
        logger.warn?.(`[referenceCapture] line ${row.id} failed: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }

  // Nothing silent: one aggregate receipt per sweep that captured (or, in
  // shadow, would have captured) anything. Best-effort.
  if (stats.captured || stats.shadow_would_capture) {
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'client', $2, $4::jsonb)`,
        [firmId, clientId,
          acts ? 'outbound.reference_capture' : 'outbound.reference_capture_would_capture',
          JSON.stringify({
            scheme, pack_id: packId,
            captured: stats.captured, ambiguous: stats.ambiguous,
            none_found: stats.none_found, shadow_would_capture: stats.shadow_would_capture,
            transaction_ids: capturedIds
          })]
      );
    } catch { /* best-effort receipt */ }
  }
  return stats;
};

// ── The parsed-invoice lane (G12's invoice-side sibling; migration 101) ──────

// Candidate text for a parsed sales invoice: the payload's TYPED reference
// values with every invoice-number source DELIBERATELY excluded — the
// documents.reference_number column and the extraction's invoice_number
// entries ARE the invoice number (M3's honest line), and an invoice number
// that happens to check-digit-validate must never be stamped as the payment
// reference. A viite printed on the invoice reaches the extraction's
// references array under a non-invoice-number type; if it didn't, capture
// finds nothing and the chase keeps resting on the owner (fail-closed).
export const documentReferenceCandidateText = (references) => {
  const list = Array.isArray(references) ? references : [];
  return list
    .filter((ref) => ref && typeof ref === 'object' && ref.type !== 'invoice_number')
    .map((ref) => String(ref.value ?? ''))
    .join(' ');
};

// The per-client document sweep. Same posture as the bank-line sweep in every
// clause: post-parse only (zero parse-path files touched), scheme-validator
// filtering, capture ONLY on a single distinct candidate, checked_at stamps
// examined rows captured or not, shadow counts would-captures with zero
// mutation, one aggregate receipt. Caller holds no open transaction.
export const captureDocumentStructuredReferences = async ({
  client, firmId, clientId, env = process.env, snapshot = null,
  limit = SWEEP_LIMIT, logger = console
} = {}) => {
  const stats = {
    skipped: false, scanned: 0, captured: 0, ambiguous: 0, none_found: 0,
    shadow_would_capture: 0, errors: 0
  };
  if (!client || !firmId || !clientId) return { ...stats, skipped: true, reason: 'missing_args' };

  const lane = await resolveCaptureLane({ client, firmId, clientId, env, snapshot });
  if (lane.skipped) return { ...stats, skipped: true, reason: lane.reason };
  const { acts, scheme, packId, binding } = lane;

  // S1 role leash — same audited surface operation as the bank-line entry.
  const roleGate = await gateRoleSurfaceOperation({
    actionType: 'capture_structured_reference', snapshot: lane.snapshot, env,
    seam: 'outbound_sweep', firmId, clientId, logger,
    query: (sql, params) => client.query(sql, params)
  });
  if (!roleGate.proceed) return { ...stats, skipped: true, reason: 'role_leash_denied' };

  const bounded = Math.min(Math.max(Number(limit) || SWEEP_LIMIT, 1), 500);
  let rows;
  try {
    rows = await client.query(
      `select id,
              payload->'raw_extraction'->'header'->'references' as extracted_references
         from documents
        where firm_id = $1 and client_id = $2
          and document_type = 'sales_invoice'
          and coalesce(parse_status, 'completed') = 'completed'
          and structured_reference_checked_at is null
        order by created_at asc
        limit $3`,
      [firmId, clientId, bounded]
    ).then((r) => r.rows);
  } catch (error) {
    if (missingTables(error)) return { ...stats, skipped: true, reason: 'tables_absent' };
    throw error;
  }
  stats.scanned = rows.length;
  if (!rows.length) return stats;

  const capturedIds = [];
  for (const row of rows) {
    try {
      const text = documentReferenceCandidateText(row.extracted_references);
      const candidates = extractSchemeReferences(text, binding);
      if (!acts) {
        // Shadow: count what WOULD capture; write nothing (not even
        // checked_at — shadow leaves zero mutation, the detector's shape).
        if (candidates.length === 1) stats.shadow_would_capture += 1;
        continue;
      }
      if (candidates.length === 1) {
        await client.query(
          `update documents
              set structured_reference = $4, structured_reference_checked_at = now(), updated_at = now()
            where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId, clientId, row.id, candidates[0]]
        );
        stats.captured += 1;
        capturedIds.push(row.id);
      } else {
        await client.query(
          `update documents
              set structured_reference_checked_at = now(), updated_at = now()
            where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId, clientId, row.id]
        );
        if (candidates.length === 0) stats.none_found += 1;
        else stats.ambiguous += 1;
      }
    } catch (error) {
      try {
        logger.warn?.(`[referenceCapture] document ${row.id} failed: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }

  // Nothing silent: one aggregate receipt per sweep that captured (or, in
  // shadow, would have captured) anything. Best-effort.
  if (stats.captured || stats.shadow_would_capture) {
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'client', $2, $4::jsonb)`,
        [firmId, clientId,
          acts ? 'outbound.document_reference_capture' : 'outbound.document_reference_capture_would_capture',
          JSON.stringify({
            scheme, pack_id: packId,
            captured: stats.captured, ambiguous: stats.ambiguous,
            none_found: stats.none_found, shadow_would_capture: stats.shadow_would_capture,
            document_ids: capturedIds
          })]
      );
    } catch { /* best-effort receipt */ }
  }
  return stats;
};
