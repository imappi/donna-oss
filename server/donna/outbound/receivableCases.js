// Receivable collection cases (M1, G5 — execution plan §1 M1.1) + the
// overdue detector that opens them. The case is persisted CHASE state
// (which reminder tier, paused/disputed/escalated, next due) alongside —
// never replacing — computed settlement: the send-time paid-truth guard
// (G4, paidTruthGuard.js) stays the only authority on "is it still owed",
// re-checked fresh at every send. A case never shortcuts the guard.
//
// Two-terminal-states over the case lifecycle: a case rests only as
// settled/stopped (terminal, audited) or on the OWNER (escalated, paused,
// disputed, or open-with-a-named-gap surfaced by the G9 digest). 'open'
// with next_due_at is transient work the hourly sweep drains.
//
// The detector scans TWO candidate lanes — parsed sales invoices
// (parse-completed, payment_status='unpaid', due_date past) AND
// Donna-issued invoices (the M2 lane below: status='issued', due date
// past; an invoice Donna issued herself joins the same chase pipeline the
// day it runs overdue) — both in the pack home currency. Per candidate it
// resolves the counterparty through the party store (suggest-and-confirm;
// the model proposes upstream, this module never merges identities),
// opens the case, and mints the step-1 reminder through THE gate
// (classifyOutboundAction) with the paid-truth guard's mint-time verdict.
// (Stated as two lanes explicitly because a 2026-08-15 certification run
// report misread this header's earlier "scans parsed sales invoices"
// first line as the whole truth and recorded the issued lane as missing —
// journey 1, roles/journeys/collectionsJourneys.js, now drives it.) A doc missing what the reminder needs (no recipient
// channel, no payment instructions, no invoice number) still opens its
// case with a named status_reason so the G9 digest can put the gap on the
// owner — a business fact only they can supply. Nothing rests firm-side.
//
// payment_instructions source (M1 seam, until D4 pay-links land in M2):
// clients.profile.payment_instructions — a client-level standing value the
// owner supplies once. The parsed-invoice extraction does not capture remit
// blocks today; extending the extractor is a deliberate later slice, not a
// silent detector guess.
//
// Reference numbers (M3 — the one core file the FI abstraction proof forced
// open; recorded in the plan's §6 tracker): a pack that declares a reference
// scheme (pack.reference.scheme != 'none') states the payment reference in
// its reminders ({{reference_number}}), so the mint must surface the anchor's
// reference — for issued invoices the persisted draft's value (the FI lane
// stores the viite at draft.finvoice.invoiceDetails.referenceNumber; the
// scheme-neutral home is draft.invoice.referenceNumber). GENERIC by design:
// any reference value present is surfaced regardless of pack, and a
// scheme-declaring pack whose anchor has NO reference rests the case on the
// owner as a named gap ('missing_reference_number') instead of minting a
// reminder that would refuse at render — fail-closed at mint, never a wrong
// reference in a counterparty's inbox. Parsed documents get their structured
// payment reference from G12's invoice-side capture sweep (migration 101,
// documents.structured_reference — never guessed here:
// documents.reference_number stays the invoice number); an uncaptured parsed
// invoice keeps resting on the owner via the same named gap.
//
// Detector confidence is minted null on purpose: under the M1 posture every
// send holds for the owner regardless, and when auto graduation arrives
// (D4 settlement signal), the earned-confidence policy is a deliberate
// decision to record — not a constant to sneak in here.
//
// Keep-layer posture: deterministic scans and refusals; no LLM call.

import { randomUUID } from 'node:crypto';

import { readClientConfigSnapshot } from '../clientConfig.js';
import {
  loadOutboundPack, resolvePackIdForJurisdiction, dunningCadenceForPack,
  formatPackAmount, formatPackDate, languageForEntity
} from './packs.js';
import { classifyOutboundAction, outboundGateMode } from './actionGate.js';
import { listPartyChannels, resolvePartyCandidate } from './partyStore.js';
import { isOutboundSuppressed, mintOutboundAction } from './actionStore.js';
import {
  getActivePayLinkForAnchor, payLinksGateMode, stripePayLinkAccountForProfile
} from './payLinks.js';
import { toLocalIsoDay } from '../dates.js';

const DAY_MS = 86400000;

export const RECEIVABLE_CASE_STATUSES = Object.freeze([
  'open', 'paused', 'disputed', 'escalated', 'settled', 'stopped'
]);

export const RECEIVABLE_CASE_ANCHOR_TYPES = Object.freeze([
  'document', 'issued_invoice'
]);

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

const auditEvent = async (client, {
  firmId, clientId, actorType = 'system', actorId = null,
  action, resourceId, metadata = {}
}) => {
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, $5, 'receivable_case', $6, $7::jsonb)`,
    [firmId, clientId, actorType, actorId, action, resourceId, JSON.stringify(metadata)]
  );
};

// ── Case store (caller's client handle; no begin/commit here — M0 posture) ──

export const getReceivableCaseByAnchor = async (client, { firmId, clientId, anchorType, anchorId }) => {
  const { rows } = await client.query(
    `select * from receivable_cases
      where firm_id = $1 and client_id = $2 and anchor_type = $3 and anchor_id = $4`,
    [firmId, clientId, anchorType, anchorId]
  );
  return rows[0] || null;
};

export const listReceivableCases = async (client, {
  firmId, clientId, statuses = null, limit = 200
}) => {
  const bounded = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const filter = Array.isArray(statuses) && statuses.length
    ? statuses.filter((s) => RECEIVABLE_CASE_STATUSES.includes(s))
    : null;
  const { rows } = await client.query(
    `select * from receivable_cases
      where firm_id = $1 and client_id = $2
        and ($3::text[] is null or status = any($3::text[]))
      order by coalesce(next_due_at, created_at) asc
      limit $4`,
    [firmId, clientId, filter, bounded]
  );
  return rows;
};

export const openReceivableCase = async (client, {
  firmId, clientId, anchorType, anchorId, targetPartyId = null, packId,
  invoiceNumber = null, amount = null, currency = null, dueDate = null,
  statusReason = null, openedReason = 'overdue_detected'
}) => {
  if (!RECEIVABLE_CASE_ANCHOR_TYPES.includes(anchorType)) {
    throw new Error(`openReceivableCase: unknown anchor_type '${anchorType}'`);
  }
  const id = randomUUID();
  const inserted = await client.query(
    `insert into receivable_cases
       (id, firm_id, client_id, anchor_type, anchor_id, target_party_id, pack_id,
        invoice_number, amount, currency, due_date, opened_reason, status_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (firm_id, client_id, anchor_type, anchor_id) do nothing
     returning *`,
    [id, firmId, clientId, anchorType, anchorId, targetPartyId, packId,
      invoiceNumber, amount, currency, dueDate, String(openedReason || 'overdue_detected'), statusReason]
  );
  if (!inserted.rows[0]) {
    return { case: await getReceivableCaseByAnchor(client, { firmId, clientId, anchorType, anchorId }), deduped: true };
  }
  await auditEvent(client, {
    firmId, clientId, action: 'receivable_case.opened', resourceId: id,
    metadata: {
      anchor: `${anchorType}:${anchorId}`, target_party_id: targetPartyId,
      invoice_number: invoiceNumber, amount, currency, due_date: dueDate,
      status_reason: statusReason
    }
  });
  return { case: inserted.rows[0], deduped: false };
};

// After an executed reminder: bump the step, stamp the send, aim at the next
// due time (null when the cadence just exhausted — escalate follows).
export const markReceivableCaseSent = async (client, {
  firmId, clientId, anchorType, anchorId, step, actionId = null,
  nextDueAt = null, at = new Date().toISOString()
}) => {
  const { rows } = await client.query(
    `update receivable_cases
        set current_step = $5, last_action_id = $6, last_sent_at = $7,
            next_due_at = $8, status_reason = null, updated_at = now()
      where firm_id = $1 and client_id = $2 and anchor_type = $3 and anchor_id = $4
        and status = 'open'
      returning *`,
    [firmId, clientId, anchorType, anchorId, Number(step) || 0, actionId, at, nextDueAt]
  );
  return rows[0] || null;
};

const closeCase = async (client, {
  firmId, clientId, anchorType, anchorId, status, reason, extra = {}
}) => {
  const settled = status === 'settled';
  const { rows } = await client.query(
    `update receivable_cases
        set status = $5, status_reason = $6, next_due_at = null,
            settled_at = case when $5 = 'settled' then now() else settled_at end,
            closed_at = now(), updated_at = now()
      where firm_id = $1 and client_id = $2 and anchor_type = $3 and anchor_id = $4
        and status not in ('settled', 'stopped')
      returning *`,
    [firmId, clientId, anchorType, anchorId, status, String(reason || (settled ? 'settled' : 'stopped'))]
  );
  if (!rows[0]) return null;
  await auditEvent(client, {
    firmId, clientId, action: `receivable_case.${status}`, resourceId: rows[0].id,
    metadata: { anchor: `${anchorType}:${anchorId}`, reason: String(reason || ''), ...extra }
  });
  return rows[0];
};

// Paid-truth said settled: the chase ends because the money arrived.
export const settleReceivableCase = async (client, args) =>
  closeCase(client, { ...args, status: 'settled' });

// Honest stop: owner declined, recipient suppressed, or out of road with the
// owner told. Terminal with a named reason — never a silent skip.
export const stopReceivableCase = async (client, args) =>
  closeCase(client, { ...args, status: 'stopped' });

// Cadence exhausted: the case rests ON THE OWNER (terminal 2) until they act.
export const escalateReceivableCase = async (client, {
  firmId, clientId, anchorType, anchorId, reason = 'cadence_exhausted'
}) => {
  const { rows } = await client.query(
    `update receivable_cases
        set status = 'escalated', status_reason = $5, next_due_at = null, updated_at = now()
      where firm_id = $1 and client_id = $2 and anchor_type = $3 and anchor_id = $4
        and status = 'open'
      returning *`,
    [firmId, clientId, anchorType, anchorId, String(reason || 'cadence_exhausted')]
  );
  if (!rows[0]) return null;
  await auditEvent(client, {
    firmId, clientId, action: 'receivable_case.escalated', resourceId: rows[0].id,
    metadata: { anchor: `${anchorType}:${anchorId}`, reason: String(reason || 'cadence_exhausted') }
  });
  return rows[0];
};

// Owner verbs (the D12/G15 workspace and chat surfaces call these; both rest
// the case on the owner, which IS their terminal until the owner resumes).
export const pauseReceivableCase = async (client, {
  firmId, clientId, caseId, reason = 'owner_paused', actorType, actorId = null
}) => {
  if (!actorType || actorType === 'system') {
    throw new Error('pauseReceivableCase requires a non-system acting principal');
  }
  const { rows } = await client.query(
    `update receivable_cases
        set status = 'paused', status_reason = $4, next_due_at = null, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status in ('open', 'escalated')
      returning *`,
    [caseId, firmId, clientId, String(reason || 'owner_paused')]
  );
  if (!rows[0]) return null;
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'receivable_case.paused', resourceId: caseId,
    metadata: { reason: String(reason || 'owner_paused') }
  });
  return rows[0];
};

export const markReceivableCaseDisputed = async (client, {
  firmId, clientId, caseId, reason = 'counterparty_disputed', actorType, actorId = null
}) => {
  if (!actorType || actorType === 'system') {
    throw new Error('markReceivableCaseDisputed requires a non-system acting principal');
  }
  const { rows } = await client.query(
    `update receivable_cases
        set status = 'disputed', status_reason = $4, next_due_at = null, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status in ('open', 'escalated', 'paused')
      returning *`,
    [caseId, firmId, clientId, String(reason || 'counterparty_disputed')]
  );
  if (!rows[0]) return null;
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'receivable_case.disputed', resourceId: caseId,
    metadata: { reason: String(reason || 'counterparty_disputed') }
  });
  return rows[0];
};

// ── Executor sync helpers (called inside the executor's transactions; each
// soft-fails when 092 has not run yet so the action pipeline keeps working) ──

export const syncReceivableCaseAfterSend = async (client, {
  firmId, clientId, action, nextDueAt = null, exhausted = false,
  at = new Date().toISOString()
}) => {
  if (action?.action_type !== 'send_receivable_reminder') return null;
  try {
    const updated = await markReceivableCaseSent(client, {
      firmId, clientId, anchorType: action.anchor_type, anchorId: action.anchor_id,
      step: action.cadence_step, actionId: action.id, nextDueAt, at
    });
    if (exhausted) {
      await escalateReceivableCase(client, {
        firmId, clientId, anchorType: action.anchor_type, anchorId: action.anchor_id,
        reason: 'cadence_exhausted'
      });
    }
    return updated;
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }
};

export const syncReceivableCaseAfterCancel = async (client, {
  firmId, clientId, action, reasons = []
}) => {
  if (action?.action_type !== 'send_receivable_reminder') return null;
  const list = Array.isArray(reasons) ? reasons : [String(reasons || '')];
  const settled = list.includes('already_settled');
  try {
    const args = {
      firmId, clientId, anchorType: action.anchor_type, anchorId: action.anchor_id,
      reason: list.join(',') || 'cancelled'
    };
    return settled
      ? await settleReceivableCase(client, args)
      : await stopReceivableCase(client, args);
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }
};

// ── The overdue detector (the M1 loop's front door) ──────────────────────────
// Scans parse-completed, unpaid, past-due sales invoices in the pack's home
// currency; opens a case per anchor and mints the step-1 reminder through the
// gate. Per-candidate short transactions (the backfill posture) — one
// poisoned doc never rolls back the rest. The CALLER holds no open txn.

const DETECT_LIMIT = 25;

export const detectOverdueReceivables = async ({
  client, firmId, clientId, env = process.env,
  now = Date.now(), paidTruthCheck = null, limit = DETECT_LIMIT, logger = console
} = {}) => {
  const stats = {
    skipped: false, scanned: 0, issued_scanned: 0, cases_opened: 0, actions_minted: 0,
    needs_owner_input: 0, skipped_foreign_currency: 0, skipped_unresolvable_party: 0,
    skipped_settled: 0, remint_minted: 0,
    shadow_would_open: 0, errors: 0
  };
  if (!client || !firmId || !clientId) return { ...stats, skipped: true, reason: 'missing_args' };

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const { mode } = outboundGateMode({ actionType: 'send_receivable_reminder', snapshot, env });
  if (mode === 'off') return { ...stats, skipped: true, reason: 'flag_off' };

  const clientRow = await client.query(
    `select company_name, profile, coalesce(profile->>'jurisdiction', jurisdiction) as jurisdiction
       from clients where firm_id = $1 and id = $2`,
    [firmId, clientId]
  ).then((r) => r.rows[0] || null).catch((error) => {
    if (error?.code === '42703') return null;
    throw error;
  });
  if (!clientRow) return { ...stats, skipped: true, reason: 'client_not_found' };

  const packId = resolvePackIdForJurisdiction(clientRow.jurisdiction);
  if (!packId) return { ...stats, skipped: true, reason: 'no_pack_for_jurisdiction' };
  const pack = loadOutboundPack(packId);
  const homeCurrency = pack.currency.home;
  const referenceScheme = pack.reference?.scheme || 'none';
  const steps = dunningCadenceForPack(pack);
  const stepOne = steps.find((s) => s.step === 1);
  if (!stepOne) return { ...stats, skipped: true, reason: 'pack_has_no_cadence' };

  const today = toLocalIsoDay(now); // the host-local day the owner reads (audit F-11)
  const bounded = Math.min(Math.max(Number(limit) || DETECT_LIMIT, 1), 100);
  // The captured structured reference (migration 101 — G12's invoice-side
  // sibling) rides the same SELECT into the mint-time coalesce below. Pre-101
  // grace: on 42703 retry without the capture column, so the detector chases
  // exactly as before until the migration lands — never a whole-detector
  // skip for want of one column.
  const docCandidateSql = (withCapture) =>
    `select d.id, d.customer_name, d.due_date, d.total_amount, d.currency, d.reference_number,
            ${withCapture ? 'd.structured_reference' : 'null as structured_reference'}
       from documents d
      where d.firm_id = $1 and d.client_id = $2
        and d.document_type = 'sales_invoice'
        and coalesce(d.parse_status, 'completed') = 'completed'
        and d.payment_status = 'unpaid'
        and d.due_date is not null and d.due_date < $3::date
        and coalesce(d.total_amount, 0) > 0
        and not exists (
          select 1 from receivable_cases rc
           where rc.firm_id = d.firm_id and rc.client_id = d.client_id
             and rc.anchor_type = 'document' and rc.anchor_id = d.id)
      order by d.due_date asc
      limit $4`;
  let candidates;
  try {
    candidates = await client.query(docCandidateSql(true), [firmId, clientId, today, bounded])
      .then((r) => r.rows)
      .catch((error) => {
        if (error?.code !== '42703') throw error;
        return client.query(docCandidateSql(false), [firmId, clientId, today, bounded])
          .then((r) => r.rows);
      });
  } catch (error) {
    if (missingTables(error)) return { ...stats, skipped: true, reason: 'tables_absent' };
    throw error;
  }
  stats.scanned = candidates.length;

  // Issued-invoice lane (M2): Donna-issued invoices join the SAME chase
  // pipeline the day they run overdue — the promised loop closure ("US
  // issued invoices key in once M2 lands"). Soft-fails pre-065.
  let issuedCandidates = [];
  try {
    issuedCandidates = await client.query(
      `select ii.id, ii.buyer_name, ii.buyer_email,
              ii.draft->'invoice'->>'invoiceNumber' as invoice_number,
              ii.draft->'invoice'->>'dueDate' as due_date,
              ii.draft->'invoice'->>'currency' as currency,
              (ii.draft->'invoice'->>'total')::numeric as total_amount,
              coalesce(
                ii.draft->'finvoice'->'invoiceDetails'->>'referenceNumber',
                ii.draft->'finvoice'->'paymentDetails'->>'referenceNumber',
                ii.draft->'invoice'->>'referenceNumber'
              ) as reference_number
         from issued_invoices ii
        where ii.firm_id = $1 and ii.client_id = $2
          and ii.status = 'issued' and coalesce(ii.kind, 'invoice') = 'invoice'
          and (ii.draft->'invoice'->>'dueDate') is not null
          and (ii.draft->'invoice'->>'dueDate')::date < $3::date
          and coalesce((ii.draft->'invoice'->>'total')::numeric, 0) > 0
          and not exists (
            select 1 from receivable_cases rc
             where rc.firm_id = ii.firm_id and rc.client_id = ii.client_id
               and rc.anchor_type = 'issued_invoice' and rc.anchor_id = ii.id)
        order by (ii.draft->'invoice'->>'dueDate')::date asc
        limit $4`,
      [firmId, clientId, today, bounded]
    ).then((r) => r.rows);
  } catch (error) {
    if (!missingTables(error)) throw error;
  }
  stats.issued_scanned = issuedCandidates.length;
  if (!candidates.length && !issuedCandidates.length && mode === 'shadow') return stats;

  // Shadow lane: one would-open receipt, zero mutation (the executor's shape).
  if (mode === 'shadow') {
    stats.shadow_would_open = candidates.length + issuedCandidates.length;
    if (stats.shadow_would_open) {
      try {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'receivable_case.would_open', 'client', $2, $3::jsonb)`,
          [firmId, clientId, JSON.stringify({
            document_ids: candidates.map((d) => d.id),
            issued_invoice_ids: issuedCandidates.map((d) => d.id),
            count: stats.shadow_would_open
          })]
        );
      } catch { /* best-effort shadow receipt */ }
    }
    return stats;
  }

  const profile = clientRow.profile && typeof clientRow.profile === 'object' ? clientRow.profile : {};
  const ownerBusinessName = String(clientRow.company_name || '').trim();
  const paymentInstructions = String(profile.payment_instructions || '').trim();
  // D4: the payment block is resolvable when a standing instructions value
  // exists, OR a live pay-link already exists for the anchor, OR the
  // pay-link lane is on for this client (the sweep ensures the link before
  // the executor renders — detect → ensure links → execute).
  const payLinkLaneOn = payLinksGateMode({ snapshot, env }) === 'act'
    && Boolean(stripePayLinkAccountForProfile(profile));
  const paymentBlockResolvable = async (anchorType, anchorId) => {
    if (paymentInstructions) return true;
    if (payLinkLaneOn) return true;
    const link = await getActivePayLinkForAnchor(client, { firmId, clientId, anchorType, anchorId });
    return Boolean(link && (link.status === 'active' || link.status === 'settled'));
  };

  // The shared per-anchor mint motion (parsed + issued lanes + the re-mint
  // phase). Caller has already opened the per-candidate transaction.
  const evaluateAnchorCandidate = async ({
    anchorType, anchorId, displayName, email = null,
    invoiceNumber, referenceNumber = null, totalAmount, currency, dueDate,
    existingCaseId = null
  }) => {
    const anchorCurrency = String(currency || '').trim().toUpperCase();
    if (anchorCurrency !== homeCurrency) {
      // No silent caps: the skip is counted and logged; the reconcile
      // surfaces own the foreign-currency lane until a pack covers it.
      return { outcome: 'foreign_currency' };
    }

    const resolved = await resolvePartyCandidate(client, {
      firmId, clientId,
      candidate: {
        displayName, email, isCustomer: true,
        source: 'receivable_case_detector', sourceRef: anchorId
      }
    });
    if (!resolved.party) return { outcome: 'unresolvable_party' };
    const party = resolved.party;
    const language = languageForEntity(pack, party.preferred_language);

    // Everything the reminder template needs, pre-formatted per pack locale.
    const cleanNumber = String(invoiceNumber || '').trim();
    const cleanReference = String(referenceNumber || '').trim();
    const amountDue = formatPackAmount(pack, totalAmount, language);
    const dueDateDisplay = formatPackDate(pack, dueDate, language);
    const gaps = [];
    if (!cleanNumber) gaps.push('missing_invoice_number');
    // A reference-scheme pack states the payment reference in its reminders;
    // an anchor without one rests on the owner — never a reminder that would
    // refuse at render or state a wrong reference.
    if (referenceScheme !== 'none' && !cleanReference) gaps.push('missing_reference_number');
    if (!(await paymentBlockResolvable(anchorType, anchorId))) gaps.push('missing_payment_instructions');
    if (!ownerBusinessName) gaps.push('missing_owner_business_name');

    let caseRow;
    if (existingCaseId) {
      caseRow = { id: existingCaseId };
    } else {
      const opened = await openReceivableCase(client, {
        firmId, clientId, anchorType, anchorId,
        targetPartyId: party.id, packId,
        invoiceNumber: cleanNumber || null,
        amount: totalAmount, currency: anchorCurrency,
        dueDate: String(dueDate).slice(0, 10),
        statusReason: gaps.length ? gaps.join(',') : null
      });
      caseRow = opened.case;
      if (!opened.deduped && caseRow) stats.cases_opened += 1;
    }

    if (gaps.length) {
      if (existingCaseId) {
        await client.query(
          `update receivable_cases set status_reason = $2, updated_at = now()
            where id = $1`,
          [existingCaseId, gaps.join(',')]
        );
      }
      // The case rests open-with-a-named-gap; the G9 digest puts the gap on
      // the owner (a business fact only they can supply). No mint.
      return { outcome: 'needs_owner_input' };
    }

    const channels = await listPartyChannels(client, {
      firmId, clientId, partyId: party.id, activeOnly: true
    });
    const emails = channels.filter((c) => c.channel_kind === 'email');
    const recipient = (emails.find((c) => c.is_primary) || emails[0])?.normalized_value || null;
    const suppressed = recipient
      ? await isOutboundSuppressed(client, { firmId, clientId, channelKind: 'email', value: recipient })
      : false;
    if (!recipient) {
      await client.query(
        `update receivable_cases set status_reason = 'no_recipient_channel', updated_at = now()
          where id = $1`,
        [caseRow.id]
      );
      return { outcome: 'needs_owner_input' };
    }

    const paidTruth = typeof paidTruthCheck === 'function'
      ? await paidTruthCheck({
          client, firmId, clientId,
          action: { action_type: 'send_receivable_reminder', anchor_type: anchorType, anchor_id: anchorId }
        })
      : null;
    const gate = classifyOutboundAction({
      actionType: 'send_receivable_reminder', snapshot, env,
      suppressed, doNotContact: Boolean(party.do_not_contact),
      hasRecipient: true, paidTruth, confidence: null
    });
    const dueMs = Date.parse(`${String(dueDate).slice(0, 10)}T00:00:00Z`);
    const minted = await mintOutboundAction(client, {
      firmId, clientId, actionType: 'send_receivable_reminder',
      targetPartyId: party.id, anchorType, anchorId,
      packId, template: stepOne.template, language: party.preferred_language || null,
      payload: {
        due_date: String(dueDate).slice(0, 10),
        render_values: {
          owner_business_name: ownerBusinessName,
          invoice_number: cleanNumber,
          // Surfaced whenever the anchor carries one (scheme-generic); the
          // scheme gap above guarantees presence for scheme-declaring packs.
          reference_number: cleanReference || undefined,
          amount_due: amountDue,
          due_date: dueDateDisplay,
          // Absent when the D4 pay-link carries the payment block — the
          // executor resolves the pack's payment_link fragment at send time.
          payment_instructions: paymentInstructions || undefined
        }
      },
      amount: totalAmount, currency: anchorCurrency, confidence: null,
      gate, scheduledFor: new Date(Math.max(now, dueMs + stepOne.daysAfterDue * DAY_MS)).toISOString(),
      cadenceStep: 1, createdBy: 'receivable_case_detector'
    });
    if (existingCaseId && minted.action && minted.action.status !== 'cancelled') {
      await client.query(
        `update receivable_cases set status_reason = null, updated_at = now()
          where id = $1`,
        [existingCaseId]
      );
    }
    if (minted.action?.status === 'cancelled') {
      // Hard-blocked at mint (suppressed / do_not_contact): the honest stop.
      await syncReceivableCaseAfterCancel(client, {
        firmId, clientId, action: minted.action, reasons: gate.reasons
      });
    }
    return {
      outcome: 'minted',
      mintedNew: Boolean(minted.action && !minted.deduped)
    };
  };

  const applyOutcome = (result) => {
    if (result.outcome === 'foreign_currency') stats.skipped_foreign_currency += 1;
    else if (result.outcome === 'unresolvable_party') stats.skipped_unresolvable_party += 1;
    else if (result.outcome === 'needs_owner_input') stats.needs_owner_input += 1;
    else if (result.outcome === 'minted' && result.mintedNew) stats.actions_minted += 1;
  };

  for (const doc of candidates) {
    try {
      await client.query('begin');
      const result = await evaluateAnchorCandidate({
        anchorType: 'document', anchorId: doc.id,
        displayName: doc.customer_name,
        invoiceNumber: doc.reference_number,
        // The captured payment reference (101) — the generic coalesce the
        // issued lane already rides; absent, the scheme gap keeps resting
        // the case on the owner (fail-closed, never a guess).
        referenceNumber: doc.structured_reference || null,
        totalAmount: doc.total_amount, currency: doc.currency, dueDate: doc.due_date
      });
      applyOutcome(result);
      if (result.outcome === 'foreign_currency' || result.outcome === 'unresolvable_party') {
        await client.query('rollback');
      } else {
        await client.query('commit');
      }
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      try {
        logger.warn?.(`[receivableCases] detector failed for doc ${doc.id}: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }

  for (const inv of issuedCandidates) {
    try {
      // Settlement first, BEFORE a case exists: an issued invoice the guard
      // already sees settled never opens a chase (no open-then-cancel noise).
      const paidTruth = typeof paidTruthCheck === 'function'
        ? await paidTruthCheck({
            client, firmId, clientId,
            action: { action_type: 'send_receivable_reminder', anchor_type: 'issued_invoice', anchor_id: inv.id }
          })
        : null;
      if (paidTruth === 'settled') {
        stats.skipped_settled += 1;
        continue;
      }
      await client.query('begin');
      const result = await evaluateAnchorCandidate({
        anchorType: 'issued_invoice', anchorId: inv.id,
        displayName: inv.buyer_name, email: inv.buyer_email || null,
        invoiceNumber: inv.invoice_number,
        referenceNumber: inv.reference_number || null,
        totalAmount: inv.total_amount, currency: inv.currency, dueDate: inv.due_date
      });
      applyOutcome(result);
      if (result.outcome === 'foreign_currency' || result.outcome === 'unresolvable_party') {
        await client.query('rollback');
      } else {
        await client.query('commit');
      }
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      try {
        logger.warn?.(`[receivableCases] detector failed for issued invoice ${inv.id}: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }

  // Gap-resolution re-mint (M2, closes an M1 gap): a case that opened with a
  // named gap and never minted step 1 re-evaluates once the world may have
  // changed (owner set payment_instructions; D4 pay-links switched on; a
  // channel appeared). Still-gapped cases keep resting on the owner.
  // Same pre-101 grace as the candidates SELECT: the re-mint is how a case
  // that opened as missing_reference_number BEFORE a capture heals after one.
  const gapCaseSql = (withCapture) =>
    `select rc.id as case_id, rc.anchor_type, rc.anchor_id, rc.status_reason,
            d.customer_name as doc_customer_name, d.reference_number as doc_reference_number,
            ${withCapture
    ? 'd.structured_reference as doc_structured_reference'
    : 'null as doc_structured_reference'},
            d.total_amount as doc_total_amount, d.currency as doc_currency, d.due_date as doc_due_date,
            ii.buyer_name as inv_buyer_name, ii.buyer_email as inv_buyer_email,
            ii.draft->'invoice'->>'invoiceNumber' as inv_invoice_number,
            (ii.draft->'invoice'->>'total')::numeric as inv_total_amount,
            ii.draft->'invoice'->>'currency' as inv_currency,
            ii.draft->'invoice'->>'dueDate' as inv_due_date,
            coalesce(
              ii.draft->'finvoice'->'invoiceDetails'->>'referenceNumber',
              ii.draft->'finvoice'->'paymentDetails'->>'referenceNumber',
              ii.draft->'invoice'->>'referenceNumber'
            ) as inv_reference_number
       from receivable_cases rc
       left join documents d
         on rc.anchor_type = 'document' and d.id = rc.anchor_id
        and d.firm_id = rc.firm_id and d.client_id = rc.client_id
       left join issued_invoices ii
         on rc.anchor_type = 'issued_invoice' and ii.id = rc.anchor_id
        and ii.firm_id = rc.firm_id and ii.client_id = rc.client_id
      where rc.firm_id = $1 and rc.client_id = $2
        and rc.status = 'open' and rc.current_step = 0
        and rc.status_reason is not null
      order by rc.created_at asc
      limit $3`;
  let gapCases = [];
  try {
    gapCases = await client.query(gapCaseSql(true), [firmId, clientId, bounded])
      .then((r) => r.rows)
      .catch((error) => {
        if (error?.code !== '42703') throw error;
        return client.query(gapCaseSql(false), [firmId, clientId, bounded])
          .then((r) => r.rows);
      });
  } catch (error) {
    if (!missingTables(error)) throw error;
  }
  for (const gapCase of gapCases) {
    const isDoc = gapCase.anchor_type === 'document';
    const displayName = isDoc ? gapCase.doc_customer_name : gapCase.inv_buyer_name;
    const dueDate = isDoc ? gapCase.doc_due_date : gapCase.inv_due_date;
    if (!displayName || !dueDate) continue;
    try {
      await client.query('begin');
      const result = await evaluateAnchorCandidate({
        anchorType: gapCase.anchor_type, anchorId: gapCase.anchor_id,
        displayName,
        email: isDoc ? null : gapCase.inv_buyer_email || null,
        invoiceNumber: isDoc ? gapCase.doc_reference_number : gapCase.inv_invoice_number,
        referenceNumber: isDoc
          ? gapCase.doc_structured_reference || null
          : gapCase.inv_reference_number || null,
        totalAmount: isDoc ? gapCase.doc_total_amount : gapCase.inv_total_amount,
        currency: isDoc ? gapCase.doc_currency : gapCase.inv_currency,
        dueDate,
        existingCaseId: gapCase.case_id
      });
      if (result.outcome === 'minted' && result.mintedNew) stats.remint_minted += 1;
      if (result.outcome === 'foreign_currency' || result.outcome === 'unresolvable_party') {
        await client.query('rollback');
      } else {
        await client.query('commit');
      }
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      try {
        logger.warn?.(`[receivableCases] re-mint failed for case ${gapCase.case_id}: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }
  return stats;
};
