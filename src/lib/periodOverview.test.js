import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPeriodOverview, periodSummaryLabel, streamEntryState } from './periodOverview.js';

const tx = (id, date) => ({ id, date, description: id });
const row = (id) => ({ id, transactionId: id, desc: id });
const close = (month, status = 'open', closeStatus = 'review') => ({
  id: `close-${month}`,
  period_start: `${month}-01`,
  period_end: `${month}-${month.endsWith('-02') ? '28' : '31'}`,
  status,
  payload: { close_status: closeStatus }
});

test('groups every persisted lane by month, newest first, with exact counts', () => {
  const periods = buildPeriodOverview({
    transactions: [tx('open-aug', '2025-08-04'), tx('owner-aug', '2025-08-08'), tx('done-jul', '2025-07-02')],
    openRows: [row('open-aug')],
    ownerRows: [row('owner-aug')],
    reconciledRows: [row('done-jul')],
    documentRows: [{ id: 'doc-aug', documentDate: '2025-08-03', document: { id: 'doc-aug' } }]
  });

  assert.deepEqual(periods.map((period) => period.monthKey), ['2025-08', '2025-07']);
  assert.deepEqual(periods[0].counts, { needsInput: 1, processing: 2, stalled: 0, reconciled: 0, remaining: 3 });
  assert.equal(periods[0].status, 'open');
  assert.equal(periodSummaryLabel(periods[0]), '1 needs input · 2 processing');
  assert.deepEqual(periods[1].counts, { needsInput: 0, processing: 0, stalled: 0, reconciled: 1, remaining: 0 });
  assert.equal(periodSummaryLabel(periods[1]), '1 reconciled');
});

test('the pill state renders the persisted convergence verdict, never a lane guess', () => {
  // Terminals by lane.
  assert.equal(streamEntryState('owner', {}), 'needs_input');
  assert.equal(streamEntryState('reconciled', {}), 'reconciled');
  // Open lane: hanging at rest is the VIOLATION pill — stalled, never
  // laundered as processing…
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'review_state:suggested' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'matched_but_uncoded' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging' }), 'stalled');
  // A reason alone cannot promise live work without a bounded activity receipt.
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'owner_answered_processing' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'seat_answered_processing' }), 'stalled');
  // Verdict-first: a terminal verdict decides the pill even if the lane
  // split drifted.
  assert.equal(streamEntryState('open', { convergence_state: 'on_owner' }), 'needs_input');
  assert.equal(streamEntryState('open', { convergence_state: 'auto_reconciled' }), 'reconciled');
  // No persisted verdict (mock / seed): Donna's ordinary work — a stalled
  // claim without a verdict would be a fabrication.
  assert.equal(streamEntryState('open', {}), 'processing');
  // Doc rows: a blocked source is stalled; parsing / awaiting a bank line
  // is bounded work.
  assert.equal(streamEntryState('document', { materialSourceState: 'blocked' }), 'stalled');
  assert.equal(streamEntryState('document', { materialSourceState: 'processing' }), 'processing');
  assert.equal(streamEntryState('document', {}), 'processing');
  // Doc rows read the persisted no-line disposition (the doc-first drain's
  // verdict) like every other pill reads its verdict: a chase/needs_human
  // verdict at rest is the surfaced violation, never "Processing" forever;
  // an open owner ask on the doc is with the owner; no verdict stays
  // Donna's bounded work.
  assert.equal(
    streamEntryState('document', { document: { no_line_disposition: { disposition: 'needs_human' } } }),
    'stalled'
  );
  assert.equal(
    streamEntryState('document', { document: { payload: { no_line_disposition: { disposition: 'chase_evidence' } } } }),
    'stalled'
  );
  assert.equal(
    streamEntryState('document', { matchStatus: 'awaiting_owner', document: { no_line_disposition: { disposition: 'chase_evidence' } } }),
    'needs_input'
  );
  assert.equal(
    streamEntryState('document', { document: { no_line_disposition: { disposition: 'auto_explain' } } }),
    'processing'
  );
  // A blocked source outranks any disposition — the source failure is the
  // actionable state.
  assert.equal(
    streamEntryState('document', { materialSourceState: 'blocked', document: { no_line_disposition: { disposition: 'chase_evidence' } } }),
    'stalled'
  );
});

test('a hanging open row counts as stalled and surfaces in the month summary', () => {
  const [period] = buildPeriodOverview({
    transactions: [tx('hung', '2025-08-04'), tx('working', '2025-08-05')],
    openRows: [
      { ...row('hung'), convergence_state: 'hanging', convergence_reason: 'review_state:suggested' },
      { ...row('working'), convergence_state: 'hanging', convergence_reason: 'owner_answered_processing', processing_activity: {state:'queued',valid_until:'2100-01-01'} }
    ]
  });
  assert.deepEqual(period.counts, { needsInput: 0, processing: 1, stalled: 1, reconciled: 0, remaining: 2 });
  assert.equal(periodSummaryLabel(period), '1 processing · 1 stalled');
  assert.deepEqual(
    period.stream.map((entry) => `${entry.row.id}:${entry.state}`),
    ['working:processing', 'hung:stalled']
  );
});

test('the month stream is ONE date-sorted list — state never affects order', () => {
  const periods = buildPeriodOverview({
    transactions: [
      tx('open-aug', '2025-08-04'),
      tx('owner-aug', '2025-08-08'),
      tx('done-aug', '2025-08-06')
    ],
    openRows: [row('open-aug')],
    ownerRows: [row('owner-aug')],
    reconciledRows: [row('done-aug')],
    documentRows: [{ id: 'doc-aug', documentDate: '2025-08-05', document: { id: 'doc-aug' } }]
  });

  // Newest first by day, lanes interleaved — a row that changes state keeps
  // its place; only its pill flips (Kari, 2026-08-31: single list).
  assert.deepEqual(
    periods[0].stream.map((entry) => `${entry.day}:${entry.lane}`),
    ['2025-08-08:owner', '2025-08-06:reconciled', '2025-08-05:document', '2025-08-04:open']
  );
});

test('undated stream entries sink to the end of their month run', () => {
  const periods = buildPeriodOverview({
    transactions: [tx('dated', '2025-08-10')],
    openRows: [row('dated'), row('undated-row')]
  });
  const august = periods.find((period) => period.monthKey === '2025-08');
  const undated = periods.find((period) => period.monthKey === 'undated');
  assert.deepEqual(august.stream.map((entry) => entry.row.id), ['dated']);
  assert.deepEqual(undated.stream.map((entry) => `${entry.day}:${entry.row.id}`), [':undated-row']);
});

test('only a persisted locked close verdict makes a month Closed', () => {
  const periods = buildPeriodOverview({
    transactions: [tx('jul', '2025-07-10'), tx('aug', '2025-08-10')],
    reconciledRows: [row('jul'), row('aug')],
    closePeriods: [close('2025-07', 'locked', 'ready'), close('2025-08', 'closed', 'ready')]
  });

  const august = periods.find((period) => period.monthKey === '2025-08');
  const july = periods.find((period) => period.monthKey === '2025-07');
  assert.equal(august.closed, false);
  assert.equal(august.status, 'open');
  assert.equal(august.upToDate, true);
  assert.equal(july.closed, true);
  assert.equal(july.status, 'closed');
  assert.equal(periodSummaryLabel(july), '1 reconciled');
});

test('an activity month with no close row does not synthesize a close action', () => {
  const [period] = buildPeriodOverview({
    transactions: [tx('aug', '2025-08-10')],
    reconciledRows: [row('aug')],
    closePeriods: []
  });

  assert.equal(period.monthKey, '2025-08');
  assert.equal(period.closePeriod, null);
  assert.equal(period.closeStatus, null);
  assert.equal(period.closed, false);
  assert.equal(periodSummaryLabel(period), '1 reconciled');
});

test('a checked but unlocked empty period reads Open and Up to date', () => {
  const [period] = buildPeriodOverview({ closePeriods: [close('2025-08', 'open', 'ready')] });
  assert.equal(period.status, 'open');
  assert.equal(period.upToDate, true);
  assert.equal(periodSummaryLabel(period), 'Up to date');
  assert.equal(period.closeStatus, 'ready');
});

test('undated identities remain visible in one honest fallback period', () => {
  const periods = buildPeriodOverview({
    openRows: [row('missing-date')],
    ownerRows: [row('missing-owner-date')],
    documentRows: [{ id: 'missing-doc-date', document: { id: 'missing-doc-date' } }]
  });
  assert.equal(periods.length, 1);
  assert.equal(periods[0].monthKey, 'undated');
  assert.equal(periods[0].label, 'Date unavailable');
  assert.deepEqual(periods[0].counts, { needsInput: 1, processing: 2, stalled: 0, reconciled: 0, remaining: 3 });
});

test('a document without a document date is undated, never grouped by its upload month', () => {
  // Kampaamo 2026-09-21: the OP loan notice carried document_date null and
  // landed in September 2026 (its upload month) with a blank date on the card.
  const periods = buildPeriodOverview({
    documentRows: [
      { id: 'loan-notice', created_at: '2026-09-21T12:31:00.000Z',
        document: { id: 'loan-notice', document_date: null, created_at: '2026-09-21T12:31:00.000Z' } },
      // A recorded invoice date stays the accounting month even when the
      // service period or the upload falls elsewhere (the January-28 rent).
      { id: 'rent-january', created_at: '2026-09-21T12:31:00.000Z',
        document: { id: 'rent-january', document_date: '2026-01-27T22:00:00.000Z', created_at: '2026-09-21T12:31:00.000Z' } }
    ]
  });
  assert.deepEqual(periods.map((period) => period.monthKey), ['2026-01', 'undated']);
  assert.equal(periods[1].label, 'Date unavailable');
  assert.deepEqual(periods[1].stream.map((entry) => `${entry.day}:${entry.row.id}`), [':loan-notice']);
  // The DATE column serialized through a +02:00 host still reads as January 28.
  assert.deepEqual(periods[0].stream.map((entry) => `${entry.day}:${entry.row.id}`), ['2026-01-28:rent-january']);
});

test('duplicate identities within one lane are rendered once', () => {
  const periods = buildPeriodOverview({
    transactions: [tx('same', '2025-08-10')],
    openRows: [row('same'), row('same')]
  });
  assert.equal(periods[0].openRows.length, 1);
  assert.equal(periods[0].counts.processing, 1);
});

test('a contradictory identity is rendered once with owner-held precedence', () => {
  const periods = buildPeriodOverview({
    transactions: [tx('same', '2025-08-10')],
    ownerRows: [row('same')],
    openRows: [row('same')],
    reconciledRows: [row('same')]
  });
  assert.equal(periods[0].ownerRows.length, 1);
  assert.equal(periods[0].openRows.length, 0);
  assert.equal(periods[0].reconciledRows.length, 0);
  assert.deepEqual(periods[0].counts, { needsInput: 1, processing: 0, stalled: 0, reconciled: 0, remaining: 1 });
});

test('feed decisions join their persisted month and replace thinner copies of the same identity', () => {
  const transactionDecision = {
    kind: 'reconciliation_match',
    source_id: 'match-tax',
    transaction_id: 'tx-tax',
    transaction_date: '2025-08-27',
    descriptor: 'IRS USATAXPYMT',
    verdict: { disposition: 'operator_blocker', risk_class: 'tax_sensitive' }
  };
  const documentDecision = {
    kind: 'failed_parse',
    source_id: 'doc-failed',
    document_id: 'doc-failed',
    transaction_date: '2025-07-03',
    descriptor: "Couldn't read receipt.pdf",
    verdict: { disposition: 'operator_blocker' }
  };
  const periods = buildPeriodOverview({
    transactions: [tx('tx-tax', '2025-08-27')],
    ownerRows: [transactionDecision, documentDecision],
    openRows: [row('tx-tax')],
    reconciledRows: [row('tx-tax')],
    documentRows: [{ id: 'doc-failed', documentDate: '2025-07-03', document: { id: 'doc-failed' } }]
  });

  assert.deepEqual(periods.map((period) => period.monthKey), ['2025-08', '2025-07']);
  assert.equal(periods[0].ownerRows[0], transactionDecision);
  assert.deepEqual(periods[0].counts, { needsInput: 1, processing: 0, stalled: 0, reconciled: 0, remaining: 1 });
  assert.equal(periods[1].ownerRows[0], documentDecision);
  assert.deepEqual(periods[1].counts, { needsInput: 1, processing: 0, stalled: 0, reconciled: 0, remaining: 1 });
});

test('FI: old machine-retry reasons without a current activity receipt remain visible failures', () => {
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'disposition:needs_human:machine_rerun' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'parse_hold:runtime_host_not_ready' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'parse_hold:entity_readiness_not_ready' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'disposition:needs_human:owner_ask_exhausted' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'disposition:needs_human:machine_rerun_exhausted' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'disposition:needs_human' }), 'stalled');
  assert.equal(streamEntryState('open', { convergence_state: 'hanging', convergence_reason: 'parse_failed:manual' }), 'stalled');
});

test('scoped no-settlement assessment stays visible as accounting incomplete without changing cash-paid source facts', async () => {
  const {selectMaterialOpenDocumentRows,hasScopedNoSettlementAssessment}=await import('./documentsInbox.js');
  const document=Object.freeze({id:'cash-receipt',document_type:'receipt',parse_status:'completed',document_date:'2025-02-25',
    filename:'cash-receipt.pdf',vendor_name:'Flower shop',total_amount:22,currency:'EUR',payment_status:'paid',
    convergence_state:'auto_reconciled',convergence_reason:'no_settlement_in_scope',
    payload:{document_type:'supplier_bill',status:'needs_review',missing_fields:['Xero contact']}});
  const input={documents:[document],transactions:[{id:'other-bank-line'}],reconciliationMatches:[],reviewItems:[],clientEvidenceRequests:[]};
  const rows=selectMaterialOpenDocumentRows(input);
  assert.equal(rows.length,1,'completed scoped assessment remains visible in Material');
  assert.equal(hasScopedNoSettlementAssessment(rows[0].document),true);
  assert.equal(streamEntryState('document',rows[0]),'no_settlement');
  assert.equal(rows[0].document.payment_status,'paid','cash payment fact is preserved, not inferred from matching');
  const period=buildPeriodOverview({documentRows:rows})[0];
  assert.equal(period.counts.processing,0);assert.equal(period.counts.reconciled,0);
  assert.equal(period.counts.noSettlement,1);assert.equal(period.counts.remaining,1);assert.equal(period.upToDate,false);
  assert.equal(periodSummaryLabel(period),'1 without bank line in supplied scope');
  assert.equal(period.stream[0].state,'no_settlement');
  assert.equal(streamEntryState('document',{document:{...document,parse_status:'processing'}}),'processing','new extraction owns actual in-flight state');
  assert.equal(streamEntryState('document',{document,matchStatus:'awaiting_owner'}),'needs_input','a live owner question retains ownership');
  assert.equal(streamEntryState('document',{document:{...document,convergence_reason:null,no_line_disposition:{disposition:'no_settlement',accounting_complete:false}}}),'no_settlement');
  assert.equal(selectMaterialOpenDocumentRows({...input,reconciliationMatches:[{matched_object_id:document.id,matched_object_type:'receipt',bank_transaction_id:'other-bank-line',status:'auto_matched'}]}).length,0,'later bank match leaves the no-line document inventory');
});

test('in-flight rows name their own phase; one summary per live batch; terminals never ride it', async () => {
  const { streamEntryPhase, activityBatchSummaries, activityBatchSummaryLabel } = await import('./periodOverview.js');
  const live = (phase, batch) => ({ state: 'queued', valid_until: '2099-01-01T00:00:00Z', phase, batch });
  const batch = { batch_id: 'c:upload', reading: ['a.pdf', 'b.pdf', 'c.pdf'], done: 7, on_owner: 17, in_progress: 12 };
  assert.equal(streamEntryPhase('open', { convergence_state: 'hanging', processing_activity: live('awaiting_evidence', batch) }), 'awaiting_evidence');
  assert.equal(streamEntryPhase('open', { convergence_state: 'hanging', processing_activity: live('not_a_phase', batch) }), null, 'an unknown phase falls back to plain Processing');
  assert.equal(streamEntryPhase('reconciled', { convergence_state: 'auto_reconciled', processing_activity: live('coding', batch) }), null);
  assert.equal(streamEntryPhase('open', { convergence_state: 'hanging', processing_activity: { state: 'failed', reason_code: 'processing_cycle_expired' } }), null);
  const summaries = activityBatchSummaries([
    { processing_activity: live('coding', batch) },
    { processing_activity: live('posting', batch) },
    { convergence_state: 'auto_reconciled', processing_activity: null },
    { processing_activity: { state: 'failed', batch } }
  ]);
  assert.equal(summaries.length, 1);
  assert.equal(activityBatchSummaryLabel(summaries[0]), 'Reading a.pdf and 2 more · 7 done · 17 waiting on you · 12 in progress');
  assert.equal(activityBatchSummaryLabel({ batch_id: 'x', reading: [], done: 0, on_owner: 2, in_progress: 1 }), 'Working through this upload · 2 waiting on you · 1 in progress');
  assert.deepEqual(activityBatchSummaries([{ processing_activity: { state: 'failed', batch } }]), [], 'no live receipt, no summary');
});

test('current saved review remains accounting incomplete; stale receipts and owed work outrank the label', () => {
  const accepted = { ...row('native-review'), convergence_state:'hanging', convergence_reason:'processing_review_only',
    processing_scope:{enforced:true,review_current:true}, projection_freshness:{status:'current'} };
  assert.equal(streamEntryState('open',accepted),'review_only');
  assert.equal(streamEntryState('reconciled',accepted),'review_only','a stale lane cannot imply completion');
  assert.equal(streamEntryState('open',{...accepted,processing_scope:{enforced:true,review_current:false}}),'stalled');
  assert.equal(streamEntryState('open',{...accepted,processing_scope:null,review_scope:{accepted_by:'member'}}),'stalled','stored bytes alone carry no current authority');
  assert.equal(streamEntryState('open',{...accepted,convergence_state:'on_owner',convergence_reason:'open_owner_ask'}),'needs_input');
  assert.equal(streamEntryState('open',{...accepted,convergence_reason:'agent_ask_unanswered'}),'stalled');
  assert.equal(streamEntryState('open',{...accepted,processing_activity:{state:'failed'}}),'stalled');
  assert.equal(streamEntryState('open',{...accepted,processing_activity:{state:'running'}}),'processing');
  const [period] = buildPeriodOverview({transactions:[tx('native-review','2026-02-15')],openRows:[accepted]});
  assert.equal(period.counts.reviewOnly,1); assert.equal(period.counts.remaining,1);
  assert.equal(period.counts.reconciled,0); assert.equal(period.upToDate,false);
  assert.equal(periodSummaryLabel(period),'1 review saved · accounting incomplete');
});
