// Finnish posting admission and the existing scope-drift receipt/owner lifecycle.
// Runs under the named ledger writer's transaction; never writes a journal itself.
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { lifecycleJurisdiction } from '../countryLifecycleContext.js';
import { finlandEntityType } from './entity.js';
import { FINLAND_INVOICING_FLAG_KEY, FINLAND_OPENING_BALANCES_FLAG_KEY, FINLAND_TILIKAUSI_FLAG_KEY, FINLAND_TOSITENUMERO_FLAG_KEY } from './tilikausi.js';
import { buildScopeDriftEscalationQuestion, evaluateJournalScopeDrift, FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY, SCOPE_DRIFT_EVIDENCE_TYPE, scopeDriftAskId, suggestionFiresReverseChargeDrift } from './scopeDrift.js';
const acts = (snapshot, flagKey, env = process.env) => clientFlagActs({ flagKey, snapshot, envFallback: () => false, env });
const openingBalanceActs = ({ snapshot }) => acts(snapshot, FINLAND_OPENING_BALANCES_FLAG_KEY) && acts(snapshot, FINLAND_TILIKAUSI_FLAG_KEY);
const beforeJournalWrite = async ({ client, firmId, clientId, journalId, journal, payload, actorId, clientRow, evaluatedAt }) => {
  let effectivePayload = payload;
  let journalDrift = evaluateJournalScopeDrift({ lines: journal.lines });
  if (journalDrift.triggers.length > 0) {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const entityAxis = finlandEntityType(clientRow) || 'toiminimi';
    if (entityAxis === 'oy') {
      journalDrift = evaluateJournalScopeDrift({ lines: journal.lines, entityAxis });
    }
    const postingGateActs = clientFlagActs({
      flagKey: FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY, snapshot, envFallback: () => false
    });
    if (postingGateActs) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'ledger.scope_drift_detected', 'ledger_journal', $4, $5::jsonb)`,
        [firmId, clientId, actorId, journalId, JSON.stringify({
          verdict: journalDrift.verdict,
          triggers: journalDrift.triggers.map((t) => ({ id: t.id, severity: t.severity, evidence: t.evidence })),
          source_type: journal.source_type,
          source_id: journal.source_id,
          authority_basis: `client_capability_config:${FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY}`
        })]
      );
      effectivePayload = {
        ...payload,
        scope_drift: { verdict: journalDrift.verdict, triggers: journalDrift.triggers, evaluated_at: evaluatedAt }
      };
      for (const trigger of journalDrift.triggers) {
        const askId = scopeDriftAskId({ firmId, clientId, triggerId: trigger.id });
        const askResult = await client.query(
          `insert into client_evidence_requests (
             id, firm_id, client_id, status, evidence_type, question, request_payload, send_count, created_by
           )
           values ($1, $2, $3, 'open', $4, $5, $6::jsonb, 0, $7)
           on conflict (id) do nothing
           returning id`,
          [
            askId, firmId, clientId, SCOPE_DRIFT_EVIDENCE_TYPE,
            buildScopeDriftEscalationQuestion({ trigger }),
            JSON.stringify({
              kind: SCOPE_DRIFT_EVIDENCE_TYPE,
              trigger_id: trigger.id,
              severity: trigger.severity,
              journal_id: journalId,
              source_type: journal.source_type,
              source_id: journal.source_id
            }),
            actorId
          ]
        );
        if (askResult.rows.length > 0) {
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, $2, 'system', $3, 'scope_drift.escalated', 'client_evidence_request', $4, $5::jsonb)`,
            [firmId, clientId, actorId, askId, JSON.stringify({
              trigger_id: trigger.id,
              severity: trigger.severity,
              journal_id: journalId,
              authority_basis: `client_capability_config:${FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY}`
            })]
          );
        }
      }
    }
  }
  return effectivePayload;
};
export const FI_POSTING_ADMISSION = Object.freeze({
  beforeJournalWrite,
  voucherNumberingActs: ({ snapshot }) => acts(snapshot, FINLAND_TOSITENUMERO_FLAG_KEY) && acts(snapshot, FINLAND_TILIKAUSI_FLAG_KEY),
  openingBalanceActs,
  assertOpeningBalanceJurisdiction(row) {
    if (lifecycleJurisdiction(row) !== 'fi') {
      const message = String(row?.jurisdiction || '').toUpperCase() === 'GB' ? 'The Finland opening-balance adapter cannot post a GB client.' : 'The Finland opening-balance adapter requires a Finnish client.';
      throw Object.assign(new Error(message), { statusCode: 409, code: 'FINLAND_OPENING_BALANCE_JURISDICTION_REQUIRED' });
    }
  },
  assertOpeningBalanceEnabled({ snapshot }) {
    if (!openingBalanceActs({ snapshot })) throw Object.assign(new Error('Opening-balance seeding requires FINLAND_OPENING_BALANCES (and its dependency FINLAND_TILIKAUSI) for this client.'), { statusCode: 409, code: 'FINLAND_OPENING_BALANCES_DISABLED' });
  },
  assertInvoiceEnabled({ snapshot, kind }) {
    if (!acts(snapshot, FINLAND_INVOICING_FLAG_KEY)) throw Object.assign(new Error(`${kind} posting requires FINLAND_INVOICING for this client.`), { statusCode: 409, code: 'FINLAND_INVOICING_DISABLED' });
  },
  codingAutoPostVerdict({ verdict, suggestion = {}, snapshot, scopeDriftPostingGateActs, env }) {
    const enabled = scopeDriftPostingGateActs ?? acts(snapshot, FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY, env);
    if (verdict.action !== 'auto_post' || !enabled) return verdict;
    return suggestionFiresReverseChargeDrift({ taxType: suggestion.tax_type || suggestion.xero_tax_type || '', taxTreatment: suggestion.tax_treatment || '' })
      ? { action: 'owner_ask', reason: 'scope_drift_reverse_charge', blockers: ['scope_drift_reverse_charge'] } : verdict;
  }
});
