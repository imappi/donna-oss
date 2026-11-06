const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const moneyText = (value) => money(value).toFixed(2);
const dateOnly = (value) => (value ? String(value).slice(0, 10) : null);

const payloadOf = (row = {}) => (row && typeof row.payload === 'object' && row.payload !== null ? row.payload : {});
const firstPresent = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const codingFrom = (journal = {}, source = {}) => {
  const payload = payloadOf(source);
  const journalPayload = payloadOf(journal);
  const verdict = firstPresent(payload.coding, payload.verdict, journalPayload.coding, journalPayload.verdict, {});
  return {
    model: firstPresent(verdict.model, verdict.coding_model, payload.model, journalPayload.model, null),
    confidence: firstPresent(verdict.confidence, verdict.coding_confidence, payload.confidence, journalPayload.confidence, null),
    proposed_by: firstPresent(verdict.proposed_by, verdict.proposedBy, payload.proposed_by, journalPayload.proposed_by, null)
  };
};

const documentRef = (document = {}) => ({
  document_id: document.id || null,
  filename: document.filename || null,
  kind: document.document_type || payloadOf(document).document_type || null
});

const renderMarkdown = (pkg) => {
  const summary = pkg.summary;
  const unresolved = pkg.unresolved;
  const lines = [
    `# Procountor posting package`,
    ``,
    `Client: ${pkg.meta.client_id}`,
    `Period: ${pkg.meta.period_start} to ${pkg.meta.period_end}`,
    `Source: ${pkg.meta.source}`,
    `Destination: ${pkg.meta.destination} (${pkg.meta.level})`,
    ``,
    `## Posting batch`,
    `Journals: ${summary.journals}`,
    `Lines: ${summary.lines}`,
    `Total debits: ${moneyText(summary.total_debits)}`,
    `Total credits: ${moneyText(summary.total_credits)}`,
    `Balanced: ${summary.balanced ? 'yes' : 'NO'}`
  ];
  const unbalanced = pkg.posting_batch.filter((journal) => !journal.balanced);
  if (unbalanced.length) lines.push(`Unbalanced journals: ${unbalanced.map((journal) => journal.journal_id).join(', ')}`);
  const missingEvidence = pkg.posting_batch.filter((journal) => journal.evidence.length === 0);
  lines.push(`Journals without evidence links: ${missingEvidence.length}`);
  lines.push('', '## By account');
  for (const account of summary.by_account) {
    lines.push(`- ${account.account_code || 'uncoded'} ${account.account_name || ''}: debit ${moneyText(account.debit)}, credit ${moneyText(account.credit)}`);
  }
  lines.push('', '## Unresolved');
  lines.push(`- Unposted transactions: ${unresolved.unposted_transactions.length}`);
  lines.push(`- Open owner questions: ${unresolved.open_owner_questions.length}`);
  lines.push(`- Open cases: ${unresolved.open_cases.length}`);
  if (pkg.review_notes.length) {
    lines.push('', '## Review notes');
    for (const note of pkg.review_notes) lines.push(`- ${note}`);
  }
  return `${lines.join('\n')}\n`;
};

export const buildProcountorExportPackage = ({
  clientId,
  periodStart,
  periodEnd,
  journals = [],
  ledgerLines = [],
  transactions = [],
  documents = [],
  evidenceRequests = [],
  closeBlockers = [],
  accounts = [],
  reviewNotes = [],
  generatedAt = new Date().toISOString()
} = {}) => {
  const linesByJournal = new Map();
  for (const line of ledgerLines) {
    if (!line?.journal_id) continue;
    if (!linesByJournal.has(line.journal_id)) linesByJournal.set(line.journal_id, []);
    linesByJournal.get(line.journal_id).push(line);
  }
  const transactionsById = new Map(transactions.map((tx) => [tx.id, tx]));
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const postedSourceIds = new Set();

  const postingBatch = journals.map((journal) => {
    const source = transactionsById.get(journal.source_id) || {};
    if (journal.source_id) postedSourceIds.add(journal.source_id);
    const sortedLines = [...(linesByJournal.get(journal.id) || [])].sort((a, b) => Number(a.line_no || 0) - Number(b.line_no || 0));
    const renderedLines = sortedLines.map((line) => {
      const account = accountsById.get(line.account_id) || {};
      return {
        line_no: Number(line.line_no || 0),
        account_code: firstPresent(line.account_code, account.code, null),
        account_name: firstPresent(line.account_name, account.name, null),
        debit: money(line.debit),
        credit: money(line.credit),
        currency: line.currency || journal.currency || null
      };
    });
    const totalDebit = money(renderedLines.reduce((sum, line) => sum + line.debit, 0));
    const totalCredit = money(renderedLines.reduce((sum, line) => sum + line.credit, 0));
    const evidenceIds = new Set([source.document_id, payloadOf(journal).document_id, payloadOf(source).document_id].filter(Boolean));
    const evidence = [...evidenceIds].map((id) => documentsById.get(id)).filter(Boolean).map(documentRef);
    return {
      journal_id: journal.id,
      journal_date: dateOnly(journal.journal_date),
      description: firstPresent(journal.memo, source.description, payloadOf(journal).description, null),
      source_type: journal.source_type || null,
      source_id: journal.source_id || null,
      lines: renderedLines,
      balanced: Math.abs(totalDebit - totalCredit) < 0.01,
      evidence,
      coding: codingFrom(journal, source)
    };
  });

  const allRenderedLines = postingBatch.flatMap((journal) => journal.lines);
  const totalDebits = money(allRenderedLines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredits = money(allRenderedLines.reduce((sum, line) => sum + line.credit, 0));
  const byAccountMap = new Map();
  for (const line of allRenderedLines) {
    const key = `${line.account_code || ''}|${line.account_name || ''}|${line.currency || ''}`;
    const bucket = byAccountMap.get(key) || { account_code: line.account_code, account_name: line.account_name, currency: line.currency, debit: 0, credit: 0 };
    bucket.debit = money(bucket.debit + line.debit);
    bucket.credit = money(bucket.credit + line.credit);
    byAccountMap.set(key, bucket);
  }
  const pkg = {
    meta: { client_id: clientId, period_start: periodStart, period_end: periodEnd, generated_at: generatedAt, source: 'donna_ledger', destination: 'procountor', level: 'export_only' },
    posting_batch: postingBatch,
    summary: {
      journals: postingBatch.length,
      lines: allRenderedLines.length,
      total_debits: totalDebits,
      total_credits: totalCredits,
      balanced: postingBatch.every((journal) => journal.balanced) && Math.abs(totalDebits - totalCredits) < 0.01,
      journals_without_evidence: postingBatch.filter((journal) => journal.evidence.length === 0).map((journal) => journal.journal_id),
      by_account: [...byAccountMap.values()].sort((a, b) => String(a.account_code || '').localeCompare(String(b.account_code || ''), undefined, { numeric: true }))
    },
    unresolved: {
      unposted_transactions: transactions.filter((tx) => tx?.id && !postedSourceIds.has(tx.id)).map((tx) => ({ transaction_id: tx.id, transaction_date: dateOnly(tx.transaction_date), description: tx.description || null, amount: money(Number(tx.money_in || 0) - Number(tx.money_out || 0)), currency: tx.currency || null, status: tx.status || null })),
      open_owner_questions: evidenceRequests.map((request) => ({ id: request.id, transaction_id: request.transaction_id || null, status: request.status || null, evidence_type: request.evidence_type || null, question: request.question || null, due_at: request.due_at || null })),
      open_cases: closeBlockers
    },
    review_notes: reviewNotes
  };
  return { package: pkg, rendered_summary: renderMarkdown(pkg) };
};
