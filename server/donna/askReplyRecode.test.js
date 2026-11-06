// Reply-driven re-code (the ask-pipeline's clear half) — drives the
// REAL seam through the mock pg client. Pins:
//   1. the coder receives the reply context: original question, the
//      client's reply, reply docs, and the prior verdict labeled as the
//      model's own unconfirmed suggestion
//   2. apply path (high confidence, no evidence needed): transaction
//      applied + accepted, open evidence requests on the line resolved
//   3. follow-up path (model keeps it open): new suggested verdict
//      persisted, queue back to 'suggested' (not 'waiting'), evidence
//      request NOT resolved
//   4. rules_fallback can never write — the deterministic template must
//      not overwrite a strong verdict
//   5. the apply gate vocabulary
//
// NOTE: mock-pinned SQL shapes only — the resolve→recode path is also
// exercised against scratch Postgres before prod validation.

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';

import {
  __attachReplyContextToBatchPool,
  __linkReplyEvidenceMatchesInDb,
  __recodeTransactionAfterClientReplyWithClient,
  __resumeEvidenceRecodeAfterParseWithClient,
  __shouldApplyReplyRecode,
  __shouldResumeFromClientReply
} from './firmDb.js';

const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return { rows: [] };
      }
      if (text.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [CLIENT_ROW] };
      if (text.includes('select coding_state, transaction_date, payload from transactions')) return { rows: [TX_ROW] };
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        return { rows: response.rows || [] };
      }
      return { rows: [] };
    }
  };
};

const TX_ROW = {
  id: 'tx-owner-1',
  client_id: 'client-1',
  transaction_date: '2025-08-25',
  description: 'OWNER DISTRIBUTION 6881134',
  money_in: 0,
  money_out: 3806.4,
  currency: 'USD',
  status: 'needs_review',
  payload: {
    ai_suggestion: {
      proposed_account: 'Owner drawings',
      confidence: 'high',
      reasoning: 'Recognized owner distribution.',
      ask_client_question: 'Is this a member draw?'
    },
    ai_suggestion_status: 'suggested',
    evidence_request: { id: 'evr-1', status: 'open' }
  }
};

const CLIENT_ROW = { id: 'client-1', company_name: 'Honeybee Hills Apiary', jurisdiction: 'US', profile: {} };

const EVIDENCE_REQUEST = { id: 'evr-1', question: 'Is this a member/owner draw/distribution?' };

const cannedTx = (rows) => ({ match: 'from transactions', rows });
const cannedClient = (rows) => ({ match: 'from clients', rows });

const APPLY_SUGGESTION = {
  source: 'openai',
  model: 'gpt-5.4',
  proposed_account: 'Owner drawings',
  contact: '',
  tax_treatment: 'No sales tax',
  coding_policy: codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'us', businessDate: TX_ROW.transaction_date })),
  support_note: 'Client confirmed member draw.',
  ask_client_question: '',
  evidence_required: false,
  remember_candidate: false,
  merchant_pattern: '',
  auto_explain_limit: 0,
  confidence: 'high',
  materiality: 'high',
  reasoning: 'Client reply confirms the owner distribution.',
  warnings: [],
  alternatives: []
};

await test('apply path: reply context reaches the coder; line applied + accepted; open asks resolved', async () => {
  const client = makeMockClient([
    cannedTx([TX_ROW]),
    cannedClient([CLIENT_ROW]),
    // RT-16: the coding transition's locked read of the line's current state.
    cannedTx([{ coding_state: 'asked' }])
  ]);

  let coderInput = null;
  const result = await __recodeTransactionAfterClientReplyWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-owner-1',
    evidenceRequest: EVIDENCE_REQUEST,
    reply: 'Yes — that is my quarterly draw.',
    actorId: 'kari@books.example',
    suggestFn: async ({ transaction }) => {
      coderInput = transaction;
      return APPLY_SUGGESTION;
    }
  });

  // 1 — the coder saw the reply, the question, and the labeled prior verdict.
  assert.equal(coderInput.client_reply_context.client_reply, 'Yes — that is my quarterly draw.');
  assert.equal(coderInput.client_reply_context.question_asked, EVIDENCE_REQUEST.question);
  assert.equal(coderInput.client_reply_context.prior_verdict.proposed_account, 'Owner drawings');
  assert.equal(coderInput.client_reply_context.prior_verdict.provenance, 'machine_suggestion_unconfirmed');

  // 2 — applied: account on the line, payload carries the applied verdict.
  assert.equal(result.applied, true);
  const txUpdate = client.calls.find((c) => c.sql.includes('set account_code'));
  assert.ok(txUpdate, 'transaction applied');
  assert.equal(txUpdate.params[2], 'Owner drawings');
  const txPatch = JSON.parse(txUpdate.params[4]);
  assert.equal(txPatch.ai_suggestion_status, 'auto_applied');
  assert.equal(txPatch.ai_suggestion_applied_via, 'client_reply');
  assert.equal(txPatch.review_state, undefined, 'RT-16: no legacy label in the payload');
  assert.equal(txPatch.evidence_request.status, 'resolved');
  // RT-16: the ONE coding state moves asked → applied through the machine.
  const transition = client.calls.find((c) => c.sql.includes('set coding_state = $3'));
  assert.ok(transition, 'coding_state transition written');
  assert.equal(transition.params[2], 'applied');
  assert.equal(txPatch.ai_suggestion.recoded_from_reply, true);
  assert.equal(txPatch.ai_suggestion.evidence_request_id, 'evr-1');

  const queueUpdate = client.calls.find((c) => c.sql.includes('update transaction_review_queue') && c.sql.includes('payload = payload ||'));
  assert.ok(queueUpdate, 'queue case file updated');
  const queuePatch = JSON.parse(queueUpdate.params[3]);
  assert.equal(queuePatch.ai_suggestion_status, 'auto_applied', 'the applied receipt rides the case file');
  assert.equal(queuePatch.review_state, undefined, 'RT-16: the case file carries no coding state');

  // Open evidence requests on the line resolve — ASKED cannot outlive its answer.
  const evidenceResolve = client.calls.find(
    (c) => c.sql.includes('client_evidence_requests') && c.sql.includes("set status = 'resolved'")
  );
  assert.ok(evidenceResolve, 'open evidence requests resolved');

  const audit = client.calls.find((c) => c.sql.includes('transaction.reply_recode'));
  assert.ok(audit, 'recode audit emitted');
  assert.equal(JSON.parse(audit.params[4]).applied, true);
});

await test('content path: the coder receives the uploaded document\'s CONTENT, not just its filename', async () => {
  // Regression guard for the Shopify-payout bug: a client who answers
  // "send the payout report" by uploading the file with NO text note must
  // give the coder the report's numbers (total, currency, line items), or the
  // model says "the client reply field is blank" and keeps the line ASKED.
  const client = makeMockClient([
    cannedTx([TX_ROW]),
    cannedClient([CLIENT_ROW]),
    // The own-account roster gather (also selects from documents) must match
    // its own canned entry FIRST or it eats the reply-document response below.
    { match: 'statement_summary', rows: [] },
    {
      match: 'from documents',
      rows: [{
        id: 'doc-payout',
        filename: 'shopify-payout-889512.pdf',
        document_type: 'payout_report',
        vendor_name: 'Shopify',
        customer_name: null,
        total_amount: '2283.87',
        currency: 'USD',
        document_date: '2025-06-12'
      }]
    },
    {
      match: 'from document_lines',
      rows: [{ document_id: 'doc-payout', description: 'Gross sales', amount: '2400.00', line_no: 1 }]
    }
  ]);

  let coderInput = null;
  await __recodeTransactionAfterClientReplyWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-owner-1',
    evidenceRequest: EVIDENCE_REQUEST,
    reply: '', // document-only reply — the exact case that used to strand the line
    replyDocumentIds: ['doc-payout'],
    suggestFn: async ({ transaction }) => {
      coderInput = transaction;
      return APPLY_SUGGESTION;
    }
  });

  const doc = coderInput.client_reply_context.reply_documents[0];
  assert.equal(doc.filename, 'shopify-payout-889512.pdf');
  assert.equal(doc.total_amount, 2283.87, 'total reaches the coder');
  assert.equal(doc.currency, 'USD');
  assert.equal(doc.vendor_name, 'Shopify');
  assert.equal(doc.document_date, '2025-06-12');
  assert.equal(doc.lines[0].description, 'Gross sales', 'line items reach the coder');
  assert.equal(doc.lines[0].amount, 2400);
});

await test('apply path with a document: an auto_matched evidence match links the bank line → the uploaded doc', async () => {
  // The artifact-polish fix: a reply-recode that APPLIES on an uploaded
  // document also creates a reconciliation_match (auto_matched/system)
  // linking the bank line → that document, so the artifact renders the rich
  // "Matched to <vendor> <type> (<amount>)" branch instead of the bare
  // coding-verdict dump. State link, not a model call.
  const client = makeMockClient([
    cannedTx([TX_ROW]),
    cannedClient([CLIENT_ROW]),
    { match: 'statement_summary', rows: [] },
    {
      match: 'from documents',
      rows: [{
        id: 'doc-payout',
        filename: 'shopify-payout-889512.pdf',
        document_type: 'payout_report',
        vendor_name: 'Shopify',
        customer_name: null,
        total_amount: '2283.87',
        currency: 'USD',
        document_date: '2025-06-12'
      }]
    },
    { match: 'from document_lines', rows: [] },
    { match: 'insert into reconciliation_matches', rows: [{ id: 'recon-auto-1' }] }
  ]);

  const result = await __recodeTransactionAfterClientReplyWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-owner-1',
    evidenceRequest: EVIDENCE_REQUEST,
    reply: '', // document-only reply — the Shopify-payout case
    replyDocumentIds: ['doc-payout'],
    suggestFn: async () => APPLY_SUGGESTION
  });

  assert.equal(result.applied, true);
  const matchInsert = client.calls.find((c) => c.sql.includes('insert into reconciliation_matches'));
  assert.ok(matchInsert, 'a reconciliation_matches row is inserted on apply');
  assert.ok(matchInsert.sql.includes("'auto_matched', 'system'"), 'status=auto_matched, created_by=system');
  assert.ok(matchInsert.sql.includes('on conflict'), 'idempotent insert (ON CONFLICT DO NOTHING)');
  // params: id, firm, client, bank_tx, matched_object_type, matched_object_id, amount, confidence, reason, payload
  assert.equal(matchInsert.params[3], 'tx-owner-1', 'linked to the bank transaction');
  assert.equal(matchInsert.params[4], 'payout_report', 'matched_object_type = the document type');
  assert.equal(matchInsert.params[5], 'doc-payout', 'matched_object_id = the uploaded document');
  assert.equal(matchInsert.params[6], 2283.87, 'match_amount = the document total');

  const auditLink = client.calls.find((c) => c.sql.includes('reconciliation_match.auto_link'));
  assert.ok(auditLink, 'auto-link audit emitted on create');
});

await test('apply path without a document: no evidence match is created', async () => {
  const client = makeMockClient([cannedTx([TX_ROW]), cannedClient([CLIENT_ROW])]);
  const result = await __recodeTransactionAfterClientReplyWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-owner-1',
    evidenceRequest: EVIDENCE_REQUEST,
    reply: 'Yes — quarterly draw.', // text-only reply, no upload
    suggestFn: async () => APPLY_SUGGESTION
  });
  assert.equal(result.applied, true);
  assert.ok(
    !client.calls.some((c) => c.sql.includes('insert into reconciliation_matches')),
    'a text-only reply applies without inventing a document match'
  );
});

await test('auto-link writer: idempotent (conflict → silent no-op) and a certain (1.0) client-evidence link', async () => {
  // create path — a document with a total inserts and audits.
  const inserted = makeMockClient([{ match: 'insert into reconciliation_matches', rows: [{ id: 'recon-1' }] }]);
  const created = await __linkReplyEvidenceMatchesInDb({
    client: inserted,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-1',
    replyDocuments: [{ id: 'doc-1', document_type: 'payout_report', total_amount: 2283.87, vendor_name: 'Shopify' }],
    evidenceRequestId: 'evr-1'
  });
  assert.equal(created.created, 1);
  // The returned id is the helper's own deterministic recon-… id (mirrors the
  // makeMatchId convention), not the row the mock echoed back.
  assert.equal(created.matchIds.length, 1);
  assert.match(created.matchIds[0], /^recon-/);
  const ins = inserted.calls.find((c) => c.sql.includes('insert into reconciliation_matches'));
  assert.equal(ins.params[7], 1, 'client asked + client provided = a certain match (100%)');
  assert.equal(ins.params[6], 2283.87, 'match_amount = the document total when extracted');
  assert.ok(inserted.calls.some((c) => c.sql.includes('reconciliation_match.auto_link')), 'audit on create');

  // conflict path — the unique constraint already holds a row, so the insert
  // returns nothing (ON CONFLICT DO NOTHING) and nothing else runs.
  const conflicted = makeMockClient([]); // unmatched insert → mock returns { rows: [] }
  const noop = await __linkReplyEvidenceMatchesInDb({
    client: conflicted,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-1',
    replyDocuments: [{ id: 'doc-1', document_type: 'payout_report', total_amount: 2283.87 }]
  });
  assert.equal(noop.created, 0, 'a conflict (already linked) is a silent no-op');
  assert.ok(!conflicted.calls.some((c) => c.sql.includes('reconciliation_match.auto_link')), 'no audit on conflict');

  // no documents → no work, no queries.
  const empty = makeMockClient([]);
  const none = await __linkReplyEvidenceMatchesInDb({
    client: empty, firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-1', replyDocuments: []
  });
  assert.equal(none.created, 0);
  assert.equal(empty.calls.length, 0, 'no docs → no queries issued');

  // a bare note (no extracted total) — same certain confidence; the bank
  // line's amount stands in for match_amount via fallbackAmount.
  const note = makeMockClient([{ match: 'insert into reconciliation_matches', rows: [{ id: 'recon-2' }] }]);
  await __linkReplyEvidenceMatchesInDb({
    client: note,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-1',
    replyDocuments: [{ id: 'doc-note', document_type: 'unknown' }],
    fallbackAmount: 2283.87
  });
  const noteIns = note.calls.find((c) => c.sql.includes('insert into reconciliation_matches'));
  assert.equal(noteIns.params[7], 1, 'client-evidence link is certain regardless of extraction');
  assert.equal(noteIns.params[6], 2283.87, 'match_amount falls back to the bank line amount');
  assert.equal(noteIns.params[4], 'unknown', 'matched_object_type falls back to the document type');
});

await test('follow-up path: model keeps the line open — suggested verdict, no resolve, queue leaves waiting', async () => {
  const client = makeMockClient([
    cannedTx([TX_ROW]),
    cannedClient([CLIENT_ROW]),
    cannedTx([{ coding_state: 'asked' }])
  ]);
  const result = await __recodeTransactionAfterClientReplyWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-owner-1',
    evidenceRequest: EVIDENCE_REQUEST,
    reply: 'Not sure, my partner handles that account.',
    suggestFn: async () => ({
      ...APPLY_SUGGESTION,
      proposed_account: 'Suspense',
      confidence: 'low',
      evidence_required: true,
      ask_client_question: 'Could you ask your partner whether the 6881134 transfer was a draw to a member account?'
    })
  });

  assert.equal(result.applied, false);
  assert.ok(!client.calls.some((c) => c.sql.includes('set account_code')), 'no apply update');
  assert.ok(
    !client.calls.some((c) => c.sql.includes('client_evidence_requests') && c.sql.includes("set status = 'resolved'")),
    'evidence request stays replied'
  );
  const txUpdate = client.calls.find((c) => c.sql.includes('update transactions') && c.sql.includes('payload = payload ||'));
  const patch = JSON.parse(txUpdate.params[2]);
  assert.equal(patch.ai_suggestion_status, undefined, 'RT-16: "suggested" is not a receipt');
  assert.equal(patch.review_state, undefined, 'RT-16: no legacy label in the payload');
  assert.match(patch.ai_suggestion.ask_client_question, /partner/);
  // RT-16: the line re-opens as a fresh proposal (asked → proposed).
  const transition = client.calls.find((c) => c.sql.includes('set coding_state = $3'));
  assert.ok(transition, 'coding_state transition written');
  assert.equal(transition.params[2], 'proposed');
  const audit = client.calls.find((c) => c.sql.includes('transaction.reply_recode'));
  assert.match(JSON.parse(audit.params[4]).follow_up_question, /partner/);
});

await test('rules_fallback never writes — deterministic template must not overwrite a verdict', async () => {
  const client = makeMockClient([
    cannedTx([TX_ROW]),
    cannedClient([CLIENT_ROW])
  ]);
  const result = await __recodeTransactionAfterClientReplyWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-owner-1',
    evidenceRequest: EVIDENCE_REQUEST,
    reply: 'Yes.',
    suggestFn: async () => ({ ...APPLY_SUGGESTION, source: 'rules_fallback' })
  });
  assert.equal(result.applied, false);
  assert.equal(result.skipped, 'llm_unavailable');
  assert.ok(!client.calls.some((c) => c.sql.includes('update transactions')), 'no transaction write');
  assert.ok(!client.calls.some((c) => c.sql.trim().toLowerCase() === 'begin'), 'no write transaction opened');
});

await test('missing transaction → honest skip, no writes', async () => {
  const client = makeMockClient([cannedTx([])]);
  const result = await __recodeTransactionAfterClientReplyWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-gone',
    evidenceRequest: EVIDENCE_REQUEST,
    reply: 'Yes.',
    suggestFn: async () => APPLY_SUGGESTION
  });
  assert.equal(result.skipped, 'transaction_not_found');
});

// The resume gate: a document-only reply (the natural answer to "send the
// payout report") MUST resume the line. The old text-only gate stranded it —
// the report attached to the evidence request but nothing re-ran, leaving the
// line at ASKED. This pins that a document with no text resumes, while an
// empty resolution does not.
await test('resume gate: text, a document, or both resume — a document-only reply is never stranded', () => {
  assert.equal(__shouldResumeFromClientReply({ reply: 'Yes, that was rent.', documentIds: [] }), true,
    'a text reply resumes');
  assert.equal(__shouldResumeFromClientReply({ reply: '', documentIds: ['doc-payout'] }), true,
    'a document-only reply resumes (the asked-for case that used to be stranded)');
  assert.equal(__shouldResumeFromClientReply({ reply: '   ', documentIds: ['doc-payout'] }), true,
    'blank text + a document still resumes');
  assert.equal(__shouldResumeFromClientReply({ reply: '', documentIds: [] }), false,
    'an empty resolution (no text, no document) does not resume');
  assert.equal(__shouldResumeFromClientReply({ reply: '', documentIds: [null, ''] }), false,
    'blank/empty document ids do not count as content');
  assert.equal(__shouldResumeFromClientReply(), false, 'no args → no resume');
});

await test('apply gate vocabulary', () => {
  assert.equal(__shouldApplyReplyRecode(APPLY_SUGGESTION), true);
  assert.equal(__shouldApplyReplyRecode({ ...APPLY_SUGGESTION, confidence: 'medium' }), false);
  assert.equal(__shouldApplyReplyRecode({ ...APPLY_SUGGESTION, evidence_required: true }), false);
  assert.equal(__shouldApplyReplyRecode({ ...APPLY_SUGGESTION, proposed_account: 'Suspense' }), false);
  assert.equal(__shouldApplyReplyRecode({ ...APPLY_SUGGESTION, source: 'rules_fallback' }), false);
  assert.equal(
    __shouldApplyReplyRecode({ ...APPLY_SUGGESTION, missing_account: { name: 'Share capital' } }),
    false,
    'a missing-account verdict never applies, even reply-confirmed'
  );
  assert.equal(__shouldApplyReplyRecode(null), false);
});

// ── evidence-reply recode RESUME after the uploaded doc finishes parsing ──────
// The "Shopify settlement" bug: the synchronous reply-recode fires before the
// async parse finished (no content → no apply → line stranded). This hook re-runs
// the recode once the doc is parsed. These pin the with-client core: it only fires
// for an evidence-linked doc on a REPLIED request whose line is NOT yet settled,
// and it hands the parsed reply docs + reply text to the recoder.

const cannedDoc = (rows) => ({ match: 'from documents', rows });
const cannedReq = (rows) => ({ match: 'from client_evidence_requests', rows });
const cannedTxState = (rows) => ({ match: 'from transactions', rows });

const EVIDENCE_DOC_ROW = {
  id: 'doc-shopify-payout',
  client_id: 'client-1',
  evidence_request_id: 'evr-shopify',
  transaction_id: 'tx-shopify-deposit',
  source: 'client_evidence_reply'
};
const REPLIED_REQUEST_ROW = {
  id: 'evr-shopify',
  status: 'replied',
  transaction_id: 'tx-shopify-deposit',
  question: 'Please upload the Shopify payout/settlement report for this deposit.',
  response_payload: { reply: 'Settlement attached.', document_ids: ['doc-shopify-payout'] }
};
const UNSETTLED_TX_STATE = [{ id: 'tx-shopify-deposit', reconciliation_status: null, coding_state: 'asked' }];

await test('resume: a parsed evidence doc on a REPLIED unsettled line re-runs the recode with the doc + reply', async () => {
  const client = makeMockClient([
    cannedDoc([EVIDENCE_DOC_ROW]),
    cannedReq([REPLIED_REQUEST_ROW]),
    cannedTxState(UNSETTLED_TX_STATE)
  ]);
  let recodeArgs = null;
  const result = await __resumeEvidenceRecodeAfterParseWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-shopify-payout',
    recodeFn: async (args) => { recodeArgs = args; return { applied: true }; }
  });
  assert.equal(result.applied, true);
  assert.equal(result.transactionId, 'tx-shopify-deposit');
  assert.equal(result.clientId, 'client-1');
  // The recoder got the parsed reply doc(s) + the reply text + the request.
  assert.deepEqual(recodeArgs.replyDocumentIds, ['doc-shopify-payout']);
  assert.equal(recodeArgs.reply, 'Settlement attached.');
  assert.equal(recodeArgs.transactionId, 'tx-shopify-deposit');
  assert.equal(recodeArgs.evidenceRequest.id, 'evr-shopify');
});

await test('resume: a line the synchronous recode already settled is left untouched (idempotent)', async () => {
  for (const settled of [
    { coding_state: 'applied' },
    { reconciliation_status: 'explained' },
    { coding_state: 'posted' }
  ]) {
    const client = makeMockClient([
      cannedDoc([EVIDENCE_DOC_ROW]),
      cannedReq([REPLIED_REQUEST_ROW]),
      cannedTxState([{ id: 'tx-shopify-deposit', reconciliation_status: null, coding_state: null, ...settled }])
    ]);
    let called = false;
    const result = await __resumeEvidenceRecodeAfterParseWithClient({
      client, firmId: 'firm-1', documentId: 'doc-shopify-payout',
      recodeFn: async () => { called = true; return { applied: true }; }
    });
    assert.equal(result.applied, false);
    assert.equal(result.skipped, 'already_settled');
    assert.equal(called, false, 'the recoder must not run for an already-settled line');
  }
});

await test('resume: no-op for a non-evidence doc and for a not-yet-replied request', async () => {
  // A plain upload (no evidence linkage) is skipped.
  const plain = makeMockClient([cannedDoc([{ id: 'd2', client_id: 'client-1', evidence_request_id: null, transaction_id: null }])]);
  let calledA = false;
  const a = await __resumeEvidenceRecodeAfterParseWithClient({
    client: plain, firmId: 'firm-1', documentId: 'd2', recodeFn: async () => { calledA = true; return { applied: true }; }
  });
  assert.equal(a.skipped, 'not_evidence_linked');
  assert.equal(calledA, false);

  // An unanswered/open request (no client reply yet) is skipped.
  const open = makeMockClient([
    cannedDoc([EVIDENCE_DOC_ROW]),
    cannedReq([{ ...REPLIED_REQUEST_ROW, status: 'open' }])
  ]);
  let calledB = false;
  const b = await __resumeEvidenceRecodeAfterParseWithClient({
    client: open, firmId: 'firm-1', documentId: 'doc-shopify-payout', recodeFn: async () => { calledB = true; return { applied: true }; }
  });
  assert.equal(b.skipped, 'request_status:open');
  assert.equal(calledB, false);
});

// ── reply-aware batch pool ────────────────────────────────────────────

const POOL_TXS = [
  { id: 'tx-open-ask', description: 'CHECK 3851', ai_suggestion: { proposed_account: 'Suspense' } },
  {
    id: 'tx-replied',
    description: 'OWNER DISTRIBUTION 6881134',
    ai_suggestion: { proposed_account: 'Owner drawings', confidence: 'high', reasoning: 'Recognized owner distribution.' }
  },
  { id: 'tx-plain', description: 'POS PURCHASE' },
  { id: 'tx-replied-empty', description: 'BRANCH DEPOSIT' }
];

await test('batch pool: open asks skipped, replied asks carry the reply context, plain lines pass through', async () => {
  const client = makeMockClient([
    {
      match: 'from client_evidence_requests',
      rows: [
        { id: 'evr-open', transaction_id: 'tx-open-ask', status: 'open', question: 'Who was it paid to?', response_payload: {} },
        {
          id: 'evr-replied',
          transaction_id: 'tx-replied',
          status: 'replied',
          question: 'Is this a member draw?',
          response_payload: { reply: 'Yes — quarterly draw.', document_ids: ['doc-note'] }
        },
        { id: 'evr-empty', transaction_id: 'tx-replied-empty', status: 'replied', question: 'Source?', response_payload: {} }
      ]
    },
    { match: 'from documents', rows: [{ id: 'doc-note', filename: 'note.pdf', document_type: 'unknown' }] }
  ]);

  const { pool, skippedWaiting } = await __attachReplyContextToBatchPool({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactions: POOL_TXS
  });

  assert.equal(skippedWaiting, 1, 'the open-ask line is skipped — waiting on the client');
  assert.deepEqual(pool.map((tx) => tx.id), ['tx-replied', 'tx-plain', 'tx-replied-empty']);

  const replied = pool.find((tx) => tx.id === 'tx-replied');
  assert.equal(replied.client_reply_context.client_reply, 'Yes — quarterly draw.');
  assert.equal(replied.client_reply_context.question_asked, 'Is this a member draw?');
  assert.equal(replied.client_reply_context.reply_documents[0].filename, 'note.pdf');
  assert.equal(replied.client_reply_context.prior_verdict.proposed_account, 'Owner drawings');
  assert.equal(replied.client_reply_context.prior_verdict.provenance, 'machine_suggestion_unconfirmed');
  assert.equal(replied.reply_evidence_request_id, 'evr-replied');

  // 'replied' with no text and no docs codes as a normal line.
  const emptied = pool.find((tx) => tx.id === 'tx-replied-empty');
  assert.equal(emptied.client_reply_context, undefined);
  const plain = pool.find((tx) => tx.id === 'tx-plain');
  assert.equal(plain.client_reply_context, undefined);
});

await test('batch pool: no live requests → pool unchanged', async () => {
  const client = makeMockClient([{ match: 'from client_evidence_requests', rows: [] }]);
  const { pool, skippedWaiting } = await __attachReplyContextToBatchPool({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactions: POOL_TXS
  });
  assert.equal(skippedWaiting, 0);
  assert.equal(pool.length, POOL_TXS.length);
});
