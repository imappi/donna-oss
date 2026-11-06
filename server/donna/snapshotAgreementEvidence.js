// Snapshot agreement-evidence wiring — the seam between the firm snapshot
// (documents + transactions, assembled once in getFirmSnapshotFromDb) and the
// read-only agreement evidence CheckReport.
//
// Division of labour (CLAUDE.md trust-the-strong-LLM principle):
//   • The strong LLM already extracted the obligations (contract.js →
//     parse_summary.obligations). That is the intelligence.
//   • buildAgreementEvidenceCheckReport does only deterministic arithmetic over
//     those obligations and the client's transactions.
//   • THIS module is the plumbing: it scopes each agreement document to its own
//     client's bank lines, maps the snapshot transaction shape (money_in /
//     money_out) to the checker's expected shape, supplies the client's own
//     names so the firm's side is never mistaken for the counterparty, and
//     attaches the resulting verdict as `document.evidence_check`.
//
// The verdict is computed ONCE here, on the snapshot read path, so both
// surfaces that render it (the documents-list cue chip and the agreement
// artifact panel's full report) read the SAME attached object — never a
// per-open recompute. It is read-only evidence: it never posts, reconciles, or
// clears. A document that is not a checkable agreement carries no
// `evidence_check` at all (so non-agreement rows stay lean).

import { buildAgreementEvidenceCheckReport, CHECK_REPORT_STATUS } from './agreementEvidenceCheckReport.js';

const numberOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Map a snapshot transaction (rowToTransactionPayload shape: money_in /
// money_out, date, description, plus spread payload fields) to the field names
// buildAgreementEvidenceCheck reads. Amount is compared on absolute value by
// the checker, so the signed money_in − money_out magnitude is correct for
// both incoming deposits and outgoing payments.
const toCheckerTransaction = (tx = {}) => {
  const signed = numberOr(tx.money_in, 0) - numberOr(tx.money_out, 0);
  const amount = signed !== 0 ? signed : numberOr(tx.amount, signed);
  return {
    id: tx.id ?? tx.transaction_id ?? null,
    amount,
    date: tx.date || tx.transaction_date || tx.value_date || null,
    counterparty: tx.counterparty
      || tx.merchant_name
      || tx.payee
      || tx.contact_name
      || tx.cleaned_description
      || tx.description
      || '',
    description: tx.description || tx.cleaned_description || '',
    reference: tx.reference || tx.external_transaction_id || null
  };
};

// The client's own names, so a bank line carrying the firm's-client's own name
// is never taken as the external counterparty of its own agreement.
const ownNamesForClient = (client) => {
  if (!client) return [];
  const names = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) names.push(value.trim());
  };
  push(client.companyName);
  push(client.company_name);
  push(client.name);
  push(client.legalName);
  for (const name of Array.isArray(client.legalNames) ? client.legalNames : []) push(name);
  return names;
};

const isAgreementDocument = (document = {}) =>
  document.document_type === 'contract' || document.parse_summary?.document_type === 'contract';

/**
 * Attach a read-only agreement evidence CheckReport to every checkable
 * agreement document in a firm snapshot.
 *
 * @param {object} input
 * @param {Array}  [input.documents]    - snapshot document payloads
 * @param {Array}  [input.transactions] - snapshot transaction payloads
 * @param {Array}  [input.clients]      - snapshot client payloads (for own-names)
 * @param {object} [input.options]      - passthrough to the checker (now, tolerances, ownNames)
 * @returns {Array} documents, with `evidence_check` attached to agreement docs
 *   that have obligations. Non-agreement docs are returned unchanged.
 */
export const attachAgreementEvidenceChecks = ({
  documents = [],
  transactions = [],
  clients = [],
  options = {}
} = {}) => {
  if (!Array.isArray(documents) || documents.length === 0) return documents;

  // Group raw transactions by client once; map to the checker shape lazily
  // (and memoized) so a firm with many agreements doesn't re-map the same
  // client's lines per document.
  const rawByClient = new Map();
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    const key = tx?.client_id ?? null;
    if (key == null) continue;
    if (!rawByClient.has(key)) rawByClient.set(key, []);
    rawByClient.get(key).push(tx);
  }
  const mappedByClient = new Map();
  const checkerTransactionsFor = (clientId) => {
    if (mappedByClient.has(clientId)) return mappedByClient.get(clientId);
    const mapped = (rawByClient.get(clientId) || []).map(toCheckerTransaction);
    mappedByClient.set(clientId, mapped);
    return mapped;
  };

  const clientById = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    if (client?.id != null) clientById.set(client.id, client);
  }

  return documents.map((document) => {
    if (!document || !isAgreementDocument(document)) return document;
    try {
      const client = clientById.get(document.client_id) || null;
      const report = buildAgreementEvidenceCheckReport({
        document,
        transactions: checkerTransactionsFor(document.client_id),
        options: {
          ...options,
          ownNames: [
            ...(Array.isArray(options.ownNames) ? options.ownNames : []),
            ...ownNamesForClient(client)
          ]
        }
      });
      // A non-agreement (no obligations) is unsupported — leave the document
      // lean rather than stamping an empty verdict on, e.g., an NDA.
      if (report.status === CHECK_REPORT_STATUS.UNSUPPORTED) return document;
      return { ...document, evidence_check: report };
    } catch (error) {
      // Soft-degrade: an evidence-check failure must never break the snapshot
      // read. The document renders without a verdict, exactly as before.
      console.error('[agreementEvidenceCheck] skipped for document', {
        documentId: document.id,
        error: error?.message || String(error)
      });
      return document;
    }
  });
};
