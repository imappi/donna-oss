// Country-owned statutory readers, watches, filing lifecycles and mandates.
// Moved from db/statutory.js without changing the named writers or receipt contracts.
import { toUtcIsoDay } from '../dates.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { normalizeProfileJurisdiction, resolveProfileWriteJurisdiction } from '../profileValidation.js';
import { FINLAND_ANNUAL_RETURN_FLAG_KEY, FINLAND_OPENING_BALANCES_FLAG_KEY, FINLAND_TILIKAUSI_FLAG_KEY, resolveFiscalYear } from './tilikausi.js';
import { buildAnnualReturnFromReadModel } from './annualReturn.js';
import { assertFinlandToiminimiOnly, FINLAND_ENTITY_FAIL_CLOSED_FLAG_KEY, finlandEntityType } from './entity.js';
import {
  FORM5_OY_UNSUPPORTED_RESOLUTION_PATH
} from './statutoryBlocker.js';
import {
  loadOpenStatutoryBlockers,
  mintStatutoryBlocker
} from '../statutoryBlocker.js';
import { evaluateAcceptanceEnvelope } from './acceptanceEnvelope.js';
import { readFinlandOyCapabilities } from './oyCapabilities.js';
import { deriveOwnershipEnvelopeAttributes, loadCapTableAsOf } from './ownership.js';
import { authorityBasisGaps, deriveAuthorityEnvelopeAttributes, loadAuthorityRolesAsOf } from './authority.js';
import { evaluateOyYelApplicability, FINLAND_OY_YEL_APPLICABILITY_FLAG_KEY } from './oyYelApplicability.js';
import { evaluateOyBalanceSheetWatches, FINLAND_OY_BALANCE_SHEET_WATCHES_FLAG_KEY } from './oyBalanceSheetWatches.js';
import { evaluateOyMonthlyClose, FINLAND_OY_MONTHLY_CLOSE_FLAG_KEY, OY_CLOSE_BLOCKER_SURFACE } from './oyMonthlyClose.js';
import { OY_WATCH_ACCOUNT_CODES } from './tilikartta.js';
import { evaluateTaxAdjustments } from './taxAdjustments.js';
import { CUTOVER_CONTROL_CODES, cutoverNetWorthForTaxYear, evaluateCutoverPack } from './cutover.js';
import { evaluateEvlDepreciation } from './evlDepreciation.js';
import { alvReturnBoxMapProvenance, buildAlvReturnFromLedgerLines, FINLAND_ALV_FILING_FLAG_KEY, FINLAND_ALV_RETURN_FLAG_KEY, resolveAlvPeriod, verokausiBasisForProfile } from './alvReturn.js';
import { alvReturnConfirmQuestion } from './alvReturnRoute.js';
import { FINLAND_ALV_CODING_FLAG_KEY } from './alvCodes.js';
import { evaluateSuomifiMandate, SUOMIFI_MANDATE_SCOPE_TAX } from './suomifiMandate.js';
import { evaluateYelStatus, FINLAND_YEL_WATCH_FLAG_KEY, matchYelInsurers, YEL_INSURER_SQL_PATTERN } from './yel.js';
import { buildPrepaymentRegisterEscalationQuestion, evaluateOwnPrepaymentRegister, evaluateSupplierPrepaymentRegister, FINLAND_PREPAYMENT_REGISTER_WATCH_FLAG_KEY, normalizePrepaymentRegisterCheck, PREPAYMENT_REGISTER_EVIDENCE_TYPE, PREPAYMENT_REGISTER_SUPPLIER_LOOKBACK_DAYS } from './prepaymentRegister.js';
import { ENNAKKOVERO_PAYMENT_SQL_PATTERN, evaluateEnnakkoveroStatus, FINLAND_ENNAKKOVERO_WATCH_FLAG_KEY, forecastBusinessProfit, hasEnnakkoveroPayments } from './ennakkovero.js';
import { CASH_ACCOUNT_CODES, EU_OR_IMPORT_TAX_CODES, EU_REVENUE_ACCOUNT_CODES, evaluateScopeDrift, FINLAND_SCOPE_DRIFT_WATCH_FLAG_KEY, INVENTORY_ACCOUNT_CODES, matchProcessors, PERSONNEL_ACCOUNT_CODES, PROCESSOR_SQL_PATTERN, REVERSE_CHARGE_TAX_CODES, SCOPE_DRIFT_EVIDENCE_TYPE } from './scopeDrift.js';
import { ALV_THRESHOLD_EVIDENCE_TYPE, buildAlvRegistrationWatch, buildAlvThresholdEscalationQuestion, FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY } from './alvRegistrationThreshold.js';
import { withFirmDbClient } from '../db/pool.js';
import { shortHash } from '../db/shared.js';
import { clientAccountingBasisFromProfile, DEFAULT_FIRM_ID, getClientOwnerLanguageInDb, requireClientInFirm } from '../db/clients.js';
import { deliverEvidenceAsksOnAllChannels, rowToClientEvidenceRequestPayload } from '../db/asks.js';
import { rowToLedgerLinePayload } from '../db/ledger.js';
import { getLedgerPeriodPreviewFromDb } from '../db/close.js';
import { readRecognitionGapWithClient, recognitionStatement, ensureSettlementShortfallAsksWithClient } from '../salesRecognitionGap.js';
import { readOpenCodingCorrectionsWithClient } from '../postedCorrectionGap.js';

// Every owner question these Finnish flows raise is delivered through the ONE
// gated fan-out (db/asks.js deliverEvidenceAsksOnAllChannels, gated by
// ownerAskDelivery.js): a send-contained client is held and the refusal is
// receipted ('evidence_request.send_refused', naming the surface), and only a
// deliverer that really delivered moves send_count / first_sent_at /
// last_sent_at. A mint here writes no sent stamp. WhatsApp only: the one
// channel these questions have always gone out on.
const STATUTORY_ASK_CHANNELS = Object.freeze(['whatsapp']);
const deliverStatutoryAsks = ({ client, surface, ...args }) =>
  deliverEvidenceAsksOnAllChannels({ client, ...args, surface, channels: STATUTORY_ASK_CHANNELS });
const deliveredAsk = (result, askId) => Array.isArray(result?.delivered) && result.delivered.includes(askId);


const dayBeforeIso = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  // UTC on purpose: a bare calendar day stepped back in Date.UTC space —
  // the host zone must not move it.
  return toUtcIsoDay(d);
};


const annualReturnReadyEnvelope = ({ taxYear, tilikausi, basis, annualReturn, readAt, blockers = [], cutover = null, evlDepreciation = null }) => {
  const unmappedIncomeStatementRows = Array.isArray(annualReturn?.unmappedIncomeStatementRows)
    ? annualReturn.unmappedIncomeStatementRows
    : [];
  const nonDeductibleIncomeTaxes = Number(annualReturn?.nonDeductibleIncomeTaxes) || 0;
  const allBlockers = [...blockers];
  if (unmappedIncomeStatementRows.length) allBlockers.push('unmapped_income_rows');
  const blocking = allBlockers.filter((b) => b !== 'no_prior_year_end');
  return {
    taxYear,
    tilikausi,
    basis,
    return: annualReturn,
    // G-10: recorded-at-cutover facts surfaced with the return, bounded-honesty
    // framing — Vero deducts vahvistetut tappiot in assessment; Donna records
    // them and never computes the offset. Absent pack ⇒ key absent (additive).
    ...(cutover
      ? {
          cutover: {
            confirmed_losses_on_record: Array.isArray(cutover.confirmed_losses) ? cutover.confirmed_losses : [],
            fixed_asset_tax_bases: Array.isArray(cutover.fixed_assets) ? cutover.fixed_assets : [],
            losses_note_fi: Array.isArray(cutover.confirmed_losses) && cutover.confirmed_losses.length
              ? 'Vahvistetut tappiot vähennetään verotuksessa — Donna kirjaa ne muistiin, Verohallinto tekee vähennyksen.'
              : null
          }
        }
      : {}),
    // F-G10-3: the EVL 30 § maximum-depreciation verdict (computed from the
    // cutover-recorded bases; proposal-grade, never elects, changes no figure).
    // Absent pack/bases ⇒ key absent (additive, byte-identical).
    ...(evlDepreciation ? { evl_depreciation: evlDepreciation } : {}),
    review: {
      status: blocking.length ? 'needs_review' : 'ready',
      blockers: allBlockers,
      nonDeductibleIncomeTaxes,
      unmappedIncomeStatementRows
    },
    provenance: { source: 'ledger_read_model', readAt: readAt || null, deterministic: true }
  };
};


export const getFinlandAnnualReturnFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  taxYear,
  basis,
  additionalDeductions = {},
  capitalReturnRate = 0.2,
  readAt = null,
  readModelGetter = getLedgerPeriodPreviewFromDb,
  fiscalYearResolver = resolveFiscalYear,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a Finland annual return.');
    error.statusCode = 400;
    throw error;
  }
  const normalizedTaxYear = Number(taxYear);
  if (!Number.isInteger(normalizedTaxYear)) {
    const error = new Error('Tax year is required for a Finland annual return.');
    error.statusCode = 400;
    throw error;
  }

  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const annualReturnActs = clientFlagActs({ flagKey: FINLAND_ANNUAL_RETURN_FLAG_KEY, snapshot, envFallback: () => false });
    const tilikausiActs = clientFlagActs({ flagKey: FINLAND_TILIKAUSI_FLAG_KEY, snapshot, envFallback: () => false });
    if (!annualReturnActs || !tilikausiActs) {
      const error = new Error('Finland annual return requires FINLAND_ANNUAL_RETURN (and FINLAND_TILIKAUSI) for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_ANNUAL_RETURN_DISABLED';
      throw error;
    }

    const clientRow = await client.query(
      `select incorporation_date, profile from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const row = clientRow.rows[0] || {};
    // FI-13 (C1) — hard fail-safe INSIDE the reader: an osakeyhtiö files
    // veroilmoitus 6B, never the elinkeinonharjoittaja form 5. Refuse an
    // explicit fi-oy rather than silently emit a legally wrong return. No extra
    // read (profile is already in hand); byte-identical for toiminimi/unknown.
    //
    // 13.0b — the refusal is no longer a bare 409: it MINTS a StatutoryBlocker
    // so the blocked obligation rests on a named party (the firm, to correct the
    // legal form or build the Oy lane) until resolved — two-terminal-states,
    // D-FI13-2. The mint is best-effort and must NEVER mask the refusal: if the
    // store is missing or the mint fails, the guard still refuses.
    //
    // 13.0b flip — fail-closed-on-unknown, config-gated (dark by default). With
    // FINLAND_ENTITY_FAIL_CLOSED acting for this client, an UNRESOLVED legal form
    // (not fi-toiminimi/fi-oy) is refused too, rather than silently served the
    // form-5. OFF by default ⇒ byte-identical to 13.0a (unknown → toiminimi). The
    // fi-oy refusal is unconditional regardless of the flag.
    const failClosedOnUnknown = clientFlagActs({
      flagKey: FINLAND_ENTITY_FAIL_CLOSED_FLAG_KEY,
      snapshot,
      envFallback: () => false
    });
    try {
      assertFinlandToiminimiOnly({
        client: row,
        code: 'FINLAND_ANNUAL_RETURN_ENTITY_UNSUPPORTED',
        unknownCode: 'FINLAND_ANNUAL_RETURN_ENTITY_UNKNOWN',
        surface: 'The elinkeinonharjoittaja annual return (form 5)',
        surfaceFi: 'Elinkeinonharjoittajan veroilmoitus (lomake 5)',
        failClosedOnUnknown
      });
    } catch (refusal) {
      // Both refusal kinds mint a firm-assigned legal_violation blocker: an Oy
      // reached the form-5 lane, or a Finnish client has no resolved legal form.
      const blockerByEntity = {
        oy: {
          reasonCode: 'entity_unsupported_annual_return',
          // Shared with the proactive quarantine-on-identification mint
          // (createClientInDb → mintForm5OyQuarantineBlocker) so the read-path
          // refusal and the identification-time mint collapse to ONE durable row
          // whose resolution_path never flip-flops on the ON CONFLICT update.
          resolutionPath: FORM5_OY_UNSUPPORTED_RESOLUTION_PATH
        },
        unknown: {
          reasonCode: 'entity_type_unknown',
          resolutionPath:
            "Set the client's Finnish legal form (fi-toiminimi or fi-oy) before " +
            'generating a statutory return. Without a resolved legal form no ' +
            'statutory artifact can be produced.'
        }
      };
      const spec = refusal?.statusCode === 409 ? blockerByEntity[refusal?.entityType] : null;
      if (spec) {
        try {
          const minted = await mintStatutoryBlocker({
            client,
            firmId,
            clientId,
            surface: 'finland_annual_return',
            reasonCode: spec.reasonCode,
            severity: 'legal_violation',
            assignedTo: 'firm',
            entityType: refusal.entityType,
            resolutionPath: spec.resolutionPath,
            detail: {
              code: refusal.code,
              message: refusal.message,
              message_fi: refusal.fi,
              tax_year: normalizedTaxYear
            },
            reason: `annual_return_refused_for_${refusal.entityType}`
          });
          if (minted?.id) refusal.blockerId = minted.id;
        } catch (mintError) {
          // The refusal is load-bearing; a failed mint must not mask it.
          console.warn('[finland] statutory blocker mint failed on annual-return refusal', mintError?.message || mintError);
        }
      }
      throw refusal;
    }
    const resolvedBasis = basis || clientAccountingBasisFromProfile(row);
    const incorporationDate = row.incorporation_date || row.profile?.incorporationDate || row.profile?.incorporation_date || null;
    if (!incorporationDate) {
      return annualReturnReadyEnvelope({
        taxYear: normalizedTaxYear,
        tilikausi: null,
        basis: resolvedBasis,
        readAt,
        blockers: ['missing_incorporation_date'],
        annualReturn: buildAnnualReturnFromReadModel({
          taxYear: normalizedTaxYear,
          profitAndLoss: { rows: [] },
          priorYearEndBalanceSheet: null,
          additionalDeductions,
          capitalReturnRate
        })
      });
    }

    const tilikausi = fiscalYearResolver({ date: `${normalizedTaxYear}-12-31`, incorporationDate });
    const priorTilikausi = tilikausi?.starts_on === incorporationDate
      ? null
      : fiscalYearResolver({ date: dayBeforeIso(tilikausi.starts_on), incorporationDate });
    const current = await readModelGetter({
      firmId,
      clientId,
      periodStart: tilikausi.starts_on,
      periodEnd: tilikausi.ends_on,
      basis: resolvedBasis
    });
    const prior = priorTilikausi
      ? await readModelGetter({
          firmId,
          clientId,
          periodStart: priorTilikausi.starts_on,
          periodEnd: priorTilikausi.ends_on,
          basis: resolvedBasis
        })
      : null;

    const priorBalanceSheetFoots = !prior || prior.balance_sheet?.balanced !== false;
    const blockers = [];
    if (!priorTilikausi) blockers.push('no_prior_year_end');
    if (!priorBalanceSheetFoots) blockers.push('prior_balance_sheet_imbalance');
    // G-11: recorded accounting-vs-tax adjustments for THIS tax year, applied
    // deterministically (closed vocabulary, per-item surfaced). G-10: the
    // cutover-recorded prior-year nettovarallisuus fills the switcher-year gap
    // ONLY when the pack anchors to this tilikausi and no derived figure exists.
    const taxAdjustments = evaluateTaxAdjustments({
      items: row.profile?.tax_adjustments,
      taxYear: normalizedTaxYear
    });
    const cutoverPack = row.profile?.cutover && typeof row.profile.cutover === 'object' ? row.profile.cutover : null;
    const netBusinessAssetsOverride = cutoverNetWorthForTaxYear({
      cutover: cutoverPack,
      tilikausi: { starts_on: tilikausi.starts_on, ends_on: tilikausi.ends_on }
    });
    const annualReturn = buildAnnualReturnFromReadModel({
      taxYear: normalizedTaxYear,
      profitAndLoss: current?.profit_and_loss || { rows: [] },
      // An imbalanced prior BS yields NULL (split stays deferred, surfaced via the
      // prior_balance_sheet_imbalance blocker) — never a zero-BS the aggregation
      // can't distinguish from "truly zero net assets".
      priorYearEndBalanceSheet: priorBalanceSheetFoots ? (prior?.balance_sheet || null) : null,
      additionalDeductions,
      capitalReturnRate,
      taxAdjustments,
      netBusinessAssetsOverride
    });
    // F-G10-3: the EVL maximum computed on the recorded bases, compared to the
    // booked poistot the return just aggregated — read-time, no new DB read.
    const evlDepreciation = evaluateEvlDepreciation({
      cutover: cutoverPack,
      tilikausi: { starts_on: tilikausi.starts_on, ends_on: tilikausi.ends_on },
      taxYear: normalizedTaxYear,
      bookedDepreciationEur: annualReturn?.deductibleExpenses?.depreciation ?? null,
      taxAdjustments: row.profile?.tax_adjustments
    });
    return annualReturnReadyEnvelope({
      taxYear: normalizedTaxYear,
      tilikausi: { starts_on: tilikausi.starts_on, ends_on: tilikausi.ends_on },
      basis: resolvedBasis,
      annualReturn,
      readAt,
      blockers,
      cutover: cutoverPack,
      evlDepreciation
    });
  });
};


// G-10 (FI-15) — the cutover-pack reconciliation read: profile.cutover checked
// against the POSTED avaava tase at read time (closed note codes, 1-cent
// epsilon; mismatches surfaced, never auto-corrected, never blocking). Gated
// on the EXISTING opening-balances capability flags — the pack is a property
// of that capability, not a new rollout (D-P2-5). Deterministic; no model
// call, no write. Design: docs/design-donna-finland-fi15-g10-g14-p2-batch.md.
export const getFinlandCutoverPackFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the Finland cutover pack.');
    error.statusCode = 400;
    throw error;
  }
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const openingActs = clientFlagActs({ flagKey: FINLAND_OPENING_BALANCES_FLAG_KEY, snapshot, envFallback: () => false });
    const tilikausiActs = clientFlagActs({ flagKey: FINLAND_TILIKAUSI_FLAG_KEY, snapshot, envFallback: () => false });
    if (!openingActs || !tilikausiActs) {
      const error = new Error('Finland cutover pack requires FINLAND_OPENING_BALANCES (and FINLAND_TILIKAUSI) for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_CUTOVER_PACK_DISABLED';
      throw error;
    }

    const profileResult = await client.query(
      'select profile from clients where firm_id = $1 and id = $2',
      [firmId, clientId]
    );
    const profile = profileResult.rows[0]?.profile || {};
    const cutover = profile.cutover && typeof profile.cutover === 'object' ? profile.cutover : null;

    // The posted opening journal, aggregated to SIGNED net (debit − credit)
    // per account code — the persisted verdict the recorded pack reconciles
    // against (render-the-persisted-verdict; nothing is re-derived).
    const balancesResult = await client.query(
      `select la.code, coalesce(sum(ll.debit - ll.credit), 0) as net
         from ledger_lines ll
         join ledger_journals lj on lj.id = ll.journal_id
         join ledger_accounts la on la.id = ll.account_id
        where ll.firm_id = $1
          and ll.client_id = $2
          and lj.source_type = 'opening_balance'
          and lj.status in ('posted', 'closed')
        group by la.code`,
      [firmId, clientId]
    );
    const openingBalances = {};
    for (const row of balancesResult.rows) {
      openingBalances[String(row.code)] = Number(row.net) || 0;
    }
    const openingJournalPosted = balancesResult.rows.length > 0;

    const evaluation = evaluateCutoverPack({
      cutover,
      openingBalances: openingJournalPosted ? openingBalances : null
    });

    return {
      cutover,
      evaluation,
      opening_journal: {
        posted: openingJournalPosted,
        balances: openingBalances,
        control_codes: CUTOVER_CONTROL_CODES
      },
      provenance: { source: 'ledger_read_model', readAt: readAt || null, deterministic: true }
    };
  });
};


// FI-3 — the ALV return for a verokausi, computed from posted ledger lines.
// Deterministic read: flag-gated on the config plane, no model call, no ledger
// write, no persisted alv_returns row (that lane lands with D3 — a row minted
// today could only rest at "computed and parked", the two-terminal-states
// violation). Design: docs/design-donna-finland-fi3-alv-return.md.
export const getFinlandAlvReturnFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  period,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a Finland ALV return.');
    error.statusCode = 400;
    throw error;
  }
  const resolvedPeriod = resolveAlvPeriod(period);

  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const alvReturnActs = clientFlagActs({ flagKey: FINLAND_ALV_RETURN_FLAG_KEY, snapshot, envFallback: () => false });
    if (!alvReturnActs) {
      const error = new Error('Finland ALV return requires FINLAND_ALV_RETURN for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_ALV_RETURN_DISABLED';
      throw error;
    }

    // F-FI3-3: the client's assigned ALV filing cadence (verokausi) is DATA on
    // clients.profile; surface it on the envelope so the read surface leads its
    // period picker with the right cadence instead of assuming monthly. Absent ⇒
    // the D3 monthly default. Additive — the computed period is unchanged.
    const profileResult = await client.query(
      'select profile from clients where firm_id = $1 and id = $2',
      [firmId, clientId]
    );
    // The basis rides along so a disagreement with alv_registration.tax_period,
    // or a monthly default with nothing recorded, is visible — not resolved here.
    const verokausiBasis = verokausiBasisForProfile(profileResult.rows[0]?.profile || {});
    const verokausi = verokausiBasis.cadence;

    const linesResult = await client.query(
      `select ll.*, la.account_type
         from ledger_lines ll
         join ledger_journals lj on lj.id = ll.journal_id
         join ledger_accounts la on la.id = ll.account_id
        where ll.firm_id = $1
          and ll.client_id = $2
          and lj.journal_date >= $3
          and lj.journal_date <= $4
          and lj.status in ('posted', 'closed')
        order by lj.journal_date, lj.created_at, ll.line_no`,
      [firmId, clientId, resolvedPeriod.starts_on, resolvedPeriod.ends_on]
    );

    // rowToLedgerLinePayload lifts the joined la.account_type onto the line.
    const computed = buildAlvReturnFromLedgerLines({
      period: resolvedPeriod,
      lines: linesResult.rows.map(rowToLedgerLinePayload)
    });
    // FI-09: the boxes read the posted ledger only. Uploaded sales documents
    // and uploaded supplier documents the ledger does not recognise in this
    // period are named, totalled and block the return, each side under its own
    // blocker — never a silently understated output or input tax.
    const gap = await readRecognitionGapWithClient({ client, firmId, clientId, period: resolvedPeriod });
    let review = computed.review;
    for (const [key, side] of [['unrecognizedSales', gap.sales], ['unrecognizedPurchases', gap.purchase]]) {
      if (!side.items.length) continue;
      review = { ...review, status: 'needs_review', blockers: [...review.blockers, side.blocker],
        [key]: { statement: recognitionStatement(side), ...side } };
    }
    // A posted line in the period whose correction case is open carries a
    // treatment Donna has already marked as in doubt. The figures stay what
    // the ledger says; the return is not ready, with the lines named, until
    // each case is corrected or closed (postedCorrectionGap.js).
    const corrections = await readOpenCodingCorrectionsWithClient({ client, firmId, clientId, period: resolvedPeriod });
    if (corrections.count) {
      review = { ...review, status: 'needs_review', blockers: [...review.blockers, corrections.blocker],
        openCodingCorrections: corrections };
    }
    return {
      ...computed,
      review,
      verokausi,
      verokausi_basis: verokausiBasis,
      provenance: {
        source: 'ledger_read_model',
        readAt: readAt || null,
        deterministic: true,
        boxMap: alvReturnBoxMapProvenance()
      }
    };
  });
};


// FI production-readiness P0 — the ALV registration-threshold watch read
// (docs/design-donna-finland-production-readiness.md): calendar-year turnover
// vs the €20,000 registration threshold for a NON-registered client. Gated by
// FINLAND_ALV_THRESHOLD_WATCH (config plane, typed 403 when dark — the surface
// hides). A client where FINLAND_ALV_CODING acts returns applicable:false
// (their obligations are the return engine's job), never an error. Read-only,
// deterministic, no model call.
export const getFinlandAlvThresholdWatchFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  year = null,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the ALV threshold watch.');
    error.statusCode = 400;
    throw error;
  }
  const watchYear = Number(year) || new Date().getUTCFullYear();

  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const watchActs = clientFlagActs({ flagKey: FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY, snapshot, envFallback: () => false });
    if (!watchActs) {
      const error = new Error('Finland ALV threshold watch requires FINLAND_ALV_THRESHOLD_WATCH for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_ALV_THRESHOLD_WATCH_DISABLED';
      throw error;
    }
    const alvCodingActs = clientFlagActs({ flagKey: FINLAND_ALV_CODING_FLAG_KEY, snapshot, envFallback: () => false });
    if (alvCodingActs) {
      return {
        watch: { applicable: false, reason: 'alv_registered' },
        provenance: { source: 'ledger_read_model', readAt: readAt || null, deterministic: true }
      };
    }

    const watch = await __finlandAlvThresholdTurnoverWatch({ client, firmId, clientId, year: watchYear });
    // D-G2E-6 — render the persisted verdict: when the exceeded-escalation ask
    // exists (the deterministic per-year id the drain mints), the envelope
    // carries it so the panel shows "asked the owner / owner answered" instead
    // of a bare warning.
    const askResult = await client.query(
      `select id, status, first_sent_at from client_evidence_requests where id = $1`,
      [finlandAlvThresholdAskId({ firmId, clientId, year: watchYear })]
    );
    const escalation = askResult.rows[0]
      ? { ask_id: askResult.rows[0].id, status: askResult.rows[0].status, first_sent_at: askResult.rows[0].first_sent_at }
      : null;
    return {
      watch,
      escalation,
      provenance: { source: 'ledger_read_model', readAt: readAt || null, deterministic: true }
    };
  });
};


// Calendar-year turnover (credit − debit over revenue-type lines, posted
// journals only) for the watch year and the prior year in one pass, mapped by
// the pure watch. Shared by the GET report and the escalation drain so both
// verdicts derive identically by construction.
const __finlandAlvThresholdTurnoverWatch = async ({ client, firmId, clientId, year }) => {
  const turnoverResult = await client.query(
    `select extract(year from lj.journal_date)::int as year,
            coalesce(sum(ll.credit - ll.debit), 0) as turnover
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1
        and ll.client_id = $2
        and la.account_type = 'revenue'
        and lj.status in ('posted', 'closed')
        and lj.journal_date >= $3
        and lj.journal_date <= $4
      group by 1`,
    [firmId, clientId, `${year - 1}-01-01`, `${year}-12-31`]
  );
  const turnoverByYear = new Map(turnoverResult.rows.map((row) => [Number(row.year), Number(row.turnover) || 0]));
  return buildAlvRegistrationWatch({
    year,
    currentYearTurnover: turnoverByYear.get(year) || 0,
    priorYearTurnover: turnoverByYear.get(year - 1) || 0
  });
};


// One ask per (client, calendar year) — the deterministic id both the drain's
// mint and the GET's render key on (D-G2E-3).
const finlandAlvThresholdAskId = ({ firmId, clientId, year }) =>
  `alv-threshold-${firmId}-${clientId}-${year}`;


// G-2 follow-up (FI-15) — the exceeded-escalation drain
// (docs/design-donna-finland-g2-threshold-escalation.md). Runs on the daily
// `finland_watches` cron task: sweeps config-plane candidates, re-gates each
// client authoritatively, and when the deterministic watch says `exceeded`
// mints ONE owner ask per calendar year (on conflict do nothing — an open ask
// is never re-nagged, a resolved ask stays answered for its year) with the
// audit event in the same transaction, then delivers over the existing
// WhatsApp evidence-ask substrate. Flag-off ⇒ zero candidates ⇒ no-op.
export const drainFinlandAlvThresholdEscalations = async ({
  client,
  firmId = null,
  year = null,
  deliverAsksImpl = null
} = {}) => {
  const watchYear = Number(year) || new Date().getUTCFullYear();
  const summary = { scanned: 0, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 0, errors: 0 };

  // Candidates: acting per-client rows UNION every client of a firm whose
  // firm-default row acts. The per-client snapshot below is authoritative
  // (force-disable, cohorts); this enumeration only bounds the sweep.
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
    [FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY, firmId]
  );

  for (const candidate of candidateResult.rows) {
    summary.scanned += 1;
    try {
      // A capability flag is authority to run this watch, never country identity.
      if (normalizeProfileJurisdiction(resolveProfileWriteJurisdiction({ patch: {}, stored: candidate })) !== 'fi') {
        summary.skipped += 1;
        continue;
      }
      const snapshot = await readClientConfigSnapshot(client, { firmId: candidate.firm_id, clientId: candidate.client_id });
      const watchActs = clientFlagActs({ flagKey: FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY, snapshot, envFallback: () => false });
      const alvCodingActs = clientFlagActs({ flagKey: FINLAND_ALV_CODING_FLAG_KEY, snapshot, envFallback: () => false });
      if (!watchActs || alvCodingActs) {
        summary.skipped += 1;
        continue;
      }
      const watch = await __finlandAlvThresholdTurnoverWatch({
        client, firmId: candidate.firm_id, clientId: candidate.client_id, year: watchYear
      });
      if (watch.status !== 'exceeded') continue;
      summary.exceeded += 1;

      const question = buildAlvThresholdEscalationQuestion({ watch });
      const askId = finlandAlvThresholdAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, year: watchYear });
      await client.query('begin');
      let inserted = false;
      try {
        // Identity can change after discovery or turnover aggregation. Hold the
        // owning client row until commit so an old country cannot mint a new ask.
        const current = await client.query(
          'select jurisdiction, profile from clients where firm_id = $1 and id = $2 for share',
          [candidate.firm_id, candidate.client_id]
        );
        if (normalizeProfileJurisdiction(resolveProfileWriteJurisdiction({ patch: {}, stored: current.rows[0] })) !== 'fi') {
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
            askId, candidate.firm_id, candidate.client_id, ALV_THRESHOLD_EVIDENCE_TYPE, question,
            JSON.stringify({
              kind: ALV_THRESHOLD_EVIDENCE_TYPE,
              year: watchYear,
              driving_turnover_eur: watch.drivingTurnover,
              threshold_eur: watch.thresholdEur,
              current_year_turnover_eur: watch.currentYearTurnover,
              prior_year_turnover_eur: watch.priorYearTurnover
            })
          ]
        );
        inserted = insertResult.rows.length > 0;
        if (inserted) {
          // Audit-as-precondition: same transaction as the mint. The authority
          // basis is the firm's standing config-plane enable (D-G2E-5).
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, $2, 'system', 'system', 'alv_threshold.escalated', 'client_evidence_request', $3, $4::jsonb)`,
            [candidate.firm_id, candidate.client_id, askId, JSON.stringify({
              year: watchYear,
              driving_turnover_eur: watch.drivingTurnover,
              threshold_eur: watch.thresholdEur,
              authority_basis: `client_capability_config:${FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY}`
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
      const deliver = deliverAsksImpl
        || ((args) => deliverStatutoryAsks({ client, surface: 'finland_alv_threshold', ...args }));
      const delivery = await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
      // Counted as delivered only when a deliverer delivered it.
      if (deliveredAsk(delivery, askId)) summary.delivered += 1;
      else if (delivery?.refused) summary.held += 1;
    } catch (error) {
      summary.errors += 1;
    }
  }
  return summary;
};


// G-7P (D-G7P-3) — deliver posting-time scope-drift asks. The posting seam
// mints the ask in-txn (portal-visible immediately, the on-owner terminal)
// but cannot do network I/O inside the posting transaction, so WhatsApp
// delivery rides the daily finland_watches drain: every open
// scope_drift_review ask with no delivery-ledger row yet gets ONE fail-soft
// send attempt per day. An unbound / flag-off client simply retries tomorrow
// (the ask stays portal-visible either way); a recorded send or fallback row
// counts as attempted and is never re-sent.
export const deliverPendingFinlandScopeDriftAsks = async ({ client, deliverAsksImpl = null } = {}) => {
  const summary = { pending: 0, attempted: 0, held: 0, skipped: 0, errors: 0 };
  const pendingResult = await client.query(
    `select r.id, r.firm_id, r.client_id
       from client_evidence_requests r
      where r.evidence_type = $1
        and r.status = 'open'
        and r.audience = 'client'
        and not exists (select 1 from message_delivery_ledger l where l.ask_id = r.id)
      order by r.created_at
      limit 200`,
    [SCOPE_DRIFT_EVIDENCE_TYPE]
  );
  const deliver = deliverAsksImpl
    || ((args) => deliverStatutoryAsks({ client, surface: 'finland_scope_drift', ...args }));
  for (const row of pendingResult.rows) {
    summary.pending += 1;
    try {
      const result = await deliver({ firmId: row.firm_id, clientId: row.client_id, evidenceRequestIds: [row.id] });
      // Held by the send gate: nothing went out, no ledger row, so the ask
      // stays pending and the next daily run asks the gate again.
      if (result?.refused) {
        summary.held += 1;
        continue;
      }
      if (result?.whatsapp?.skipped) {
        summary.skipped += 1;
        continue;
      }
      // The deliverer stamped the ask if, and only if, it delivered it; a
      // failed send left its ledger row and no stamp.
      summary.attempted += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
};


// G-7 (FI-15) — scope-drift detection (docs/design-donna-finland-production-
// readiness.md). Deterministic read: hard signals from the posted ledger
// (personnel/inventory/cash/EU accounts, EU-import/reverse-charge tax codes)
// + processor patterns over bank-feed descriptions, mapped by the PURE
// evaluator onto the closed verdict enum. Flag-gated FINLAND_SCOPE_DRIFT_WATCH
// (config plane, dark by default). Never mutates anything.
export const getFinlandScopeDriftFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the scope-drift watch.');
    error.statusCode = 400;
    throw error;
  }
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const watchActs = clientFlagActs({ flagKey: FINLAND_SCOPE_DRIFT_WATCH_FLAG_KEY, snapshot, envFallback: () => false });
    if (!watchActs) {
      const error = new Error('Finland scope-drift watch requires FINLAND_SCOPE_DRIFT_WATCH for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_SCOPE_DRIFT_WATCH_DISABLED';
      throw error;
    }

    // One pass over the posted ledger for every account/tax-code signal.
    const signalResult = await client.query(
      `select
         count(*) filter (where la.code = any($3)) as personnel_moves,
         count(*) filter (where la.account_type = 'inventory' or la.code = any($4)) as inventory_moves,
         count(*) filter (where la.code = any($5)) as cash_moves,
         count(*) filter (where la.code = any($6)) as eu_revenue_moves,
         count(*) filter (where ll.tax_type = any($7)) as eu_tax_lines,
         count(*) filter (where ll.tax_type = any($8)) as reverse_charge_lines
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1
        and ll.client_id = $2
        and lj.status in ('posted', 'closed')`,
      [
        firmId,
        clientId,
        [...PERSONNEL_ACCOUNT_CODES],
        [...INVENTORY_ACCOUNT_CODES],
        [...CASH_ACCOUNT_CODES],
        [...EU_REVENUE_ACCOUNT_CODES],
        [...EU_OR_IMPORT_TAX_CODES],
        [...REVERSE_CHARGE_TAX_CODES]
      ]
    );
    const row = signalResult.rows[0] || {};

    // Candidate bank-feed lines only (the SQL alternation), named in JS by the
    // same closed pattern list — deterministic both sides.
    const processorResult = await client.query(
      `select distinct description
         from transactions
        where firm_id = $1
          and client_id = $2
          and description ~* $3
        limit 500`,
      [firmId, clientId, PROCESSOR_SQL_PATTERN]
    );
    const processorsDetected = matchProcessors(processorResult.rows.map((r) => r.description));

    // FI-13 13.3A — the drift fork keys on the persisted legal form: an Oy's
    // personnel movements are external payroll (review-only), not a toiminimi's
    // first-employee drift, and spouse_participation drops from an Oy's stated
    // exclusions. Unset/unreadable form ⇒ 'toiminimi', so an existing book reads
    // byte-identically to before.
    const entityRow = await client.query(
      'select entity_type, profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    const entityAxis =
      finlandEntityType({ entity_type: entityRow.rows[0]?.entity_type, profile: entityRow.rows[0]?.profile }) || 'toiminimi';

    const drift = evaluateScopeDrift({
      entityAxis,
      signals: {
        personnelAccountMovements: row.personnel_moves,
        inventoryAccountMovements: row.inventory_moves,
        cashAccountMovements: row.cash_moves,
        euRevenueAccountMovements: row.eu_revenue_moves,
        euOrImportTaxLines: row.eu_tax_lines,
        reverseChargeTaxLines: row.reverse_charge_lines,
        processorsDetected
      }
    });

    return {
      drift,
      provenance: { source: 'ledger_read_model', readAt: readAt || null, deterministic: true }
    };
  });
};


// FI-13 slice 13.0A-2b — the Oy onboarding convergence read (D-FI13-11/12/13/14
// wired together): ONE deterministic surface answering "where does this client
// stand against the pilot envelope, and what is actually enabled?".
//
//   • capabilities — the D-FI13-12 contract off the client's config snapshot
//     (dark by default: with no stage rows every lane renders not_enabled).
//   • envelope — evaluateAcceptanceEnvelope over attributes DERIVED from the
//     persisted models (render-the-persisted-verdict: a stored cap table /
//     authority structure outranks a stated claim) merged over any DECLARED
//     attributes the caller passes (the intake's stated answers — boundaries
//     Donna cannot derive, e.g. foreign PE, shareholder loans).
//   • authority_basis_gaps — roles whose recorded basis is insufficient
//     (the checkbox-for-tax-filing case), each a visible onboarding gap.
//
// Fail-closed staging: a model that predates its migration (078/079 soft-fail
// → null) or an EMPTY cap table / role set contributes NOTHING — "not yet
// recorded" reads as unknown, so the envelope fires 'unconfirmed' resting on
// the owner; it is never laundered into a pass OR a disqualification. This
// read is deliberately NOT flag-gated: qualification precedes enabling (the
// envelope is the intake tool), the read is deterministic with no model call,
// and the capability contract's whole point is rendering not_enabled honestly.
export const getFinlandOyOnboardingStateFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  asOf = null,
  attributes = {},
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the Oy onboarding state.');
    error.statusCode = 400;
    throw error;
  }
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const clientResult = await client.query(
      `select entity_type, profile from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const clientRow = clientResult.rows[0] || {};
    const entityType = clientRow.profile?.entityType || clientRow.entity_type || null;

    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const capabilities = readFinlandOyCapabilities({ snapshot });

    const capTable = await loadCapTableAsOf({ client, firmId, clientId, asOf });
    const authorityRoles = await loadAuthorityRolesAsOf({ client, firmId, clientId, asOf });

    // Derived attributes only where a model has something RECORDED — an empty
    // cap table is "not yet recorded" (unknown → on the owner), never a
    // disqualification minted from absence-of-data.
    const derived = { ...(entityType ? { entityType } : {}) };
    if (capTable && Array.isArray(capTable.shareholders) && capTable.shareholders.length > 0) {
      Object.assign(derived, deriveOwnershipEnvelopeAttributes(capTable));
    }
    if (Array.isArray(authorityRoles)) {
      const authorityDerived = deriveAuthorityEnvelopeAttributes({ roles: authorityRoles });
      if (authorityDerived.singleDecisionMakerWithAuthority !== null) Object.assign(derived, authorityDerived);
    }

    const mergedAttributes = { ...(attributes || {}), ...derived };
    const envelope = evaluateAcceptanceEnvelope({ attributes: mergedAttributes });

    return {
      entity_type: entityType,
      envelope,
      capabilities,
      cap_table: capTable,
      authority: {
        recorded: Array.isArray(authorityRoles),
        roles: Array.isArray(authorityRoles) ? authorityRoles : [],
        basis_gaps: Array.isArray(authorityRoles) ? authorityBasisGaps({ roles: authorityRoles }) : []
      },
      attributes: mergedAttributes,
      provenance: {
        source: 'persisted_models',
        deterministic: true,
        as_of: asOf || null,
        readAt: readAt || null
      }
    };
  });
};


// FI-13 13.3A PR2 (D-FI13-7 v2) — YEL applicability for an Oy, DERIVED from the
// ownership + authority models (never a pct field). A toiminimi keeps the
// self-employed YEL watch above; an Oy owner's pension regime depends on
// leading position + ownership, so this reads the cap table + authority rows and
// renders evaluateOyYelApplicability's proposal (confirmedAgainstPrimary:false;
// työtulo never derived). Entity-gated to fi-oy and flag-gated
// FINLAND_OY_YEL_APPLICABILITY (config plane, dark by default). Green-now: no
// fi-oy client exists, so it only ever runs behind an explicit canary.
export const getFinlandOyYelApplicabilityFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  asOf = null,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the Oy YEL applicability read.');
    error.statusCode = 400;
    throw error;
  }
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const clientResult = await client.query(
      `select entity_type, profile from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const clientRow = clientResult.rows[0] || {};
    const entityAxis = finlandEntityType({ entity_type: clientRow.entity_type, profile: clientRow.profile });
    if (entityAxis !== 'oy') {
      // A toiminimi's pension is the self-employed YEL watch, not this derived
      // Oy applicability — refuse rather than emit a wrong-shape verdict.
      const error = new Error('Oy YEL applicability applies only to an fi-oy client.');
      error.statusCode = 409;
      error.code = 'FINLAND_OY_YEL_ENTITY_NOT_OY';
      throw error;
    }

    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const watchActs = clientFlagActs({ flagKey: FINLAND_OY_YEL_APPLICABILITY_FLAG_KEY, snapshot, envFallback: () => false });
    if (!watchActs) {
      const error = new Error('Finland Oy YEL applicability requires FINLAND_OY_YEL_APPLICABILITY for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_OY_YEL_APPLICABILITY_DISABLED';
      throw error;
    }

    const capTable = await loadCapTableAsOf({ client, firmId, clientId, asOf });
    const authorityRoles = await loadAuthorityRolesAsOf({ client, firmId, clientId, asOf });

    return {
      applicability: evaluateOyYelApplicability({ capTable, authorityRoles: Array.isArray(authorityRoles) ? authorityRoles : [] }),
      provenance: { source: 'persisted_models', deterministic: true, as_of: asOf || null, readAt: readAt || null }
    };
  });
};


// FI-13 13.3A PR2 (D-FI13-19 + D-FI13-18) — the Oy balance-sheet watches read.
// Reads balances by chart code from the posted ledger + the fiscal-year
// registry, builds the deterministic signals, and renders
// evaluateOyBalanceSheetWatches. This is the DETECTION layer; the monthly-close
// checklist (PR3) consumes these verdicts and drives terminals. Entity-gated to
// fi-oy, flag-gated FINLAND_OY_BALANCE_SHEET_WATCHES (config plane, dark).
export const getFinlandOyBalanceSheetWatchesFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the Oy balance-sheet watches.');
    error.statusCode = 400;
    throw error;
  }
  const asOf = String(readAt || new Date().toISOString()).slice(0, 10);
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const clientResult = await client.query(
      `select entity_type, profile from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const clientRow = clientResult.rows[0] || {};
    if (finlandEntityType({ entity_type: clientRow.entity_type, profile: clientRow.profile }) !== 'oy') {
      const error = new Error('Oy balance-sheet watches apply only to an fi-oy client.');
      error.statusCode = 409;
      error.code = 'FINLAND_OY_BALANCE_SHEET_ENTITY_NOT_OY';
      throw error;
    }
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const watchActs = clientFlagActs({ flagKey: FINLAND_OY_BALANCE_SHEET_WATCHES_FLAG_KEY, snapshot, envFallback: () => false });
    if (!watchActs) {
      const error = new Error('Finland Oy balance-sheet watches require FINLAND_OY_BALANCE_SHEET_WATCHES for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_OY_BALANCE_SHEET_WATCHES_DISABLED';
      throw error;
    }

    const signals = await loadOyBalanceSheetWatchSignals({ client, firmId, clientId, asOf });
    return {
      watches: evaluateOyBalanceSheetWatches({ signals, asOf }),
      provenance: { source: 'posted_ledger+fiscal_registry', deterministic: true, readAt: readAt || null, as_of: asOf }
    };
  });
};


// Shared reader for the D-FI13-19/18 balance-sheet watch SIGNALS: balances by
// chart code from the posted ledger + the osakaslaina calendar clock + the
// registry-vs-books extent. Extracted so PR2's watches read and PR3's monthly
// close read the SAME source of truth (one place for the ledger SQL), never two
// diverging copies. Pure I/O — the mapping onto the closed watch catalog stays in
// evaluateOyBalanceSheetWatches.
const loadOyBalanceSheetWatchSignals = async ({ client, firmId, clientId, asOf }) => {
  const codes = OY_WATCH_ACCOUNT_CODES;
  const allCodes = [...new Set([...codes.equity, ...codes.capital_loans, ...codes.shareholder_loan_receivable, ...codes.vat_liability])];

  // SIGNED net (debit − credit) per code, as of asOf, over posted journals.
  const balances = await client.query(
    `select la.code,
            coalesce(sum(ll.debit - ll.credit), 0) as net,
            min(lj.journal_date) as min_date
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1 and ll.client_id = $2 and lj.status in ('posted', 'closed')
        and lj.journal_date <= $3::date
        and la.code = any($4)
      group by la.code`,
    [firmId, clientId, asOf, allCodes]
  );
  const netByCode = new Map(balances.rows.map((r) => [String(r.code), Number(r.net) || 0]));
  const minDateByCode = new Map(balances.rows.map((r) => [String(r.code), r.min_date ? String(r.min_date).slice(0, 10) : null]));
  const sumNet = (list) => list.reduce((n, code) => n + (netByCode.get(code) || 0), 0);
  const minDate = (list) => list.map((c) => minDateByCode.get(c)).filter(Boolean).sort()[0] || null;

  // Equity/liability accounts are credit-normal: value = −(debit − credit).
  const equityTotal = -sumNet(codes.equity);
  const capitalLoansTotal = -sumNet(codes.capital_loans);
  const distributableEquity = -sumNet(codes.distributable_equity);
  // The shareholder-loan receivable is debit-normal: a debit balance (company
  // lent to a shareholder) is a positive signed net.
  const shareholderDebitCompany = sumNet(codes.shareholder_loan_receivable);
  const vatLiability = -sumNet(codes.vat_liability);

  // The recipient calendar-year clock (31 Dec) for the osakaslaina dual-clock:
  // the shareholder-loan balance as of the most recent completed 31 Dec.
  const year = Number(asOf.slice(0, 4));
  const priorDec = asOf >= `${year}-12-31` ? `${year}-12-31` : `${year - 1}-12-31`;
  const calendarBalanceRow = await client.query(
    `select coalesce(sum(ll.debit - ll.credit), 0) as net
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1 and ll.client_id = $2 and lj.status in ('posted', 'closed')
        and lj.journal_date <= $3::date
        and la.code = any($4)`,
    [firmId, clientId, priorDec, [...codes.shareholder_loan_receivable]]
  );
  const shareholderDebitCalendar = Number(calendarBalanceRow.rows[0]?.net) || 0;

  // The registry period (covering asOf) vs the posted-ledger extent. Only a
  // book that extends OUTSIDE the registered tilikausi is a mismatch — a
  // partial-year book contained within it is not (avoids a false fire).
  const registryRow = await client.query(
    `select starts_on, ends_on from fiscal_years
      where firm_id = $1 and client_id = $2 and starts_on <= $3::date and ends_on >= $3::date
      order by starts_on desc limit 1`,
    [firmId, clientId, asOf]
  );
  const extentRow = await client.query(
    `select min(journal_date) as min_date, max(journal_date) as max_date
       from ledger_journals where firm_id = $1 and client_id = $2 and status in ('posted', 'closed')`,
    [firmId, clientId]
  );
  const registryPeriod = registryRow.rows[0]
    ? { start: String(registryRow.rows[0].starts_on).slice(0, 10), end: String(registryRow.rows[0].ends_on).slice(0, 10) }
    : null;
  let booksPeriod = null;
  const extentMin = extentRow.rows[0]?.min_date ? String(extentRow.rows[0].min_date).slice(0, 10) : null;
  const extentMax = extentRow.rows[0]?.max_date ? String(extentRow.rows[0].max_date).slice(0, 10) : null;
  if (registryPeriod && extentMin && extentMax && (extentMin < registryPeriod.start || extentMax > registryPeriod.end)) {
    booksPeriod = { start: extentMin, end: extentMax };
  }

  const statutoryLiabilities = [];
  if (vatLiability > 0) {
    statutoryLiabilities.push({ kind: 'vat', balance: vatLiability, oldest_unpaid_date: minDate(codes.vat_liability) });
  }

  return {
    equityTotal,
    capitalLoansTotal,
    distributableEquity,
    statutoryLiabilities,
    relatedPartyReceivable: shareholderDebitCompany > 0
      ? { balance: shareholderDebitCompany, oldest_open_date: minDate(codes.shareholder_loan_receivable) }
      : null,
    shareholderDebit: {
      companyPeriod: { balance: shareholderDebitCompany, period_end: asOf },
      calendarYtd: { balance: shareholderDebitCalendar, year_end: priorDec }
    },
    registryPeriod,
    booksPeriod
  };
};


// FI-13 13.3A PR3 (D-FI13-15) — the Oy monthly-close checklist + terminal state.
// This is the CONSUMER of the 13.3A detection layer: it re-reads the balance-sheet
// watch signals (the SAME loadOyBalanceSheetWatchSignals source as PR2, so the
// close never diverges from the watches surface), loads the open StatutoryBlocker
// set (all surfaces — a named-human obligation ELSEWHERE on the client is visible
// to the close), and renders evaluateOyMonthlyClose. A reconciled bank feed is not
// an Oy close: every checklist item comes to rest either 'settled' or 'on_human'.
//
// When persist=true, each item blocked by a CONCRETE detection signal (a fired
// watch / an escalating owner transaction / an already-open blocker) is driven to
// its durable terminal by minting an idempotent StatutoryBlocker on the named
// human (deterministic id ⇒ a re-run collapses, never spams). Items merely
// 'pending_upstream' (a close stage whose auto-settle source is not built yet —
// e.g. payroll import lands in 13.3B) are surfaced in the verdict but NOT minted,
// so the durable blocker set stays the real judgment items, not coverage gaps. The
// mint is best-effort (soft-fails pre-migration-076, never poisons the read).
// Entity-gated to fi-oy (409), flag-gated FINLAND_OY_MONTHLY_CLOSE (config plane,
// dark). Green-now: no fi-oy client exists, so it only runs behind an explicit canary.
export const getFinlandOyMonthlyCloseFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  persist = true,
  actorType = 'system',
  actorId = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the Oy monthly close.');
    error.statusCode = 400;
    throw error;
  }
  const asOf = String(readAt || new Date().toISOString()).slice(0, 10);
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const clientResult = await client.query(
      `select entity_type, profile from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const clientRow = clientResult.rows[0] || {};
    if (finlandEntityType({ entity_type: clientRow.entity_type, profile: clientRow.profile }) !== 'oy') {
      const error = new Error('Oy monthly close applies only to an fi-oy client.');
      error.statusCode = 409;
      error.code = 'FINLAND_OY_MONTHLY_CLOSE_ENTITY_NOT_OY';
      throw error;
    }
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const closeActs = clientFlagActs({ flagKey: FINLAND_OY_MONTHLY_CLOSE_FLAG_KEY, snapshot, envFallback: () => false });
    if (!closeActs) {
      const error = new Error('Finland Oy monthly close requires FINLAND_OY_MONTHLY_CLOSE for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_OY_MONTHLY_CLOSE_DISABLED';
      throw error;
    }

    // Detection inputs: the balance-sheet watches (same signals as PR2) + the open
    // blocker set across ALL surfaces (the catch-all sees obligations elsewhere).
    const signals = await loadOyBalanceSheetWatchSignals({ client, firmId, clientId, asOf });
    const watches = evaluateOyBalanceSheetWatches({ signals, asOf });
    const openBlockers = await loadOpenStatutoryBlockers({ client, firmId, clientId });

    const close = evaluateOyMonthlyClose({ watches, openBlockers, asOf });

    // Drive concrete judgment items to their durable terminal. A 'pending_upstream'
    // item (its auto-settle upstream not built yet) is surfaced but not minted.
    const minted = [];
    if (persist) {
      for (const item of close.items) {
        if (item.terminal !== 'on_human' || !item.blocker_directive) continue;
        if (item.reason === 'pending_upstream') continue;
        try {
          const result = await mintStatutoryBlocker({
            client,
            firmId,
            clientId,
            surface: item.blocker_directive.surface,
            reasonCode: item.blocker_directive.reason_code,
            severity: item.blocker_directive.severity,
            assignedTo: item.blocker_directive.assigned_to,
            entityType: 'oy',
            detail: { close_item: item.id, reasons: item.reasons, evidence: item.evidence, as_of: asOf },
            actorType,
            actorId,
            reason: `oy_monthly_close:${item.reason}`
          });
          if (result) minted.push({ item: item.id, id: result.id, inserted: result.inserted, status: result.status });
        } catch {
          // Best-effort: a mint failure never poisons the close read (mirrors the
          // cutover/form-5 mint posture). The verdict still names the human.
        }
      }
    }

    return {
      close,
      minted,
      open_blockers: openBlockers.map((b) => ({ id: b.id, surface: b.surface, reason_code: b.reason_code, severity: b.severity, assigned_to: b.assigned_to, status: b.status })),
      provenance: { source: 'posted_ledger+fiscal_registry+statutory_blockers', surface: OY_CLOSE_BLOCKER_SURFACE, deterministic: true, readAt: readAt || null, as_of: asOf, persisted: Boolean(persist) }
    };
  });
};


// G-4 (FI-15) — the YEL watch (docs/design-donna-finland-production-
// readiness.md): track (profile.yel, written via updateClientProfileInDb's
// validated patch path) / remind (stale confirmation) / flag (insurer debits
// visible in the feed). Deterministic read; the pure evaluator NEVER
// determines the income. Flag-gated FINLAND_YEL_WATCH (config plane, dark by
// default).
export const getFinlandYelStatusFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the YEL watch.');
    error.statusCode = 400;
    throw error;
  }
  const at = readAt || new Date().toISOString();
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const watchActs = clientFlagActs({ flagKey: FINLAND_YEL_WATCH_FLAG_KEY, snapshot, envFallback: () => false });
    if (!watchActs) {
      const error = new Error('Finland YEL watch requires FINLAND_YEL_WATCH for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_YEL_WATCH_DISABLED';
      throw error;
    }
    const profileResult = await client.query(
      'select profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    const yelProfile = profileResult.rows[0]?.profile?.yel || null;

    // Insurer-matching DEBITS only (money_out > 0): premium payments, not
    // refunds or name coincidences on the credit side.
    const premiumResult = await client.query(
      `select description, transaction_date
         from transactions
        where firm_id = $1
          and client_id = $2
          and money_out > 0
          and description ~* $3
        order by transaction_date desc nulls last
        limit 200`,
      [firmId, clientId, YEL_INSURER_SQL_PATTERN]
    );
    const insurersDetected = matchYelInsurers(premiumResult.rows.map((r) => r.description));
    const lastPremiumOn = premiumResult.rows.find((r) => r.transaction_date)?.transaction_date || null;

    return {
      yel: evaluateYelStatus({
        profile: yelProfile,
        premiumInsurersDetected: insurersDetected,
        lastPremiumOn,
        onDate: at
      }),
      provenance: { source: 'client_profile+bank_feed', readAt: at, deterministic: true }
    };
  });
};


// G-5 (FI-15) — the ennakkovero watch (docs/design-donna-finland-production-
// readiness.md): forecast (calendar-year P&L from the posted ledger,
// annualized by the pure module — the ennakkovero tax year for a private
// trader is the calendar year, independent of tilikausi) / record
// (profile.ennakkovero, written via updateClientProfileInDb's validated patch
// path) / warn (divergence vs the decision's income basis, pointing at
// OmaVero). Deterministic read; the pure evaluator NEVER computes a tax
// amount. Flag-gated FINLAND_ENNAKKOVERO_WATCH (config plane, dark by
// default).
export const getFinlandEnnakkoveroStatusFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the ennakkovero watch.');
    error.statusCode = 400;
    throw error;
  }
  const at = readAt || new Date().toISOString();
  const atDate = String(at).slice(0, 10);
  const year = Number(atDate.slice(0, 4));
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const watchActs = clientFlagActs({ flagKey: FINLAND_ENNAKKOVERO_WATCH_FLAG_KEY, snapshot, envFallback: () => false });
    if (!watchActs) {
      const error = new Error('Finland ennakkovero watch requires FINLAND_ENNAKKOVERO_WATCH for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_ENNAKKOVERO_WATCH_DISABLED';
      throw error;
    }
    const profileResult = await client.query(
      'select profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    const ennakkoveroProfile = profileResult.rows[0]?.profile?.ennakkovero || null;

    // Calendar-year-to-date P&L over posted journals only — revenue as
    // credit − debit, expenses as debit − credit (same read shape as the ALV
    // threshold watch's turnover query).
    const plResult = await client.query(
      `select la.account_type as account_type,
              coalesce(sum(case when la.account_type = 'revenue'
                                then ll.credit - ll.debit
                                else ll.debit - ll.credit end), 0) as amount
         from ledger_lines ll
         join ledger_journals lj on lj.id = ll.journal_id
         join ledger_accounts la on la.id = ll.account_id
        where ll.firm_id = $1
          and ll.client_id = $2
          and la.account_type in ('revenue', 'expense')
          and lj.status in ('posted', 'closed')
          and lj.journal_date >= $3
          and lj.journal_date <= $4
        group by 1`,
      [firmId, clientId, `${year}-01-01`, atDate]
    );
    const plByType = new Map(plResult.rows.map((row) => [row.account_type, Number(row.amount) || 0]));

    // Verohallinto-matching DEBITS only (money_out > 0), current tax year —
    // informational signal (could be ALV or other taxes; the copy only ever
    // says "Verohallinnon veloituksia").
    const paymentResult = await client.query(
      `select description, transaction_date
         from transactions
        where firm_id = $1
          and client_id = $2
          and money_out > 0
          and description ~* $3
          and transaction_date >= $4
        order by transaction_date desc nulls last
        limit 200`,
      [firmId, clientId, ENNAKKOVERO_PAYMENT_SQL_PATTERN, `${year}-01-01`]
    );
    const paymentsDetected = hasEnnakkoveroPayments(paymentResult.rows.map((r) => r.description));
    const lastPaymentOn = paymentResult.rows.find((r) => r.transaction_date)?.transaction_date || null;

    return {
      ennakkovero: evaluateEnnakkoveroStatus({
        profile: ennakkoveroProfile,
        forecast: forecastBusinessProfit({
          ytdRevenueEur: plByType.get('revenue') || 0,
          ytdExpensesEur: plByType.get('expense') || 0,
          onDate: at
        }),
        paymentsDetected,
        lastPaymentOn
      }),
      provenance: { source: 'posted_ledger+bank_feed+client_profile', readAt: at, deterministic: true }
    };
  });
};


// ---------------------------------------------------------------------------------
// G-6 (FI-15) — the prepayment-register (ennakkoperintärekisteri) check ledger
// (migration 068). Checks are dated, append-only receipts of what the registry
// said, recorded through an audited writer (audit-as-precondition, operator-
// attributed); freshness evaluates at READ time (finland/prepaymentRegister.js).
// A not-registered SUPPLIER with bills in the book escalates to the OWNER
// through the existing owner-clarification lane (goods vs services is their
// knowledge; Donna never executes a withholding).
// Design: docs/design-donna-finland-production-readiness.md (gap G-6).
// ---------------------------------------------------------------------------------

const rowToPrepaymentRegisterCheckPayload = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    subject_type: row.subject_type,
    business_id: row.business_id || null,
    counterparty_name: row.counterparty_name || null,
    counterparty_key: row.counterparty_key || null,
    status: row.status,
    checked_on: row.checked_on,
    source: row.source,
    reference: row.reference || null,
    note: row.note || null,
    recorded_by: row.recorded_by || null,
    created_at: row.created_at || null
  };
};


export const __recordPrepaymentRegisterCheckWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  check = {},
  actorId = 'system'
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  if (!cleanClientId) {
    const error = new Error('Client id is required to record a prepayment-register check.');
    error.statusCode = 400;
    throw error;
  }
  const normalized = normalizePrepaymentRegisterCheck(check);
  const id = `prepayment-register-check-${firmId}-${cleanClientId}-${shortHash(`${normalized.subject_type}:${normalized.counterparty_key || 'self'}:${Date.now()}`)}`;
  const inserted = await client.query(
    `insert into prepayment_register_checks (
       id, firm_id, client_id, subject_type, business_id, counterparty_name,
       counterparty_key, status, checked_on, source, reference, note, recorded_by
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      id, firmId, cleanClientId, normalized.subject_type, normalized.business_id,
      normalized.counterparty_name, normalized.counterparty_key, normalized.status,
      normalized.checked_on, normalized.source, normalized.reference, normalized.note,
      actorId
    ]
  );
  // Audit-as-precondition: same transaction as the insert — no record, no check.
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm_member', $3, 'prepayment_register.check_recorded', 'prepayment_register_check', $4, $5::jsonb)`,
    [firmId, cleanClientId, actorId, id, JSON.stringify({
      subject_type: normalized.subject_type,
      business_id: normalized.business_id,
      counterparty_name: normalized.counterparty_name,
      status: normalized.status,
      checked_on: normalized.checked_on,
      source: normalized.source,
      reference: normalized.reference
    })]
  );
  return rowToPrepaymentRegisterCheckPayload(inserted.rows[0]);
};


// The record motion. In one transaction: persist the check + audit; if the
// check says a SUPPLIER is not registered and the book has recent bills from
// it, mint the owner ask (deterministic id — re-checks reopen the same ask,
// never mint a duplicate). Delivery over the existing WhatsApp ask substrate
// happens after commit.
export const recordPrepaymentRegisterCheckInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  check = {},
  actorId = 'system',
  onDate = null,
  deliverAsksImpl = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  const at = String(onDate || new Date().toISOString()).slice(0, 10);
  // UTC on purpose: the look-back cutoff is stepped from the bare day `at`
  // in Date.UTC space — the host zone must not move it.
  const cutoff = toUtcIsoDay(new Date(Date.parse(`${at}T00:00:00Z`) - PREPAYMENT_REGISTER_SUPPLIER_LOOKBACK_DAYS * 86400000));
  const { recorded, ask, billCount } = await withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      const recordedCheck = await __recordPrepaymentRegisterCheckWithClient({ client, firmId, clientId, check, actorId });
      let mintedAsk = null;
      let bills = 0;
      if (recordedCheck.subject_type === 'supplier' && recordedCheck.status === 'not_registered') {
        const billResult = await client.query(
          `select count(*)::int as bill_count, max(document_date) as last_bill_on
             from documents
            where firm_id = $1
              and client_id = $2
              and document_type = 'supplier_bill'
              and vendor_name is not null
              and lower(regexp_replace(trim(vendor_name), '\\s+', ' ', 'g')) = $3
              and document_date >= $4`,
          [firmId, clientId, recordedCheck.counterparty_key, cutoff]
        );
        bills = billResult.rows[0]?.bill_count || 0;
        if (bills > 0) {
          const question = buildPrepaymentRegisterEscalationQuestion({
            name: recordedCheck.counterparty_name,
            checkedOn: recordedCheck.checked_on,
            billCount: bills
          });
          // Deterministic ask id per supplier: a re-check reopens the same
          // ask instead of minting a sibling.
          const askId = `prepayment-register-${firmId}-${clientId}-${shortHash(recordedCheck.counterparty_key)}`;
          const askResult = await client.query(
            `insert into client_evidence_requests (
               id, firm_id, client_id, status, evidence_type, question, request_payload,
               send_count, created_by
             )
             values ($1, $2, $3, 'open', $4, $5, $6::jsonb, 0, $7)
             on conflict (id) do update set
               status = 'open',
               question = excluded.question,
               request_payload = client_evidence_requests.request_payload || excluded.request_payload,
               updated_at = now()
             returning *`,
            [
              askId, firmId, clientId, PREPAYMENT_REGISTER_EVIDENCE_TYPE, question,
              JSON.stringify({
                kind: PREPAYMENT_REGISTER_EVIDENCE_TYPE,
                counterparty_name: recordedCheck.counterparty_name,
                counterparty_key: recordedCheck.counterparty_key,
                business_id: recordedCheck.business_id,
                check_id: recordedCheck.id,
                checked_on: recordedCheck.checked_on,
                bill_count: bills
              }),
              actorId
            ]
          );
          mintedAsk = rowToClientEvidenceRequestPayload(askResult.rows[0]);
        }
      }
      await client.query('commit');
      return { recorded: recordedCheck, ask: mintedAsk, billCount: bills };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
  if (ask) {
    const deliver = deliverAsksImpl
      || ((args) => withFirmDbClientFn((client) => deliverStatutoryAsks({ client, surface: 'finland_prepayment_register', ...args })));
    await deliver({ firmId, clientId, evidenceRequestIds: [ask.id] });
  }
  return { check: recorded, escalation: ask ? { ask, bill_count: billCount } : null };
};


// G-6 read surface: own status (latest 'self' check) + the book's recent
// supplier-bill vendors joined to their latest recorded checks, each mapped
// by the pure evaluators onto the closed verdicts. Deterministic read;
// flag-gated FINLAND_PREPAYMENT_REGISTER_WATCH (config plane, dark by
// default). Never calls the registry — render-the-persisted-verdict.
export const getFinlandPrepaymentRegisterFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the prepayment-register watch.');
    error.statusCode = 400;
    throw error;
  }
  const at = readAt || new Date().toISOString();
  const atDate = String(at).slice(0, 10);
  // UTC on purpose: the look-back cutoff is stepped from the bare day
  // `atDate` in Date.UTC space — the host zone must not move it.
  const cutoff = toUtcIsoDay(new Date(Date.parse(`${atDate}T00:00:00Z`) - PREPAYMENT_REGISTER_SUPPLIER_LOOKBACK_DAYS * 86400000));
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const watchActs = clientFlagActs({ flagKey: FINLAND_PREPAYMENT_REGISTER_WATCH_FLAG_KEY, snapshot, envFallback: () => false });
    if (!watchActs) {
      const error = new Error('Finland prepayment-register watch requires FINLAND_PREPAYMENT_REGISTER_WATCH for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_PREPAYMENT_REGISTER_WATCH_DISABLED';
      throw error;
    }

    const selfCheckResult = await client.query(
      `select * from prepayment_register_checks
        where firm_id = $1 and client_id = $2 and subject_type = 'self'
        order by checked_on desc, created_at desc
        limit 1`,
      [firmId, clientId]
    );
    const supplierChecksResult = await client.query(
      `select distinct on (counterparty_key) *
         from prepayment_register_checks
        where firm_id = $1 and client_id = $2 and subject_type = 'supplier'
        order by counterparty_key, checked_on desc, created_at desc`,
      [firmId, clientId]
    );
    // The SQL normalization must stay in lockstep with counterpartyKey() in
    // finland/prepaymentRegister.js.
    const vendorsResult = await client.query(
      `select lower(regexp_replace(trim(vendor_name), '\\s+', ' ', 'g')) as vendor_key,
              max(vendor_name) as vendor_name,
              count(*)::int as bill_count,
              max(document_date) as last_bill_on
         from documents
        where firm_id = $1
          and client_id = $2
          and document_type = 'supplier_bill'
          and vendor_name is not null
          and trim(vendor_name) <> ''
          and document_date >= $3
        group by 1
        order by 3 desc
        limit 100`,
      [firmId, clientId, cutoff]
    );

    const checksByKey = new Map(
      supplierChecksResult.rows.map((row) => [row.counterparty_key, rowToPrepaymentRegisterCheckPayload(row)])
    );
    const suppliers = vendorsResult.rows.map((row) => evaluateSupplierPrepaymentRegister({
      name: row.vendor_name,
      billCount: row.bill_count,
      lastBillOn: row.last_bill_on,
      latestCheck: checksByKey.get(row.vendor_key) || null,
      onDate: at
    }));
    // A recorded not-registered supplier stays visible even when its bills
    // age out of the lookback window — the recorded fact outlives the window.
    for (const [key, recordedCheck] of checksByKey) {
      if (recordedCheck.status !== 'not_registered') continue;
      if (vendorsResult.rows.some((row) => row.vendor_key === key)) continue;
      suppliers.push(evaluateSupplierPrepaymentRegister({
        name: recordedCheck.counterparty_name,
        billCount: 0,
        lastBillOn: null,
        latestCheck: recordedCheck,
        onDate: at
      }));
    }

    const own = evaluateOwnPrepaymentRegister({
      latestCheck: rowToPrepaymentRegisterCheckPayload(selfCheckResult.rows[0]),
      onDate: at
    });
    const summary = {
      suppliers_total: suppliers.length,
      ok: suppliers.filter((s) => s.verdict === 'ok').length,
      withholding_risk: suppliers.filter((s) => s.verdict === 'withholding_risk').length,
      check_needed: suppliers.filter((s) => s.verdict === 'check_needed').length
    };
    return {
      register: { own, suppliers, summary },
      provenance: { source: 'prepayment_register_checks+documents', readAt: at, deterministic: true }
    };
  });
};


// The ALV filing start motion's gate form: dark flag → null (no gate — prod
// byte-identical until the canary acts); flag on → the drift verdict. Any
// OTHER error rethrows: a read hiccup must fail the start motion (retryable),
// never let a filing slip past an enabled gate.
export const getFinlandScopeDriftFilingGateFromDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  try {
    const envelope = await getFinlandScopeDriftFromDb({ firmId, clientId });
    return envelope.drift;
  } catch (error) {
    if (error?.code === 'FINLAND_SCOPE_DRIFT_WATCH_DISABLED') return null;
    throw error;
  }
};


// ---------------------------------------------------------------------------------
// FI-3 slice P — the ALV return lifecycle store (migration 066) + the alv_return
// ask writer + the compute-and-file start motion. D3 (Kari, 2026-07-10):
// compute-and-file; the owner's "kyllä" is the filing authority; the transmit
// channel is FI-8's injected adapter. Lifecycle enum is CLOSED
// (draft_pending_confirmation | filed | cancelled), every transition
// audit-as-precondition. Design: docs/design-donna-finland-fi3-alv-return.md.
// ---------------------------------------------------------------------------------

export const finlandAlvFilingWhatsAppFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return Boolean(clientFlagActs({ flagKey: FINLAND_ALV_FILING_FLAG_KEY, snapshot, envFallback: () => false }));
  });
};


export const createAlvReturnEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  question,
  evidenceType = 'alv_return',
  requestPayload = {},
  actorId = 'system'
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanQuestion = String(question || '').trim();
  if (!cleanClientId || !cleanQuestion) {
    const error = new Error('Client id and question are required for an ALV-return ask.');
    error.statusCode = 400;
    throw error;
  }
  const requestId = `alv-return-${firmId}-${cleanClientId}-${shortHash(`${Date.now()}:${cleanQuestion}`)}`;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `insert into client_evidence_requests (
         id, firm_id, client_id, status, evidence_type, question, request_payload,
         send_count, created_by
       )
       values ($1, $2, $3, 'open', $4, $5, $6::jsonb, 0, $7)
       returning *`,
      [
        requestId,
        firmId,
        cleanClientId,
        String(evidenceType || 'alv_return'),
        cleanQuestion,
        JSON.stringify({ kind: String(evidenceType || 'alv_return'), ...(requestPayload || {}) }),
        actorId
      ]
    );
    return rowToClientEvidenceRequestPayload(result.rows[0]);
  });
};


const rowToAlvReturnPayload = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    period_key: row.period_key,
    period_type: row.period_type,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    status: row.status,
    verdict: row.verdict || {},
    model: row.model || null,
    filing_receipt: row.filing_receipt || null,
    authority_basis: row.authority_basis || null,
    filed_at: row.filed_at || null,
    filed_by: row.filed_by || null,
    cancelled_at: row.cancelled_at || null,
    cancel_reason: row.cancel_reason || null,
    created_by: row.created_by || null
  };
};


const ALV_RETURN_STATUS_WORDS = { draft_pending_confirmation: 'waiting for the owner’s confirmation', filed: 'filed' };

const alvReturnAlreadyLiveRefusal = (period) => {
  const refusal = new Error(`An ALV return for ${period.key} is already pending or filed for this client.`);
  refusal.statusCode = 409;
  refusal.code = 'ALV_RETURN_ALREADY_LIVE';
  return refusal;
};

// The same dates may be reported only once. The same period key keeps its
// existing refusal (ALV_RETURN_ALREADY_LIVE); a DIFFERENT key over the same
// dates (a month inside a live quarter, a quarter over a live month, a year
// over either) is ALV_RETURN_PERIOD_OVERLAP, naming what already covers them.
const alvReturnOverlapRefusal = ({ period, live = [] }) => {
  if (live.some((row) => row.period_key === period.key)) return alvReturnAlreadyLiveRefusal(period);
  const named = live.map((row) => `${row.period_key} (${row.starts_on} – ${row.ends_on}, ${ALV_RETURN_STATUS_WORDS[row.status] || row.status})`);
  const refusal = new Error(
    `ALV return ${period.key} (${period.starts_on} – ${period.ends_on}) was not created: `
    + `${named.length ? `the return ${named.join(', ')}` : 'another return'} already covers some of these dates for this client. `
    + 'The same sales and purchases cannot be reported twice. A return still waiting for confirmation '
    + 'can be cancelled first; a filed return stays as filed.'
  );
  refusal.statusCode = 409;
  refusal.code = 'ALV_RETURN_PERIOD_OVERLAP';
  refusal.details = {
    period: { key: period.key, type: period.type, starts_on: period.starts_on, ends_on: period.ends_on },
    overlapping: live.map(overlappingSummary)
  };
  return refusal;
};

// The one overlap rule, shared by the draft writer, the start motion's early
// check, the filing check and the period read: a client's LIVE returns
// (draft_pending_confirmation | filed — cancelled frees its dates, as in 066)
// whose dates touch [startsOn, endsOn]. `excludeId` leaves a return out of its
// own check.
const readLiveAlvReturnsOverlapping = async (client, { firmId, clientId, startsOn, endsOn, excludeId = null }) => {
  const result = await client.query(
    `select id, period_key, period_type, starts_on::text as starts_on, ends_on::text as ends_on, status
       from alv_returns
      where firm_id = $1 and client_id = $2
        and status in ('draft_pending_confirmation', 'filed')
        and starts_on <= $4::date and ends_on >= $3::date
        and ($5::text is null or id <> $5::text)
      order by starts_on, period_key`,
    [firmId, clientId, startsOn, endsOn, excludeId]
  );
  return result.rows;
};

// The per-client, transaction-scoped lock migration 172's trigger also takes.
const lockAlvReturnPeriods = (client, { firmId, clientId }) =>
  client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`alv-return-periods:${firmId}:${clientId}`]);

const overlappingSummary = (row) => ({
  id: row.id, period_key: row.period_key, period_type: row.period_type, starts_on: row.starts_on, ends_on: row.ends_on, status: row.status
});

// Read-only: the live returns of a client that already cover any date of
// `period` (a resolved period or a key). The start motion asks this BEFORE it
// computes anything; the writer repeats the check under the lock.
export const findLiveAlvReturnsOverlappingInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, period } = {}) => {
  const resolved = typeof period === 'string' ? resolveAlvPeriod(period) : period;
  return withFirmDbClient((client) => readLiveAlvReturnsOverlapping(client, {
    firmId, clientId, startsOn: resolved.starts_on, endsOn: resolved.ends_on
  }));
};

// assertAlvReturnFileableInDb — the confirm path's check BEFORE anything is
// transmitted. Migration 172 stops new overlapping claims, but returns that
// overlapped before it existed can both be live; a status change pending →
// filed is not a new claim, so neither the writer nor the trigger sees it.
//
// Which of two overlapping returns may proceed: NEITHER, while the other is
// live. A filed return already reported those dates, so a pending one over
// them never transmits. Two pending ones over the same dates both refuse
// until the owner cancels one ("ei"); then the other files normally. Nothing
// here picks a winner, and nothing alters or deletes any return.
//
// The check takes the same per-client lock as the writer, so a draft being
// created at the same moment is seen. The lock is released before the
// transmit (no transaction is held open across the filing channel); that is
// safe because the rule is symmetric: while two overlapping returns are both
// live, each one's check sees the other, and no new overlapping live return
// can be created (writer + migration 172).
export const assertAlvReturnFileableInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, alvReturnId } = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await lockAlvReturnPeriods(client, { firmId, clientId });
      const own = await client.query(
        `select *, starts_on::text as starts_on_day, ends_on::text as ends_on_day
           from alv_returns where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
        [firmId, clientId, alvReturnId]
      );
      const row = own.rows[0];
      if (!row || row.status !== 'draft_pending_confirmation') throw alvReturnTransitionRefusal();
      const live = await readLiveAlvReturnsOverlapping(client, {
        firmId, clientId, startsOn: row.starts_on_day, endsOn: row.ends_on_day, excludeId: row.id
      });
      // A correction case opened on a posting of this period after the draft
      // was made: the stored figures include a treatment now in doubt, so
      // nothing is sent until the case is corrected or closed. The draft stays
      // pending and the ask open; the next "kyllä" checks again.
      const corrections = await readOpenCodingCorrectionsWithClient({ client, firmId, clientId,
        period: { starts_on: row.starts_on_day, ends_on: row.ends_on_day } });
      await client.query('commit');
      if (live.length) throw alvReturnFilingOverlapRefusal({ row, live });
      if (corrections.count) throw alvReturnOpenCorrectionsRefusal({ row, corrections });
      return rowToAlvReturnPayload(row);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
};

const alvReturnOpenCorrectionsRefusal = ({ row, corrections }) => {
  const refusal = new Error(
    `ALV return ${row.period_key} (${row.starts_on_day} – ${row.ends_on_day}) was not sent: `
    + `${corrections.count} posting${corrections.count === 1 ? '' : 's'} in this period ${corrections.count === 1 ? 'has' : 'have'} an open correction case. `
    + 'The return waits until each is corrected or closed.'
  );
  refusal.statusCode = 409;
  refusal.code = 'ALV_RETURN_OPEN_CODING_CORRECTIONS';
  refusal.details = {
    alv_return: { id: row.id, period_key: row.period_key, starts_on: row.starts_on_day, ends_on: row.ends_on_day },
    open_coding_corrections: corrections
  };
  return refusal;
};

const alvReturnFilingOverlapRefusal = ({ row, live }) => {
  const named = live.map((other) => `${other.period_key} (${other.starts_on} – ${other.ends_on}, ${ALV_RETURN_STATUS_WORDS[other.status] || other.status})`);
  const anyFiled = live.some((other) => other.status === 'filed');
  const refusal = new Error(
    `ALV return ${row.period_key} (${row.starts_on_day} – ${row.ends_on_day}) was not sent: `
    + `the return ${named.join(', ')} already covers some of these dates for this client. `
    + 'The same sales and purchases cannot be reported twice. '
    + (anyFiled
      ? 'A filed return stays as filed; this return can be cancelled.'
      : 'Neither return is sent while both are waiting; cancel one of them first.')
  );
  refusal.statusCode = 409;
  refusal.code = 'ALV_RETURN_FILING_OVERLAP';
  refusal.details = {
    alv_return: { id: row.id, period_key: row.period_key, starts_on: row.starts_on_day, ends_on: row.ends_on_day },
    overlapping: live.map(overlappingSummary)
  };
  return refusal;
};

// Callers must hold a transaction on `client` (createAlvReturnDraftInDb does):
// the overlap check's advisory lock is transaction-scoped.
export const __createAlvReturnDraftWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  period,
  verdict,
  model = null,
  actorId = 'system'
} = {}) => {
  if (!clientId || !period?.key || !verdict?.alvReturn) {
    const error = new Error('Client id, a resolved period, and a computed verdict are required to draft an ALV return.');
    error.statusCode = 400;
    throw error;
  }
  // A needs_review compute must NEVER mint a row — its blockers ride an owner
  // clarification ask instead (no parked state). Typed refusal, not a shade.
  if (verdict.review?.status !== 'ready') {
    const error = new Error(`ALV return is not ready to draft: ${(verdict.review?.blockers || []).join(', ') || 'needs_review'}.`);
    error.statusCode = 409;
    error.code = 'ALV_RETURN_NEEDS_REVIEW';
    throw error;
  }
  // No two live returns of a client may cover the same date, whatever their
  // period keys (migration 172): after a verokausi change a monthly draft
  // inside a pending or filed quarter (or year) would report the same sales
  // and purchases twice. The
  // check runs in the caller's transaction under a per-client advisory lock
  // (the same key migration 172's trigger takes), so two overlapping drafts
  // started together serialise and the second sees the first. A cancelled
  // return frees its dates. Nothing here changes an existing return.
  await lockAlvReturnPeriods(client, { firmId, clientId });
  const live = await readLiveAlvReturnsOverlapping(client, { firmId, clientId, startsOn: period.starts_on, endsOn: period.ends_on });
  if (live.length) throw alvReturnOverlapRefusal({ period, live });
  const id = `alv-return-${firmId}-${clientId}-${period.key.toLowerCase()}-${shortHash(`${Date.now()}`)}`;
  let inserted;
  try {
    inserted = await client.query(
      `insert into alv_returns (
         id, firm_id, client_id, period_key, period_type, starts_on, ends_on, status, verdict, model, created_by
       )
       values ($1, $2, $3, $4, $5, $6, $7, 'draft_pending_confirmation', $8::jsonb, $9, $10)
       returning *`,
      [id, firmId, clientId, period.key, period.type, period.starts_on, period.ends_on, JSON.stringify(verdict), model, actorId]
    );
  } catch (error) {
    if (error?.code === '23505') throw alvReturnAlreadyLiveRefusal(period);
    // Migration 172's backstop fired (a row the check above could not see).
    if (error?.code === '23P01') throw alvReturnOverlapRefusal({ period, live: [] });
    throw error;
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'alv_return.draft_created', 'alv_return', $4, $5::jsonb)`,
    [firmId, clientId, actorId, id, JSON.stringify({
      period_key: period.key,
      payable: verdict.alvReturn?.payable ?? null,
      nil_return: verdict.alvReturn?.nilReturn === true,
      model: model || null
    })]
  );
  return rowToAlvReturnPayload(inserted.rows[0]);
};


export const createAlvReturnDraftInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __createAlvReturnDraftWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


// Guarded transition helper: only a pending draft moves; anything else is a
// typed refusal, never a shade.
const alvReturnTransitionRefusal = () => {
  const error = new Error('ALV return transition refused: the row is not a pending draft.');
  error.statusCode = 409;
  error.code = 'ALV_RETURN_NOT_PENDING';
  return error;
};


export const __cancelAlvReturnWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  alvReturnId,
  reason = 'owner_declined',
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update alv_returns
        set status = 'cancelled', cancelled_at = now(), cancel_reason = $5,
            authority_basis = $6::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, alvReturnId, 'draft_pending_confirmation', String(reason || 'owner_declined'), JSON.stringify(authorityBasis || null)]
  );
  if (!updated.rows.length) throw alvReturnTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'alv_return.cancelled', 'alv_return', $4, $5::jsonb)`,
    [firmId, clientId, actorId, alvReturnId, JSON.stringify({
      period_key: updated.rows[0].period_key,
      reason: String(reason || 'owner_declined'),
      authority_basis: authorityBasis || null
    })]
  );
  return rowToAlvReturnPayload(updated.rows[0]);
};


export const cancelAlvReturnInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __cancelAlvReturnWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


export const __markAlvReturnFiledWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  alvReturnId,
  filingReceipt = null,
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  if (!authorityBasis || !authorityBasis.source) {
    const error = new Error("Filing an ALV return requires the owner's authority basis (the confirmation receipt).");
    error.statusCode = 400;
    error.code = 'ALV_RETURN_AUTHORITY_REQUIRED';
    throw error;
  }
  const updated = await client.query(
    `update alv_returns
        set status = 'filed', filed_at = now(), filed_by = $5,
            filing_receipt = $6::jsonb, authority_basis = $7::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, alvReturnId, 'draft_pending_confirmation', actorId, JSON.stringify(filingReceipt || null), JSON.stringify(authorityBasis)]
  );
  if (!updated.rows.length) throw alvReturnTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'alv_return.filed', 'alv_return', $4, $5::jsonb)`,
    [firmId, clientId, actorId, alvReturnId, JSON.stringify({
      period_key: updated.rows[0].period_key,
      payable: updated.rows[0].verdict?.alvReturn?.payable ?? null,
      submission_id: filingReceipt?.submission_id || null,
      channel: filingReceipt?.channel || null,
      authority_basis: authorityBasis,
      // The model id is part of the receipt (null for a deterministic compute).
      model: updated.rows[0].model || filingReceipt?.model || null
    })]
  );
  return rowToAlvReturnPayload(updated.rows[0]);
};


export const markAlvReturnFiledInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __markAlvReturnFiledWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


export const getAlvReturnByIdInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, alvReturnId } = {}) => {
  if (!alvReturnId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      'select * from alv_returns where firm_id = $1 and client_id = $2 and id = $3 limit 1',
      [firmId, clientId, alvReturnId]
    );
    return rowToAlvReturnPayload(result.rows[0]);
  });
};


// The period read: the latest lifecycle row for the exact period key (the
// read surface renders it beside the compute envelope; latest-first so a
// cancel followed by a re-mint shows the live row), and `covered_by`: the
// client's OTHER live returns whose dates overlap the period's (the same rule
// the writer refuses on). Looking at 2026-09 shows that a filed 2026-Q3
// already covers it. One query; nothing inferred client-side.
export const getAlvReturnForPeriodInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, periodKey } = {}) => {
  if (!clientId || !periodKey) return { lifecycle: null, covered_by: [] };
  const period = resolveAlvPeriod(periodKey);
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select *, starts_on::text as starts_on_day, ends_on::text as ends_on_day
         from alv_returns
        where firm_id = $1 and client_id = $2
          and (period_key = $3
               or (status in ('draft_pending_confirmation', 'filed')
                   and starts_on <= $5::date and ends_on >= $4::date))
        order by created_at desc`,
      [firmId, clientId, period.key, period.starts_on, period.ends_on]
    );
    const lifecycle = result.rows.find((row) => row.period_key === period.key) || null;
    const coveredBy = result.rows
      .filter((row) => row.period_key !== period.key)
      .map((row) => ({
        ...overlappingSummary({ ...row, starts_on: row.starts_on_day, ends_on: row.ends_on_day }),
        filed_at: row.filed_at || null
      }))
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.period_key.localeCompare(b.period_key));
    return { lifecycle: rowToAlvReturnPayload(lifecycle), covered_by: coveredBy };
  });
};


// ---------------------------------------------------------------------------------
// G-3 (FI-15) — the Suomi.fi mandate store (migration 067). The mandate is the
// LEGAL authorization Verohallinto sees when Donna files for a client (D-FI8-1);
// the transmit seam refuses without a valid one (ALV_FILING_MANDATE_REQUIRED).
// Status enum is CLOSED (active | revoked); expiry evaluates at read time
// (evaluateSuomifiMandate). Record/revoke are firm actions: audit-as-precondition,
// operator-attributed. Design: docs/design-donna-finland-production-readiness.md.
// ---------------------------------------------------------------------------------

const rowToSuomifiMandatePayload = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    scope: row.scope,
    status: row.status,
    granted_on: row.granted_on,
    expires_on: row.expires_on || null,
    revoked_on: row.revoked_on || null,
    revoke_reason: row.revoke_reason || null,
    reference: row.reference || null,
    provenance: row.provenance || {},
    recorded_by: row.recorded_by || null,
    created_at: row.created_at || null
  };
};


export const __recordSuomifiMandateWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  scope = SUOMIFI_MANDATE_SCOPE_TAX,
  grantedOn,
  expiresOn = null,
  reference = null,
  provenance = {},
  actorId = 'system'
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanScope = String(scope || '').trim();
  const cleanGrantedOn = String(grantedOn || '').slice(0, 10);
  if (!cleanClientId || !cleanScope || !/^\d{4}-\d{2}-\d{2}$/.test(cleanGrantedOn)) {
    const error = new Error('Recording a Suomi.fi mandate requires client id, scope, and a granted_on date (YYYY-MM-DD).');
    error.statusCode = 400;
    throw error;
  }
  const id = `suomifi-mandate-${firmId}-${cleanClientId}-${shortHash(`${cleanScope}:${Date.now()}`)}`;
  let inserted;
  try {
    inserted = await client.query(
      `insert into suomifi_mandates (
         id, firm_id, client_id, scope, status, granted_on, expires_on, reference, provenance, recorded_by
       )
       values ($1, $2, $3, $4, 'active', $5, $6, $7, $8::jsonb, $9)
       returning *`,
      [id, firmId, cleanClientId, cleanScope, cleanGrantedOn, expiresOn || null, reference || null, JSON.stringify(provenance || {}), actorId]
    );
  } catch (error) {
    if (error?.code === '23505') {
      const refusal = new Error(`An active Suomi.fi mandate (${cleanScope}) is already recorded for this client — revoke it before recording a new grant.`);
      refusal.statusCode = 409;
      refusal.code = 'SUOMIFI_MANDATE_ALREADY_ACTIVE';
      throw refusal;
    }
    throw error;
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm_member', $3, 'suomifi_mandate.recorded', 'suomifi_mandate', $4, $5::jsonb)`,
    [firmId, cleanClientId, actorId, id, JSON.stringify({
      scope: cleanScope,
      granted_on: cleanGrantedOn,
      expires_on: expiresOn || null,
      reference: reference || null,
      provenance: provenance || {}
    })]
  );
  return rowToSuomifiMandatePayload(inserted.rows[0]);
};


export const recordSuomifiMandateInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __recordSuomifiMandateWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


export const __revokeSuomifiMandateWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  mandateId,
  reason = 'revoked_by_firm',
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update suomifi_mandates
        set status = 'revoked', revoked_on = now()::date, revoke_reason = $5, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, mandateId, 'active', String(reason || 'revoked_by_firm')]
  );
  if (!updated.rows.length) {
    const error = new Error('Suomi.fi mandate revocation refused: the row is not an active mandate.');
    error.statusCode = 409;
    error.code = 'SUOMIFI_MANDATE_NOT_ACTIVE';
    throw error;
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm_member', $3, 'suomifi_mandate.revoked', 'suomifi_mandate', $4, $5::jsonb)`,
    [firmId, clientId, actorId, mandateId, JSON.stringify({
      scope: updated.rows[0].scope,
      reason: String(reason || 'revoked_by_firm')
    })]
  );
  return rowToSuomifiMandatePayload(updated.rows[0]);
};


export const revokeSuomifiMandateInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __revokeSuomifiMandateWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


// The filing gate's lookup: the single active row for (client, scope). Validity
// (expiry, effectivity) is evaluated by the PURE module at the filing moment —
// this read never decides, it only fetches.
export const getActiveSuomifiMandateInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  scope = SUOMIFI_MANDATE_SCOPE_TAX
} = {}) => {
  if (!clientId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select * from suomifi_mandates
        where firm_id = $1 and client_id = $2 and scope = $3 and status = 'active'
        order by created_at desc limit 1`,
      [firmId, clientId, String(scope)]
    );
    return rowToSuomifiMandatePayload(result.rows[0]);
  });
};


// The report surface: mandate + dated evaluation in one envelope
// (render-the-persisted-verdict — the panel shows THIS, never a client-side
// re-derivation of validity).
export const getSuomifiMandateStatusInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  scope = SUOMIFI_MANDATE_SCOPE_TAX,
  readAt = new Date().toISOString()
} = {}) => {
  const mandate = await getActiveSuomifiMandateInDb({ firmId, clientId, scope });
  const evaluation = evaluateSuomifiMandate({ mandate, scope, onDate: readAt });
  return { scope: String(scope), mandate, evaluation, read_at: readAt };
};


// The ALV escalation question, per owner language (preferredOwnerTemplateLanguage).
// A census item resting part_settled_in_period is part-paid: only its unpaid
// remainder is missing from the figures, so it is named apart from a document
// that is not recorded at all (the wording of salesRecognitionGap.js
// recognitionStatement).
const ALV_REVIEW_QUESTION_COPY = Object.freeze({
  fi: Object.freeze({
    notReady: (key) => `ALV-ilmoitus (${key}) ei ole vielä valmis lähetettäväksi.`,
    uncoded: (n) => `${n} tulotapahtumaa ilman ALV-käsittelyä — kerro, mitä myyntiä nämä ovat.`,
    incompatible: (n) => `${n} kirjausta, joiden ALV-koodi ei sovi tilille — tarkistan ne kanssasi.`,
    salesUnrecorded: (n) => `${n} ladattua myyntilaskua tai hyvityslaskua ei ole vielä kirjattu tämän kauden myyntiin, joten niiden myynti ja ALV puuttuvat laskelmasta.`,
    salesPartPaid: (n) => (n === 1
      ? '1 ladattu myyntilasku on maksettu tällä kaudella vain osittain, joten sen maksamattoman loppuosan myynti ja ALV puuttuvat laskelmasta.'
      : `${n} ladattua myyntilaskua on maksettu tällä kaudella vain osittain, joten niiden maksamattoman loppuosan myynti ja ALV puuttuvat laskelmasta.`),
    purchasesUnrecorded: (n) => `${n} ladattua ostolaskua tai ostohyvityslaskua ei ole vielä kirjattu tämän kauden ostoihin, joten niiden kulut ja vähennettävä ALV puuttuvat laskelmasta.`,
    purchasesPartPaid: (n) => (n === 1
      ? '1 ladattu ostolasku on maksettu tällä kaudella vain osittain, joten sen maksamattoman loppuosan kulut ja vähennettävä ALV puuttuvat laskelmasta.'
      : `${n} ladattua ostolaskua on maksettu tällä kaudella vain osittain, joten niiden maksamattoman loppuosan kulut ja vähennettävä ALV puuttuvat laskelmasta.`),
    drift: 'Kirjanpidossa on toimintaa, jonka ALV-käsittely tarkistetaan ennen lähetystä (mm. rakennusalan käännetty ALV) — selvitän sen kanssasi.',
    corrections: (n) => (n === 1
      ? 'Yhtä tämän kauden kirjausta korjataan parhaillaan, ja ilmoitus odottaa, kunnes korjaus on tehty.'
      : `${n} tämän kauden kirjausta korjataan parhaillaan, ja ilmoitus odottaa, kunnes korjaukset on tehty.`)
  }),
  en: Object.freeze({
    notReady: (key) => `The VAT return (${key}) is not ready to file yet.`,
    uncoded: (n) => `${n} income ${n === 1 ? 'transaction has' : 'transactions have'} no VAT treatment yet. Tell me what sales ${n === 1 ? 'this is' : 'these are'}.`,
    incompatible: (n) => `${n} ${n === 1 ? 'entry has a VAT code that does' : 'entries have a VAT code that does'} not fit the account. I will go through ${n === 1 ? 'it' : 'them'} with you.`,
    salesUnrecorded: (n) => `${n} uploaded sales ${n === 1 ? 'invoice or credit note is' : 'invoices or credit notes are'} not yet recorded in this period's sales, so ${n === 1 ? 'its' : 'their'} sales and VAT are missing from the calculation.`,
    salesPartPaid: (n) => `${n} uploaded sales ${n === 1 ? 'invoice is' : 'invoices are'} paid only in part in this period, so the sales and VAT of ${n === 1 ? 'its' : 'their'} unpaid remainder are missing from the calculation.`,
    purchasesUnrecorded: (n) => `${n} uploaded purchase ${n === 1 ? 'invoice or supplier credit note is' : 'invoices or supplier credit notes are'} not yet recorded in this period's purchases, so ${n === 1 ? 'its' : 'their'} costs and deductible VAT are missing from the calculation.`,
    purchasesPartPaid: (n) => `${n} uploaded purchase ${n === 1 ? 'invoice is' : 'invoices are'} paid only in part in this period, so the costs and deductible VAT of ${n === 1 ? 'its' : 'their'} unpaid remainder are missing from the calculation.`,
    drift: 'Your books show activity whose VAT treatment has to be checked before filing (for example reverse-charge VAT in construction). I will sort it out with you.',
    corrections: (n) => `${n} ${n === 1 ? 'posting' : 'postings'} in this period ${n === 1 ? 'is' : 'are'} being corrected, and the return waits until that is done.`
  })
});

const PART_PAID_REST = 'part_settled_in_period';
const censusCounts = (side) => {
  const items = Array.isArray(side?.items) ? side.items : [];
  const partPaid = items.filter((item) => item?.rests === PART_PAID_REST).length;
  return { unrecorded: items.length - partPaid, partPaid };
};

export const buildFinlandAlvReviewQuestion = ({ review = {}, periodKey = '', driftBlocked = false, language = 'fi' } = {}) => {
  const copy = ALV_REVIEW_QUESTION_COPY[language] || ALV_REVIEW_QUESTION_COPY.fi;
  const uncoded = review?.uncodedRevenueLines?.length || 0;
  const incompatible = review?.incompatibleLines?.length || 0;
  const sales = censusCounts(review?.unrecognizedSales);
  const purchases = censusCounts(review?.unrecognizedPurchases);
  const corrections = Number(review?.openCodingCorrections?.count) || 0;
  return [
    copy.notReady(periodKey),
    uncoded ? copy.uncoded(uncoded) : '',
    incompatible ? copy.incompatible(incompatible) : '',
    sales.unrecorded ? copy.salesUnrecorded(sales.unrecorded) : '',
    sales.partPaid ? copy.salesPartPaid(sales.partPaid) : '',
    purchases.unrecorded ? copy.purchasesUnrecorded(purchases.unrecorded) : '',
    purchases.partPaid ? copy.purchasesPartPaid(purchases.partPaid) : '',
    corrections ? copy.corrections(corrections) : '',
    driftBlocked ? copy.drift : ''
  ].filter(Boolean).join(' ');
};

// startFinlandAlvReturnFilingInDb — the lane's start motion. Computes the period
// return (the same deterministic read as getFinlandAlvReturnFromDb), then drives
// it to one of the two sanctioned places:
//   • ready  → mint the draft row + the alv_return confirm ask, deliver over the
//     existing outbound-ask substrate (binding, ref anchor, delivery ledger) —
//     ON THE OWNER;
//   • needs_review → NO row; the blockers ride an owner clarification ask
//     (evidence_type alv_return_review, resolved via the generic evidence path)
//     — ON THE OWNER.
// The trigger itself is an action (member/API today, a loop goal later), not a
// resting state. Gated by FINLAND_ALV_FILING (the compute read inside keeps its
// own FINLAND_ALV_RETURN gate).
export const startFinlandAlvReturnFilingInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  period,
  actorId = 'system',
  computeImpl = null,
  deliverAsksImpl = null,
  flagActsImpl = null,
  createDraftImpl = null,
  createAskImpl = null,
  scopeDriftImpl = null,
  liveOverlapImpl = null,
  // The owner's language: the one resolver over the client row ('en' on a
  // failed read), the language the owner-facing question is written in.
  ownerLanguageImpl = null,
  shortfallAsksImpl = null
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to start an ALV return filing.');
    error.statusCode = 400;
    throw error;
  }
  const flagActsFn = flagActsImpl || finlandAlvFilingWhatsAppFlagActsInDb;
  const filingActs = await flagActsFn({ firmId, clientId });
  if (!filingActs) {
    const error = new Error('The Finland ALV filing lane is not enabled for this client.');
    error.statusCode = 403;
    error.code = 'FINLAND_ALV_FILING_DISABLED';
    throw error;
  }
  // The overlap rule first: a period another live return already covers (or
  // its own key, already live) cannot be created, so nothing is computed and
  // nobody is asked about it. The writer repeats the check under the lock.
  const requestedPeriod = resolveAlvPeriod(period);
  const coveringFn = liveOverlapImpl || findLiveAlvReturnsOverlappingInDb;
  const covering = await coveringFn({ firmId, clientId, period: requestedPeriod });
  if (covering.length) throw alvReturnOverlapRefusal({ period: requestedPeriod, live: covering });
  const compute = computeImpl || getFinlandAlvReturnFromDb;
  const computed = await compute({ firmId, clientId, period });

  // G-7: the scope-drift gate. A filing_blocked verdict (e.g. construction
  // reverse charge in the book) escalates through the SAME owner-clarification
  // lane as a needs_review compute — no draft, no confirm ask, nothing files
  // until the drift is reviewed. Dark flag → null → no gate.
  const driftGate = scopeDriftImpl || getFinlandScopeDriftFilingGateFromDb;
  const drift = await driftGate({ firmId, clientId });
  const driftBlockers = drift?.verdict === 'filing_blocked'
    ? drift.triggers.filter((t) => t.severity === 'filing_blocked').map((t) => `scope_drift_${t.id}`)
    : [];

  const readOwnerLanguage = ownerLanguageImpl || getClientOwnerLanguageInDb;
  const language = await Promise.resolve()
    .then(() => readOwnerLanguage({ firmId, clientId }))
    .catch(() => 'en');

  if (computed.review?.status !== 'ready' || driftBlockers.length) {
    const blockers = [...(computed.review?.blockers || []), ...driftBlockers];
    const question = buildFinlandAlvReviewQuestion({
      review: computed.review,
      periodKey: computed.period.key,
      driftBlocked: driftBlockers.length > 0,
      language
    });
    // A sales payment short of its invoice with nothing recorded about why is
    // its own question to the owner (bank fee or part-payment), never twice.
    const unexplainedShortfalls = (computed.review?.unrecognizedSales?.items || []).some((i) => i.shortfall && i.on_nobody);
    const shortfallAsks = unexplainedShortfalls
      ? await (shortfallAsksImpl || ((args) => withFirmDbClient((client) => ensureSettlementShortfallAsksWithClient({ client, ...args }))))({
        firmId, clientId, period: computed.review.unrecognizedSales.period, actorId })
      : null;
    const createAsk = createAskImpl || createAlvReturnEvidenceRequestInDb;
    const ask = await createAsk({
      firmId,
      clientId,
      question,
      evidenceType: 'alv_return_review',
      requestPayload: { period_key: computed.period.key, blockers },
      actorId
    });
    const deliver = deliverAsksImpl
      || ((args) => withFirmDbClient((client) => deliverStatutoryAsks({ client, surface: 'finland_alv_return', ...args })));
    // The shortfall questions go out through the same gate as the escalation.
    await deliver({ firmId, clientId, evidenceRequestIds: [ask.id, ...(shortfallAsks?.asked || [])] });
    return { action: 'escalated', blockers, ask, period: computed.period, ...(shortfallAsks ? { shortfall_asks: shortfallAsks } : {}) };
  }

  const createDraft = createDraftImpl || createAlvReturnDraftInDb;
  const row = await createDraft({
    firmId,
    clientId,
    period: computed.period,
    verdict: { alvReturn: computed.alvReturn, review: computed.review, provenance: computed.provenance },
    model: null,
    actorId
  });
  const question = alvReturnConfirmQuestion({ periodKey: row.period_key, verdict: row.verdict, language });
  const createAsk = createAskImpl || createAlvReturnEvidenceRequestInDb;
  const ask = await createAsk({
    firmId,
    clientId,
    question,
    evidenceType: 'alv_return',
    requestPayload: { alv_return: { phase: 'confirm_request', alv_return_id: row.id, period_key: row.period_key } },
    actorId
  });
  const deliver = deliverAsksImpl
    || ((args) => withFirmDbClient((client) => deliverStatutoryAsks({ client, surface: 'finland_alv_return', ...args })));
  await deliver({ firmId, clientId, evidenceRequestIds: [ask.id] });
  return { action: 'confirmation_requested', alvReturn: row, ask };
};
