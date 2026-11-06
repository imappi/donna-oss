// M4 — payables chasing (execution plan §1 M4; the last Phase-1 milestone).
// The upcoming-payables detector: supplier bills already flowing through the
// AP lane (documents.document_type = 'supplier_bill' + due dates) become
// OWNER-DIRECTED send_payable_notice actions — "supplier bill due in N days —
// schedule payment?" — on THE existing pipeline. Zero new pipeline: the mint
// goes through classifyOutboundAction and mintOutboundAction; the send runs
// through THE executor (whose owner-directed branch resolves the OWNER's
// profile email as the recipient — a third-party send is structurally
// impossible for this action type).
//
// Trust posture (M4's point in the plan): the deliverer is the owner
// channels — the lowest trust requirement in the whole action family. At an
// acting stage the notice goes straight to the owner (decide-and-notify: the
// recipient IS the approver); 'shadow' receipts would-notices with zero
// mutation; 'off'/'dry_run' stay dark. The OUTBOUND_PAYABLES 'auto' terminal
// stays in AUTO_FORBIDDEN_FLAGS — untouched here; it governs unattended
// third-party sends, which this lane structurally cannot make.
//
// The notice window (how many days before due a bill surfaces) is a tuning
// knob — OUTBOUND_PAYABLE_NOTICE_LEAD_DAYS, env-legitimate per the
// rollout-flags rail (behaviour gates live on the config plane; the window
// only tunes WHEN within the gated behaviour).
//
// One notice per bill (idempotency key at cadence step 0); a declined notice
// stays declined — the owner said no, and the dedupe keeps it that way. A
// bill that settles before send time cancels at the executor's payable
// anchor interlock.
//
// Keep-layer posture: deterministic scans and refusals; no LLM call.

import { readClientConfigSnapshot } from '../clientConfig.js';
import {
  loadOutboundPack, resolvePackIdForJurisdiction, formatPackAmount, formatPackDate,
  languageForEntity
} from './packs.js';
import { classifyOutboundAction, outboundGateMode } from './actionGate.js';
import { resolvePartyCandidate } from './partyStore.js';
import { mintOutboundAction } from './actionStore.js';
import { resolveOwnerReplyTo } from './sendingIdentity.js';
import { toLocalIsoDay } from '../dates.js';

const DETECT_LIMIT = 25;
const DEFAULT_LEAD_DAYS = 7;

// The env knob is tuning only (window width); clamp keeps a typo from
// scanning a year of bills or none at all.
export const payableNoticeLeadDays = (env = process.env) => {
  const raw = Number(env?.OUTBOUND_PAYABLE_NOTICE_LEAD_DAYS);
  if (!Number.isInteger(raw)) return DEFAULT_LEAD_DAYS;
  return Math.min(Math.max(raw, 1), 60);
};

export const detectUpcomingPayables = async ({
  client, firmId, clientId, env = process.env,
  now = Date.now(), limit = DETECT_LIMIT, logger = console
} = {}) => {
  const stats = {
    skipped: false, scanned: 0, notices_minted: 0, shadow_would_notice: 0,
    skipped_foreign_currency: 0, skipped_unresolvable_party: 0,
    skipped_missing_owner_email: 0, skipped_missing_owner_name: 0, errors: 0
  };
  if (!client || !firmId || !clientId) return { ...stats, skipped: true, reason: 'missing_args' };

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const { mode } = outboundGateMode({ actionType: 'send_payable_notice', snapshot, env });
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
  const language = languageForEntity(pack, pack.languages.default);

  const leadDays = payableNoticeLeadDays(env);
  // Host-local calendar days: "today" is the day the owner reads on the wall
  // clock, and the horizon is lead days past it (audit F-11).
  const today = toLocalIsoDay(now);
  const horizon = toLocalIsoDay(now + leadDays * 86400000);
  const bounded = Math.min(Math.max(Number(limit) || DETECT_LIMIT, 1), 100);

  let candidates;
  try {
    candidates = await client.query(
      `select d.id, d.vendor_name, d.due_date, d.total_amount, d.currency
         from documents d
        where d.firm_id = $1 and d.client_id = $2
          and d.document_type = 'supplier_bill'
          and coalesce(d.parse_status, 'completed') = 'completed'
          and d.payment_status = 'unpaid'
          and d.due_date is not null
          and d.due_date >= $3::date and d.due_date <= $4::date
          and coalesce(d.total_amount, 0) > 0
          and not exists (
            select 1 from outbound_actions oa
             where oa.firm_id = d.firm_id and oa.client_id = d.client_id
               and oa.action_type = 'send_payable_notice'
               and oa.anchor_type = 'document' and oa.anchor_id = d.id)
        order by d.due_date asc
        limit $5`,
      [firmId, clientId, today, horizon, bounded]
    ).then((r) => r.rows);
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return { ...stats, skipped: true, reason: 'tables_absent' };
    }
    throw error;
  }
  stats.scanned = candidates.length;
  if (!candidates.length) return stats;

  // Shadow lane: one aggregate would-notice receipt, zero mutation.
  if (mode === 'shadow') {
    stats.shadow_would_notice = candidates.length;
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'payable_notice.would_notice', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({
          document_ids: candidates.map((d) => d.id), count: candidates.length
        })]
      );
    } catch { /* best-effort shadow receipt */ }
    return stats;
  }

  // Client-level gaps: an owner-directed notice needs the owner's email and
  // business name. These are profile facts, not per-bill facts — count and
  // audit once, don't mint per-bill cancelled noise.
  const profile = clientRow.profile && typeof clientRow.profile === 'object' ? clientRow.profile : {};
  const ownerEmail = resolveOwnerReplyTo(profile);
  const ownerBusinessName = String(clientRow.company_name || '').trim();
  if (!ownerEmail || !ownerBusinessName) {
    if (!ownerEmail) stats.skipped_missing_owner_email = candidates.length;
    else stats.skipped_missing_owner_name = candidates.length;
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'payable_notice.owner_profile_gap', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({
          missing: !ownerEmail ? 'owner_email' : 'owner_business_name',
          document_ids: candidates.map((d) => d.id)
        })]
      );
    } catch { /* best-effort */ }
    return stats;
  }

  for (const bill of candidates) {
    try {
      const billCurrency = String(bill.currency || '').trim().toUpperCase();
      if (billCurrency !== homeCurrency) {
        // No silent caps: counted; the AP surfaces own foreign-currency bills
        // until a pack covers them (the receivables detector's posture).
        stats.skipped_foreign_currency += 1;
        continue;
      }
      await client.query('begin');
      const resolved = await resolvePartyCandidate(client, {
        firmId, clientId,
        candidate: {
          displayName: bill.vendor_name, isSupplier: true,
          source: 'payable_notice_detector', sourceRef: bill.id
        }
      });
      if (!resolved.party) {
        await client.query('rollback');
        stats.skipped_unresolvable_party += 1;
        continue;
      }
      const gate = classifyOutboundAction({
        actionType: 'send_payable_notice', snapshot, env,
        suppressed: false, doNotContact: false,
        hasRecipient: true, paidTruth: null, confidence: null
      });
      const minted = await mintOutboundAction(client, {
        firmId, clientId, actionType: 'send_payable_notice',
        targetPartyId: resolved.party.id,
        anchorType: 'document', anchorId: bill.id,
        packId, template: 'payable_notice',
        // Owner-directed: render in the pack's default language (the owner's
        // market language), never a supplier preference.
        language: pack.languages.default,
        payload: {
          due_date: String(bill.due_date).slice(0, 10),
          render_values: {
            owner_business_name: ownerBusinessName,
            amount_due: formatPackAmount(pack, bill.total_amount, language),
            due_date: formatPackDate(pack, bill.due_date, language)
          }
        },
        amount: bill.total_amount, currency: billCurrency, confidence: null,
        gate, scheduledFor: new Date(now).toISOString(),
        cadenceStep: 0, createdBy: 'payable_notice_detector'
      });
      await client.query('commit');
      if (minted.action && !minted.deduped && minted.action.status !== 'cancelled') {
        stats.notices_minted += 1;
      }
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      try {
        logger.warn?.(`[payableNotices] detector failed for bill ${bill.id}: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }
  return stats;
};
