// GB statutory report composition. Country legal-form branching, deadlines and
// owner-transaction watch policy stay in the country implementation. The HTTP
// caller retains access checks and its established jurisdiction gate.
import { computeGbLtdStatutoryDeadlines } from './ltdStatutoryDeadlines.js';
import { buildGbLlpStatutoryDeadlines } from './llpStatutoryDeadlines.js';
import { buildGbPartnershipStatutoryDeadlines } from './partnershipStatutoryDeadlines.js';
import { buildGbOwnerTransactionWatchRows } from './ownerTransactionWatchRows.js';
import { gbOwnerTransactionTaxonomyEnabled } from './ownerTransactionTaxonomy.js';
import { buildGbSoleTraderStatutoryDeadlines } from './soleTraderStatutoryDeadlines.js';
import { buildGbVatDeadlineRows } from './vatDeadlines.js';
import { gbEntityType } from './entity.js';
import { GB_LTD_CLOSE_BLOCKER_SURFACE } from './ltdMonthlyClose.js';
import { readClientConfigSnapshot } from '../clientConfig.js';
import { queryFirmDb } from '../db/pool.js';
import { toLocalIsoDay } from '../dates.js';
import { resolveSellerJurisdiction } from '../ownerInvoiceSellerContext.js';

export const getGbStatutoryReportFromDb = async ({ firmId, clientId, clientRecord, asOf = toLocalIsoDay(new Date()), query = queryFirmDb } = {}) => {
  const client = clientRecord || {};
  // A historical profile cannot admit a current GB report. Keep the existing
  // canonical GB spelling boundary while refusing conflicting persisted homes.
  if (String(client.jurisdiction || '').toUpperCase() !== 'GB' || resolveSellerJurisdiction(client).jurisdiction !== 'gb') {
    const error = new Error('GB statutory report is not available for this client identity.');
    error.code = 'GB_STATUTORY_SURFACE_NOT_AVAILABLE';
    error.statusCode = 404;
    throw error;
  }
  // GB profile facts live under profile.gb — the SAME contract the #1192
  // close-pack consumer reads (firmDb.js gbProfile). Nothing writes them
  // yet; when onboarding captures them, both readers must agree on the path.
  const gbProfile = (client.profile || {}).gb || {}; let deadlines = []; let provenance = null;
  const entityAxis = gbEntityType(client);
  const entityType = ({ ltd: 'gb-ltd', llp: 'gb-llp', sole_trader: 'gb-sole-trader', partnership: 'gb-partnership' })[entityAxis] || null;
  // Host-local "today" (audit F-11).
  if (entityAxis === 'sole_trader') {
    const envelope = buildGbSoleTraderStatutoryDeadlines({ profile: { ...client.profile, ...gbProfile }, asOf });
    deadlines = envelope.deadlines; provenance = envelope.provenance;
  } else if (entityAxis === 'partnership') {
    const envelope = buildGbPartnershipStatutoryDeadlines({ profile: { ...client.profile, ...gbProfile }, asOf });
    deadlines = envelope.deadlines; provenance = envelope.provenance;
  } else if (entityAxis === 'llp') {
    const envelope = buildGbLlpStatutoryDeadlines({ profile: { ...client.profile, ...gbProfile }, asOf });
    deadlines = envelope.deadlines; provenance = envelope.provenance;
  } else if (entityAxis === 'ltd') {
    if (gbProfile.accounting_period_end && gbProfile.confirmation_review_period_end && gbProfile.vat_stagger) {
      const computed = computeGbLtdStatutoryDeadlines({ accountingPeriodEnd: gbProfile.accounting_period_end, confirmationReviewPeriodEnd: gbProfile.confirmation_review_period_end, vatStagger: gbProfile.vat_stagger });
      deadlines = [['accounts', 'Companies House accounts', computed.companiesHouseAccountsDue], ['confirmation', 'Confirmation statement', computed.confirmationStatementDue], ['ct600', 'Company Tax Return', computed.ct600Due], ['corporation_tax', 'Corporation Tax payment', computed.corporationTaxPaymentDue]].map(([key, label, due]) => ({ key, label, due_date: due.due_date }));
    }
    const vatOnDate = gbProfile.accounting_period_end || asOf;
    // vat_registration is a TOP-LEVEL profile key (clientProfileSchema.js
    // KNOWN_KEYS) while vat_stagger lives under profile.gb — spread both,
    // as the sole-trader and partnership lanes above do, or a registered
    // client reads as NOT_ESTABLISHED here while the VAT return route
    // (which reads the top-level home) renders a return.
    deadlines.push(...buildGbVatDeadlineRows({
      profile: { ...client.profile, ...gbProfile },
      onDate: vatOnDate,
      year: Number(vatOnDate.slice(0, 4)),
      refusalCodes: {
        vatRegistration: 'GB_LTD_VAT_REGISTRATION_NOT_ESTABLISHED',
        vatStagger: 'GB_LTD_VAT_STAGGER_NOT_ESTABLISHED'
      }
    }));
  } else {
    deadlines = [{
      key: 'entity_type', label: 'UK legal form', due_date: null,
      terminal: 'on_owner', reason_code: 'GB_ENTITY_TYPE_NOT_ESTABLISHED'
    }];
  }
  // Row-3 watch mount, flag-dark: the DLA s455/beneficial-loan watch (ltd)
  // and the negative-owner-equity advisory (sole trader) render only when
  // GB_OWNER_TRANSACTION_TAXONOMY acts for this client — no stage row
  // means no balance query and a byte-identical envelope. Balances resolve
  // by canonical role from posted lines, never by account code.
  if ((entityAxis === 'ltd' || entityAxis === 'sole_trader')
    && gbOwnerTransactionTaxonomyEnabled({ snapshot: await readClientConfigSnapshot({ query: query }, { firmId, clientId }) })) {
    const balances = await query(
      `select la.canonical_role, la.account_type,
              coalesce(sum(ll.debit), 0) as debit_total,
              coalesce(sum(ll.credit), 0) as credit_total
         from ledger_lines ll
         join ledger_journals lj on lj.id = ll.journal_id
         join ledger_accounts la on la.id = ll.account_id
        where lj.firm_id = $1 and lj.client_id = $2 and lj.status in ('posted', 'closed')
        group by la.canonical_role, la.account_type`,
      [firmId, clientId]
    );
    deadlines.push(...buildGbOwnerTransactionWatchRows({ entityAxis, balanceRows: balances.rows }));
  }
  const asks = await query(`select request_payload from client_evidence_requests where firm_id = $1 and client_id = $2 and evidence_type = 'vat_threshold_review' order by created_at desc limit 1`, [firmId, clientId]);
  const thresholdWatch = asks.rows[0]?.request_payload?.watch || asks.rows[0]?.request_payload || null;
  return { entity_type: entityType, thresholdWatch, deadlines, provenance };
};

export const buildGbLtdCloseRefusalEnvelope = (code) => ({
  close: { items: [{ id: code.toLowerCase(), terminal: 'on_owner', reason_code: code, blocker_surface: GB_LTD_CLOSE_BLOCKER_SURFACE, evidence: null }] },
  minted: [],
  open_blockers: [],
  provenance: { persisted: false, refusal: code }
});
