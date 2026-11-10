// Country-owned statutory readers, watches, filing lifecycles and mandates.
// Moved from db/statutory.js without changing the named writers or receipt contracts.
import { toLocalIsoDay, toUtcIsoDay } from '../dates.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { normalizeProfileJurisdiction, resolveProfileWriteJurisdiction } from '../profileValidation.js';
import { loadOpenStatutoryBlockers, mintStatutoryBlocker } from '../statutoryBlocker.js';
import { buildGbVatRegistrationWatch, buildGbVatThresholdEscalationQuestion, GB_VAT_THRESHOLD_EVIDENCE_TYPE, GB_VAT_THRESHOLD_WATCH_FLAG_KEY } from './vatRegistrationThreshold.js';
import { gbEntityType } from './entity.js';
import { evaluateGbLtdMonthlyClose, GB_LTD_CLOSE_BLOCKER_SURFACE, gbLtdMonthlyCloseEnabled } from './ltdMonthlyClose.js';
import { withFirmDbClient } from '../db/pool.js';
import { DEFAULT_FIRM_ID, requireClientInFirm } from '../db/clients.js';
import { rowToTransactionPayload } from '../db/transactions.js';
import { resolveClientFiscalYearTx } from '../db/close.js';
import { HMRC_MTD_VAT_FLAG_KEY } from '../db/hmrc.js';
import { deliverEvidenceAsksOnAllChannels } from '../db/asks.js';
import { attachFeedChatConvergence } from '../db/snapshot.js';


// ── GB gb_vat_registration_threshold — the drain ────────────────────────────
//
// The British sibling of drainFinlandAlvThresholdEscalations above, and the
// first GB statutory duty core can actually serve. Same shape by design (that
// sameness is the parallel build's evidence the obligations leg generalises
// rather than being a Finnish module with a British twin), with the two real
// differences the UK duty forces:
//
//   • the backward limb is a ROLLING 12 months, not a calendar year;
//   • there is a second, FORWARD limb with no FI analogue.
//
// One ask per (client, calendar year) — the deterministic id the mint keys on.
const gbVatThresholdAskId = ({ firmId, clientId, year }) =>
  `vat-threshold-${firmId}-${clientId}-${year}`;


// Both limbs in ONE pass so the two verdicts derive identically by construction.
// Windows, all against `asOf`: (asOf − 12 months, asOf] is the backward look;
// (asOf, asOf + 30 days] is the forward look. The forward window reads only
// ALREADY-POSTED revenue dated into it — a strictly conservative floor on
// "committed supplies", never a projection or a run-rate. See the honesty note
// in gb/vatRegistrationThreshold.js: a quiet forward limb means "nothing
// committed that we can see", never "no liability".
const __gbVatThresholdWatch = async ({ client, firmId, clientId, asOf }) => {
  const asOfDate = new Date(`${asOf}T00:00:00Z`);
  const backFrom = new Date(asOfDate); backFrom.setUTCFullYear(backFrom.getUTCFullYear() - 1);
  const forwardTo = new Date(asOfDate); forwardTo.setUTCDate(forwardTo.getUTCDate() + 30);
  // UTC on purpose: both window edges are stepped from the bare day `asOf`
  // in Date.UTC space — the host zone must not move them.
  const iso = (d) => toUtcIsoDay(d);

  const result = await client.query(
    `select
       coalesce(sum(case when lj.journal_date >  $3 and lj.journal_date <= $4
                         then ll.credit - ll.debit else 0 end), 0) as rolling_turnover,
       coalesce(sum(case when lj.journal_date >  $4 and lj.journal_date <= $5
                         then ll.credit - ll.debit else 0 end), 0) as committed_next_30
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1
        and ll.client_id = $2
        and la.account_type = 'revenue'
        and lj.status in ('posted', 'closed')
        and lj.journal_date >  $3
        and lj.journal_date <= $5`,
    [firmId, clientId, iso(backFrom), iso(asOfDate), iso(forwardTo)]
  );
  const row = result.rows[0] || {};
  return buildGbVatRegistrationWatch({
    asOf,
    rollingTurnover: Number(row.rolling_turnover) || 0,
    committedNext30Days: Number(row.committed_next_30) || 0
  });
};


// Runs on the jurisdiction-neutral statutory-obligation sweep (bound by name —
// core never imports gb/ directly). Sweeps config-plane candidates, re-gates
// each client authoritatively, and when the deterministic watch says `exceeded`
// mints ONE owner ask per calendar year (on conflict do nothing — an open ask
// is never re-nagged, a resolved ask stays answered for its year) with the
// audit event in the SAME transaction, then delivers over the existing
// WhatsApp evidence-ask substrate. Flag-off ⇒ zero candidates ⇒ no-op.
export const drainGbVatThresholdEscalations = async ({
  client,
  firmId = null,
  asOf = null,
  deliverAsksImpl = null
} = {}) => {
  // Host-local "today": the day the owner's wall clock says (audit F-11).
  const watchDate = asOf || toLocalIsoDay(new Date());
  const watchYear = Number(watchDate.slice(0, 4));
  const summary = { scanned: 0, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 0, errors: 0 };

  const candidateResult = await client.query(
    `select distinct c.firm_id, c.id as client_id, c.jurisdiction, c.profile
       from clients c
       join client_capability_config ccc
         on ccc.firm_id = c.firm_id
        and (ccc.client_id = c.id or ccc.client_id is null)
      where ccc.flag_key = $1
        and ccc.valid_to is null
        and ccc.stage in ('canary', 'auto')
        and ($2::text is null or c.firm_id = $2)`,
    [GB_VAT_THRESHOLD_WATCH_FLAG_KEY, firmId]
  );

  for (const candidate of candidateResult.rows) {
    summary.scanned += 1;
    try {
      // A capability flag is authority to run this watch, never country identity.
      if (normalizeProfileJurisdiction(resolveProfileWriteJurisdiction({ patch: {}, stored: candidate })) !== 'gb') {
        summary.skipped += 1;
        continue;
      }
      const snapshot = await readClientConfigSnapshot(client, { firmId: candidate.firm_id, clientId: candidate.client_id });
      const watchActs = clientFlagActs({ flagKey: GB_VAT_THRESHOLD_WATCH_FLAG_KEY, snapshot, envFallback: () => false });
      // A client on the MTD VAT lane is VAT-registered by definition — its
      // duties belong to the return lane, not to a registration watch.
      const mtdVatActs = clientFlagActs({ flagKey: HMRC_MTD_VAT_FLAG_KEY, snapshot, envFallback: () => false });
      if (!watchActs || mtdVatActs) {
        summary.skipped += 1;
        continue;
      }
      const watch = await __gbVatThresholdWatch({
        client, firmId: candidate.firm_id, clientId: candidate.client_id, asOf: watchDate
      });
      if (watch.status !== 'exceeded') continue;
      summary.exceeded += 1;

      const question = buildGbVatThresholdEscalationQuestion({ watch });
      const askId = gbVatThresholdAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, year: watchYear });
      await client.query('begin');
      let inserted = false;
      try {
        // Identity can change after discovery or turnover aggregation. Hold the
        // owning client row until commit so an old country cannot mint a new ask.
        const current = await client.query(
          'select jurisdiction, profile from clients where firm_id = $1 and id = $2 for share',
          [candidate.firm_id, candidate.client_id]
        );
        if (normalizeProfileJurisdiction(resolveProfileWriteJurisdiction({ patch: {}, stored: current.rows[0] })) !== 'gb') {
          await client.query('rollback');
          summary.skipped += 1;
          continue;
        }
        const insertResult = await client.query(
          `insert into client_evidence_requests (
             id, firm_id, client_id, status, evidence_type, question, request_payload,
             send_count, created_by
           )
           values ($1, $2, $3, 'open', $4, $5, $6::jsonb, 0, 'system')
           on conflict (id) do nothing
           returning id`,
          [
            askId, candidate.firm_id, candidate.client_id, GB_VAT_THRESHOLD_EVIDENCE_TYPE, question,
            JSON.stringify({
              kind: GB_VAT_THRESHOLD_EVIDENCE_TYPE,
              as_of: watchDate,
              year: watchYear,
              driving_limb: watch.drivingLimb,
              threshold_gbp: watch.thresholdGbp,
              rolling_turnover_gbp: watch.rollingTurnover,
              committed_next_30_days_gbp: watch.committedNext30Days
            })
          ]
        );
        inserted = insertResult.rows.length > 0;
        if (inserted) {
          // Audit-as-precondition: same transaction as the mint. The authority
          // basis is the firm's standing config-plane enable.
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, $2, 'system', 'system', 'vat_threshold.escalated', 'client_evidence_request', $3, $4::jsonb)`,
            [candidate.firm_id, candidate.client_id, askId, JSON.stringify({
              as_of: watchDate,
              year: watchYear,
              driving_limb: watch.drivingLimb,
              threshold_gbp: watch.thresholdGbp,
              rolling_turnover_gbp: watch.rollingTurnover,
              committed_next_30_days_gbp: watch.committedNext30Days,
              authority_basis: `client_capability_config:${GB_VAT_THRESHOLD_WATCH_FLAG_KEY}`
            })]
          );
        }
        await client.query('commit');
      } catch (mintError) {
        await client.query('rollback');
        throw mintError;
      }
      if (!inserted) {
        summary.skipped += 1;
        continue;
      }
      summary.minted += 1;
      // The ONE gated fan-out (ownerAskDelivery.js): a send-contained client
      // is held and the refusal receipted; only a deliverer that delivered
      // stamps the ask (the mint above writes no sent stamp). WhatsApp only:
      // the one channel this question has always gone out on.
      const deliver = deliverAsksImpl
        || ((args) => deliverEvidenceAsksOnAllChannels({ client, ...args, surface: 'gb_vat_threshold', channels: ['whatsapp'] }));
      const delivery = await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
      if (Array.isArray(delivery?.delivered) && delivery.delivered.includes(askId)) summary.delivered += 1;
      else if (delivery?.refused) summary.held += 1;
    } catch (error) {
      summary.errors += 1;
    }
  }
  return summary;
};


// UK audit ④ — the GB Ltd balance-sheet watch signals, the Oy loader's twin
// with one structural difference: GB accounts resolve by CANONICAL ROLE from
// the client's own chart (synced or the optional Donna default), never by
// hardcoded statutory codes — there is no GB statutory chart to key on.
// Multiple accounts on a role SUM: watches detect a balance, they never pick
// an account to post to. The four control-DIFFERENCE signals (VAT / CT /
// fixed-asset / bank) need comparators that do not exist yet, so they stay
// absent — their close items then rest on the owner as "not established"
// rather than pretending a reconciliation ran.
const loadGbLtdBalanceSheetWatchSignalsTx = async ({ client, firmId, clientId, asOf }) => {
  const byType = await client.query(
    `select la.account_type, coalesce(sum(ll.debit - ll.credit), 0) as net
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1 and ll.client_id = $2 and lj.status in ('posted', 'closed')
        and lj.journal_date <= $3::date
        and la.account_type in ('asset', 'bank', 'liability')
      group by la.account_type`,
    [firmId, clientId, asOf]
  );
  const netOf = (type) => Number(byType.rows.find((r) => r.account_type === type)?.net) || 0;
  // Assets are debit-normal (positive signed net), liabilities credit-normal
  // (negative signed net when owed), so the plain sum IS assets − liabilities.
  const netAssets = netOf('asset') + netOf('bank') + netOf('liability');

  const byRole = await client.query(
    `select la.canonical_role, coalesce(sum(ll.debit - ll.credit), 0) as net, min(lj.journal_date) as min_date
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1 and ll.client_id = $2 and lj.status in ('posted', 'closed')
        and lj.journal_date <= $3::date
        and la.canonical_role in ('liability.director_loan', 'control.suspense')
      group by la.canonical_role`,
    [firmId, clientId, asOf]
  );
  const roleRow = (role) => byRole.rows.find((r) => r.canonical_role === role) || null;
  const director = roleRow('liability.director_loan');
  const suspense = roleRow('control.suspense');
  // A positive signed net on the credit-normal director-loan role is a DEBIT
  // balance: the company has lent to the director — the watch's subject.
  const directorNet = Number(director?.net) || 0;
  return {
    netAssets,
    ...(directorNet > 0
      ? {
          directorLoanDebit: directorNet,
          directorLoanOldestOpenDate: director?.min_date ? String(director.min_date).slice(0, 10) : null
        }
      : {}),
    ...(suspense ? { suspenseBalance: Number(suspense.net) || 0 } : {})
  };
};


// UK audit ④ — the GB Ltd monthly-close consumer, mounted beside its FI twin
// above (same shape: entity gate → flag gate → detection inputs → pure
// evaluator → concrete-only blocker mint). Differences, each deliberate:
// - genericCloseItems come from the ONE convergence projection
//   (attachFeedChatConvergence): every feed row up to asOf must be
//   auto_reconciled to be non-blocking; a hanging row or an open owner ask
//   blocks the close with the row ids as evidence. No second projection.
// - accountingPeriodEnd resolves through resolveClientFiscalYearTx (the ARD
//   machinery): persisted registry first, else derived from incorporation;
//   its named refusals propagate — a close never assumes a calendar year.
// - confirmation_review_period_end / vat_stagger / completion_evidence read
//   from profile.gb; NOTHING writes them yet, so today the deadline
//   arithmetic refuses with its named 422s — exactly the owner facts GB
//   onboarding must capture. That refusal is honest darkness, not a bug.
// - Mint discrimination is evidence-based: an on_owner item WITH evidence is
//   concrete (a fired watch, an overdue window, unresolved feed rows, an
//   open blocker elsewhere) and reaches the durable store; an on_owner item
//   WITHOUT evidence is an absent-signal coverage gap (the FI
//   pending_upstream posture) and is surfaced but never minted.
// - This surface's own open blockers are EXCLUDED from the
//   unresolved_judgment_items input — they are the close's output; feeding
//   them back would make the close unclosable by construction.
// Entity-gated to gb-ltd (409), flag-gated GB_LTD_MONTHLY_CLOSE (config
// plane, dark). Green-now: no gb-ltd client exists, so it only runs behind
// an explicit canary.
export const getGbLtdMonthlyCloseFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  persist = true,
  actorType = 'system',
  actorId = null,
  withFirmDbClientFn = withFirmDbClient,
  attachConvergenceFn = attachFeedChatConvergence
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the GB Ltd monthly close.');
    error.statusCode = 400;
    throw error;
  }
  const asOf = String(readAt || new Date().toISOString()).slice(0, 10);
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const clientResult = await client.query(
      `select entity_type, incorporation_date, profile from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const clientRow = clientResult.rows[0] || {};
    if (gbEntityType({ entity_type: clientRow.entity_type, profile: clientRow.profile }) !== 'ltd') {
      const error = new Error('GB Ltd monthly close applies only to a gb-ltd client.');
      error.statusCode = 409;
      error.code = 'GB_LTD_MONTHLY_CLOSE_ENTITY_NOT_LTD';
      throw error;
    }
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    if (!gbLtdMonthlyCloseEnabled({ snapshot })) {
      const error = new Error('GB Ltd monthly close requires GB_LTD_MONTHLY_CLOSE for this client.');
      error.statusCode = 403;
      error.code = 'GB_LTD_MONTHLY_CLOSE_DISABLED';
      throw error;
    }

    const fiscalYear = await resolveClientFiscalYearTx({
      client,
      firmId,
      clientId,
      date: asOf,
      incorporationDate: clientRow.incorporation_date || null,
      entityType: clientRow.entity_type
    });
    const gbProfile = (clientRow.profile && clientRow.profile.gb) || {};

    const txResult = await client.query(
      `select * from transactions
        where firm_id = $1 and client_id = $2 and transaction_date <= $3::date
        order by transaction_date, created_at`,
      [firmId, clientId, asOf]
    );
    const feedRows = txResult.rows.map(rowToTransactionPayload);
    await attachConvergenceFn({ firmId, clientId, rows: feedRows });
    const genericCloseItems = feedRows.map((tx) => ({
      id: tx.id,
      disposition: null,
      blocks_close: tx.convergence_state !== 'auto_reconciled',
      reason_code: tx.convergence_reason || tx.convergence_state || null
    }));

    const openBlockers = await loadOpenStatutoryBlockers({ client, firmId, clientId });
    const externalBlockers = openBlockers.filter((b) => b.surface !== GB_LTD_CLOSE_BLOCKER_SURFACE);
    const itemSignals = {
      unresolved_judgment_items: externalBlockers.length
        ? {
            status: 'blocked',
            reason: 'Open statutory blockers rest unresolved on this client.',
            evidence: externalBlockers.map((b) => ({ id: b.id, surface: b.surface, reason_code: b.reason_code }))
          }
        : { status: 'settled', reason: 'No open statutory blockers rest on this client elsewhere.' }
    };

    const balanceSheetSignals = await loadGbLtdBalanceSheetWatchSignalsTx({ client, firmId, clientId, asOf });

    const close = evaluateGbLtdMonthlyClose({
      accountingPeriodEnd: fiscalYear.ends_on,
      confirmationReviewPeriodEnd: gbProfile.confirmation_review_period_end || null,
      vatStagger: gbProfile.vat_stagger ?? null,
      asOf,
      genericCloseItems,
      itemSignals,
      balanceSheetSignals,
      completionEvidence: gbProfile.completion_evidence || {}
    });

    const minted = [];
    if (persist) {
      for (const item of close.items) {
        if (item.terminal !== 'on_owner') continue;
        if (item.evidence === null || item.evidence === undefined) continue;
        const cappedEvidence = Array.isArray(item.evidence) && item.evidence.length > 50
          ? { first: item.evidence.slice(0, 50), total: item.evidence.length }
          : item.evidence;
        try {
          const result = await mintStatutoryBlocker({
            client,
            firmId,
            clientId,
            surface: item.blocker_surface,
            reasonCode: item.reason_code,
            severity: item.severity,
            assignedTo: item.blockerAssignee,
            entityType: 'ltd',
            detail: { close_item: item.id, reason: item.reason, evidence: cappedEvidence, as_of: asOf },
            actorType,
            actorId,
            reason: `gb_ltd_monthly_close:${item.reason_code}`
          });
          if (result) minted.push({ item: item.id, id: result.id, inserted: result.inserted, status: result.status });
        } catch {
          // Best-effort: a mint failure never poisons the close read (the FI
          // twin's posture). The verdict still names the owner.
        }
      }
    }

    return {
      close,
      minted,
      open_blockers: openBlockers.map((b) => ({ id: b.id, surface: b.surface, reason_code: b.reason_code, severity: b.severity, assigned_to: b.assigned_to, status: b.status })),
      provenance: { source: 'posted_ledger+fiscal_registry+convergence_projection+statutory_blockers', surface: GB_LTD_CLOSE_BLOCKER_SURFACE, deterministic: true, readAt: readAt || null, as_of: asOf, persisted: Boolean(persist) }
    };
  });
};

// Named statutory operations consumed through the country registry.
export { getGbStatutoryReportFromDb, buildGbLtdCloseRefusalEnvelope } from './statutoryReport.js';
export { prepareGbVatReturnFromDb } from './vatReturnRoute.js';

import { prepareGbVatReturnWithClient } from './vatReturnRoute.js';

// Country-owned owner-surface profile mapping; the shared dispatcher selects
// this operation without knowing this country's registration/profile fields.
export const prepareOwnerVatReturnWithClient = ({ client, firmId, clientId, periodKey, asOf, profile }) =>
  prepareGbVatReturnWithClient({
    client, firmId, clientId, periodKey, asOf,
    vatRegistration: profile?.vat_registration
  });
