// Local-source observation for the SG review export, never tax computation or
// filing authority. Every read uses the artifact's existing read-only snapshot.
import { computeConvergenceForTransactions, computeConvergenceForDocuments,
  classifyDocumentRest, DOCUMENT_MATCH_TYPES_LOCKSTEP } from '../reconcileConvergenceState.js';
import { extractPeriodBoundsFromSummary } from '../parseDocumentsDb.js';
import { toIsoDay, toUtcIsoDay } from '../dates.js';

const refuse = message => {
  throw Object.assign(new Error(message), { code: 'SINGAPORE_GST_SOURCE_READ_INCOMPLETE', statusCode: 409 });
};
const rowsFrom = result => {
  if (!Array.isArray(result?.rows)) refuse('Local source information could not be read completely.');
  return result.rows;
};
const day = value => {
  const text = toIsoDay(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && toUtcIsoDay(text) === text ? text : null;
};
const interval = (start, end, basis) => {
  const first = day(start), last = day(end);
  return first && last && first <= last ? { starts_on: first, ends_on: last, basis } : null;
};
const membership = (dates, period) => !dates ? 'period_unknown'
  : dates.starts_on <= period.ends_on && dates.ends_on >= period.starts_on ? 'in_period' : 'out_of_period';
const contains = (outer, inner) => outer.starts_on <= inner.starts_on && outer.ends_on >= inner.ends_on;
const statementHeaderDates = row => {
  // Both existing payload homes are supported by the shared source reader.
  // Display labels can originate from a filename or transaction min/max.
  const headers = [row.payload?.statement_summary, row.payload?.statementSummary]
    .filter(value => value != null);
  if (!headers.length) return null;
  const dates = headers.map(header => header && typeof header === 'object' && !Array.isArray(header)
    ? interval(header.period_start, header.period_end, 'persisted_statement_header') : null);
  if (dates.some(value => !value) || dates.some(value =>
    value.starts_on !== dates[0].starts_on || value.ends_on !== dates[0].ends_on)) return null;
  return dates[0];
};
const documentDates = row => {
  const summary = row.parse_summary || {};
  const declared = ['period_start_date', 'period_end_date', 'statement_period']
    .some(key => summary[key] != null && summary[key] !== '');
  if (!declared && row.document_type !== 'bank_statement') {
    return interval(row.document_date, row.document_date, 'document_date');
  }
  const hasBounds = summary.period_start_date != null || summary.period_end_date != null;
  const bounds = hasBounds ? interval(summary.period_start_date, summary.period_end_date, 'parse_summary_statement_interval') : null;
  const hasLabel = summary.statement_period != null && summary.statement_period !== '';
  const parsedLabel = hasLabel ? extractPeriodBoundsFromSummary({ statement_period: summary.statement_period }) : null;
  const label = parsedLabel ? interval(parsedLabel.start, parsedLabel.end, 'parse_summary_statement_period') : null;
  if ((hasBounds && !bounds) || (hasLabel && !label)) return null;
  if (row.document_type === 'bank_statement') {
    const header = statementHeaderDates(row);
    if (!header || (bounds && !contains(header, bounds)) || (label && !contains(header, label))) return null;
    return header;
  }
  if (bounds && label && (bounds.starts_on < label.starts_on || bounds.ends_on > label.ends_on)) return null;
  return label || bounds;
};
const describe = (row, dates, period, convergence) => ({
  id: row.id, period_scope: membership(dates, period), dates,
  status: row.status, convergence: convergence.derived,
  persisted_convergence: convergence.persisted
});
const convergenceMap = (rows, sources, clientId) => {
  const map = new Map();
  for (const row of rows) {
    if (row.client_id !== clientId || map.has(row.target_id)) refuse('Local source identity could not be verified.');
    map.set(row.target_id, row);
  }
  if (map.size !== sources.length || sources.some(row => !map.has(row.id))) {
    refuse('Some local source states could not be read.');
  }
  return map;
};

export const readSingaporeGstSourceReadiness = async ({ client, firmId, clientId, period, readAt }) => {
  const now = Date.parse(readAt);
  if (!Number.isFinite(now)) refuse('A valid observation time is required for local sources.');
  const scope = [firmId, clientId];
  const documents = rowsFrom(await client.query(
    `select id, firm_id, client_id, filename, document_type, document_date,
            status, parse_status, parse_summary, parse_error, duplicate_of, total_amount, payload
       from documents where firm_id = $1 and client_id = $2 order by id`, scope));
  const transactions = rowsFrom(await client.query(
    `select id, firm_id, client_id, document_id, transaction_date, status, coding_state
       from transactions where firm_id = $1 and client_id = $2 order by id`, scope));
  const matches = rowsFrom(await client.query(
    `select id, firm_id, client_id, bank_transaction_id, matched_object_id, matched_object_type,
            matched_line_id, status
       from reconciliation_matches where firm_id = $1 and client_id = $2
        and status in ('suggested', 'auto_matched', 'confirmed') order by id`, scope));
  const journals = rowsFrom(await client.query(
    `select id, firm_id, client_id, source_type, source_id from ledger_journals
      where firm_id = $1 and client_id = $2 and status in ('posted', 'closed')
        and source_type in ('transaction', 'document_settlement') order by id`, scope));
  for (const row of [...documents, ...transactions, ...matches, ...journals]) {
    if (!row.id || row.firm_id !== firmId || row.client_id !== clientId) refuse('Local source identity could not be verified.');
  }
  const txById = new Map(transactions.map(row => [row.id, row]));
  const docById = new Map(documents.map(row => [row.id, row]));
  for (const row of documents) {
    if (row.duplicate_of && !docById.has(row.duplicate_of)) refuse('A canonical local source is missing from this client.');
    if (row.parse_summary != null && (typeof row.parse_summary !== 'object' || Array.isArray(row.parse_summary))) {
      refuse('A local source has an unsupported period record.');
    }
  }
  const documentMatches = matches.filter(row => DOCUMENT_MATCH_TYPES_LOCKSTEP.includes(row.matched_object_type));
  for (const row of documentMatches) {
    if (!txById.has(row.bank_transaction_id) || !docById.has(row.matched_object_id)) {
      refuse('A linked local source is missing from this client.');
    }
  }
  for (const row of transactions) {
    if (row.document_id && !docById.has(row.document_id)) refuse('An imported transaction source is missing from this client.');
  }
  const txStates = convergenceMap(await computeConvergenceForTransactions(client, {
    firmId, transactionIds: transactions.map(row => row.id)
  }), transactions, clientId);
  const docStates = convergenceMap(await computeConvergenceForDocuments(client, {
    firmId, documentIds: documents.map(row => row.id), now
  }), documents, clientId);
  const posted = (type, id) => journals.filter(row => row.source_type === type && row.source_id === id).map(row => row.id);
  const sourceItems = [];
  const transactionItems = transactions.map(row => {
    const dates = interval(row.transaction_date, row.transaction_date, 'transaction_date');
    const state = txStates.get(row.id);
    const journalIds = posted('transaction', row.id);
    const reasons = [];
    if (!dates) reasons.push('period_unknown');
    if (!journalIds.length) reasons.push('transaction_unposted');
    if (state.derived?.state !== 'auto_reconciled') reasons.push('transaction_unfinished');
    return { ...describe(row, dates, period, state), document_id: row.document_id,
      coding_state: row.coding_state, posted_journal_ids: journalIds, reasons,
      matched_document_ids: [...new Set(documentMatches.filter(m => m.bank_transaction_id === row.id).map(m => m.matched_object_id))] };
  });
  const txItemsById = new Map(transactionItems.map(row => [row.id, row]));
  for (const row of documents) {
    const imported = transactions.filter(tx => tx.document_id === row.id);
    const linked = documentMatches.filter(match => match.matched_object_id === row.id);
    const state = docStates.get(row.id);
    const rest = classifyDocumentRest(row, { liveMatches: linked, now });
    const dates = documentDates(row);
    const activityDays = imported.map(tx => day(tx.transaction_date)).filter(Boolean).sort();
    const observedActivity = activityDays.length
      ? interval(activityDays[0], activityDays.at(-1), 'imported_transaction_dates_not_coverage') : null;
    const reasons = [];
    const journalIds = posted('document_settlement', row.id);
    if (rest.kind !== 'collapsed') {
      if (!dates) reasons.push('period_unknown');
      if (['pending', 'processing'].includes(row.parse_status)) reasons.push('source_processing');
      else if (row.parse_status === 'failed') reasons.push('source_failed');
      else if (row.parse_status === 'duplicate_pending') reasons.push('duplicate_unresolved');
      else if (!['completed', 'skipped'].includes(row.parse_status)) reasons.push('source_state_unknown');
      else if (row.document_type === 'bank_statement') {
        if (row.parse_status !== 'completed' || !imported.length) reasons.push('statement_import_unverified');
      } else if (linked.length) {
        // A match delegates work to its EXACT bank row, never settles accounting.
        if (linked.some(m => txItemsById.get(m.bank_transaction_id).reasons.length)) reasons.push('linked_transactions_unfinished');
        if (state.derived && state.derived.state !== 'auto_reconciled') reasons.push('document_unfinished');
      } else if (state.derived?.state !== 'auto_reconciled') {
        if (!journalIds.length) reasons.push('document_unposted');
        reasons.push(state.derived ? 'document_unfinished' : 'source_state_unknown');
      }
    }
    sourceItems.push({ ...describe(row, dates, period, state), filename: row.filename,
      document_type: row.document_type, parse_status: row.parse_status,
      parse_error_code: row.parse_error?.code ?? null, lifecycle_kind: rest.kind,
      duplicate_of: row.duplicate_of, imported_transaction_ids: imported.map(tx => tx.id),
      observed_activity_dates: observedActivity,
      parsed_activity_dates: row.document_type === 'bank_statement'
        ? interval(row.parse_summary?.period_start_date, row.parse_summary?.period_end_date, 'parser_transaction_bounds_not_coverage') : null,
      matched_transaction_ids: [...new Set(linked.map(m => m.bank_transaction_id))],
      posted_journal_ids: journalIds, reasons });
  }
  const relevantSources = sourceItems.filter(row => row.period_scope !== 'out_of_period' && row.lifecycle_kind !== 'collapsed');
  const relevantTransactions = transactionItems.filter(row => row.period_scope !== 'out_of_period');
  const concerns = [];
  const sourceOwnedTransactions = new Set();
  for (const source of relevantSources) {
    if (!source.reasons.length) continue;
    const sourceFailure = source.reasons.some(reason => ['source_processing', 'source_failed', 'duplicate_unresolved', 'source_state_unknown'].includes(reason));
    const related = [...new Set([...source.imported_transaction_ids, ...source.matched_transaction_ids])];
    // Only deduplicate a document's linked-work-only concern when the bank
    // row is itself in this period. Otherwise retain the document and link.
    if (source.reasons.length === 1 && source.reasons[0] === 'linked_transactions_unfinished'
      && related.every(id => relevantTransactions.some(tx => tx.id === id))) continue;
    if (sourceFailure) for (const id of related) sourceOwnedTransactions.add(id);
    concerns.push({ target_type: 'document', target_id: source.id, reasons: source.reasons,
      period_scope: source.period_scope, related_transaction_ids: related });
  }
  for (const tx of relevantTransactions) {
    if (tx.reasons.length && !sourceOwnedTransactions.has(tx.id)) concerns.push({
      target_type: 'transaction', target_id: tx.id, reasons: tx.reasons,
      period_scope: tx.period_scope, source_document_id: tx.document_id,
      matched_document_ids: tx.matched_document_ids
    });
  }
  return {
    status: concerns.length ? 'needs_review' : 'no_unfinished_local_sources',
    observation: !relevantSources.length && !relevantTransactions.length ? 'no_local_sources' : 'local_sources_observed',
    as_of: readAt, period, scope: 'persisted_client_local_sources_only',
    assumptions: [
      'Dates come from persisted source dates and parser intervals, never filenames or upload times.',
      'A source with an unknown period is uncertainty for this requested period; it is not assigned to it.',
      'Observed transaction date bounds do not prove full statement coverage.',
      'No unfinished local sources does not prove all evidence was supplied or establish filing qualification.'
    ],
    documents: relevantSources, transactions: relevantTransactions, concerns,
    excluded_documents: sourceItems.filter(row => !relevantSources.includes(row)).map(row => ({
      id: row.id, reason: row.lifecycle_kind === 'collapsed' ? 'collapsed_duplicate' : 'out_of_period',
      dates: row.dates, duplicate_of: row.duplicate_of
    })),
    excluded_transaction_ids: transactionItems.filter(row => row.period_scope === 'out_of_period').map(row => row.id)
  };
};
