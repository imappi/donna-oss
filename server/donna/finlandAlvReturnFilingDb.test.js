// FI-3 slice P — the alv_returns store writers (migration 066) against a
// pattern-matching fake pg client (the finlandInvoiceIssuanceDb.test.js style):
// needs_review-never-mints, audit-as-precondition, guarded transitions, the
// live-period 409, and the start motion's two-terminal spine (ready → row +
// confirm ask + delivery; needs_review → clarification ask, NO row).
// node --test server/donna/finlandAlvReturnFilingDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __cancelAlvReturnWithClient,
  __createAlvReturnDraftWithClient,
  __markAlvReturnFiledWithClient,
  startFinlandAlvReturnFilingInDb
} from './statutoryRegistry.js';

const readyVerdict = () => ({
  alvReturn: {
    boxes: { 301: 127.5, 307: 25.5, 308: 102 },
    payable: 102, refund: false, nilReturn: false, selfAssessedFullyDeductible: true
  },
  review: { status: 'ready', blockers: [] },
  provenance: { source: 'ledger_read_model', deterministic: true }
});

const period = { key: '2026-06', type: 'month', starts_on: '2026-06-01', ends_on: '2026-06-30' };

const fakeClient = ({ transitionMatches = true, duplicate = false, liveRows = [] } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('from alv_returns') && sql.includes('starts_on <=')) return { rows: liveRows };
      if (sql.includes('insert into alv_returns')) {
        if (duplicate) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        return { rows: [{ id: params[0], firm_id: params[1], client_id: params[2], period_key: params[3], period_type: params[4], starts_on: params[5], ends_on: params[6], status: 'draft_pending_confirmation', verdict: JSON.parse(params[7]), model: params[8], created_by: params[9] }] };
      }
      if (sql.includes('update alv_returns')) {
        if (!transitionMatches) return { rows: [] };
        const status = sql.includes("'filed'") ? 'filed' : 'cancelled';
        return { rows: [{ id: params[2], firm_id: params[0], client_id: params[1], period_key: '2026-06', status, verdict: readyVerdict(), model: null }] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const wroteAudit = (client, action) =>
  client.queries.some((q) => q.sql.includes('insert into audit_events') && q.sql.includes(action));

test('draft create: mints pending with the verdict + audits in-txn; a needs_review verdict NEVER mints', async () => {
  const client = fakeClient();
  const row = await __createAlvReturnDraftWithClient({
    client, firmId: 'firm-1', clientId: 'client-1', period, verdict: readyVerdict(), actorId: 'member-1'
  });
  assert.equal(row.status, 'draft_pending_confirmation');
  assert.equal(row.period_key, '2026-06');
  assert.equal(row.verdict.alvReturn.payable, 102);
  assert.ok(wroteAudit(client, 'alv_return.draft_created'), 'audit event rides the same txn');

  const blocked = readyVerdict();
  blocked.review = { status: 'needs_review', blockers: ['uncoded_revenue_lines'] };
  await assert.rejects(
    __createAlvReturnDraftWithClient({ client: fakeClient(), firmId: 'firm-1', clientId: 'client-1', period, verdict: blocked }),
    (e) => e.code === 'ALV_RETURN_NEEDS_REVIEW' && e.statusCode === 409
  );
});

test('draft create: a live row for the period (pending or filed) is a typed 409, not a shade', async () => {
  await assert.rejects(
    __createAlvReturnDraftWithClient({ client: fakeClient({ duplicate: true }), firmId: 'firm-1', clientId: 'client-1', period, verdict: readyVerdict() }),
    (e) => e.code === 'ALV_RETURN_ALREADY_LIVE' && e.statusCode === 409
  );
});

test('draft create: dates already covered by another live return are a typed 409 naming that return', async () => {
  const client = fakeClient({ liveRows: [{ id: 'alv-q3', period_key: '2026-Q2', period_type: 'quarter', starts_on: '2026-04-01', ends_on: '2026-06-30', status: 'filed' }] });
  await assert.rejects(
    __createAlvReturnDraftWithClient({ client, firmId: 'firm-1', clientId: 'client-1', period, verdict: readyVerdict() }),
    (e) => e.code === 'ALV_RETURN_PERIOD_OVERLAP' && e.statusCode === 409
      && /2026-Q2 \(2026-04-01 – 2026-06-30, filed\) already covers/.test(e.message)
      && e.details.overlapping[0].id === 'alv-q3'
  );
  assert.ok(!client.queries.some((q) => q.sql.includes('insert into')), 'refused before any write');
  const lock = client.queries.findIndex((q) => q.sql.includes('pg_advisory_xact_lock'));
  const check = client.queries.findIndex((q) => q.sql.includes('from alv_returns'));
  assert.ok(lock >= 0 && lock < check, 'the overlap read runs under the per-client lock');
  assert.equal(client.queries[lock].params[0], 'alv-return-periods:firm-1:client-1');
});

test('mark filed: requires the authority basis, flips only a pending row, audits with the receipt', async () => {
  await assert.rejects(
    __markAlvReturnFiledWithClient({ client: fakeClient(), firmId: 'f', clientId: 'c', alvReturnId: 'alv-1', filingReceipt: {} }),
    (e) => e.code === 'ALV_RETURN_AUTHORITY_REQUIRED'
  );
  const client = fakeClient();
  const filed = await __markAlvReturnFiledWithClient({
    client, firmId: 'f', clientId: 'c', alvReturnId: 'alv-1',
    filingReceipt: { channel: 'omavero_test', submission_id: 'SUB-1' },
    authorityBasis: { source: 'owner_whatsapp_alv_filing_confirmation' },
    actorId: 'owner-1'
  });
  assert.equal(filed.status, 'filed');
  assert.ok(wroteAudit(client, 'alv_return.filed'));
  const audit = client.queries.find((q) => q.sql.includes('alv_return.filed'));
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.submission_id, 'SUB-1');
  assert.equal(metadata.model, null, 'deterministic compute → model honestly null in the receipt');
  // A non-pending row refuses (the guarded WHERE finds nothing).
  await assert.rejects(
    __markAlvReturnFiledWithClient({
      client: fakeClient({ transitionMatches: false }), firmId: 'f', clientId: 'c', alvReturnId: 'alv-1',
      filingReceipt: {}, authorityBasis: { source: 's' }
    }),
    (e) => e.code === 'ALV_RETURN_NOT_PENDING' && e.statusCode === 409
  );
});

test('cancel: flips only a pending row and audits the owner receipt', async () => {
  const client = fakeClient();
  const cancelled = await __cancelAlvReturnWithClient({
    client, firmId: 'f', clientId: 'c', alvReturnId: 'alv-1', reason: 'owner_declined',
    authorityBasis: { source: 'owner_whatsapp_alv_filing_confirmation' }, actorId: 'owner-1'
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(wroteAudit(client, 'alv_return.cancelled'));
});

test('start motion, ready compute: mints the row, creates + DELIVERS the confirm ask (on the owner)', async () => {
  const created = { drafts: [], asks: [], delivered: [] };
  const result = await startFinlandAlvReturnFilingInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    period: '2026-06',
    actorId: 'member-1',
    flagActsImpl: async () => true,
    liveOverlapImpl: async () => [],
    ownerLanguageImpl: async () => 'fi',
    scopeDriftImpl: async () => null,
    computeImpl: async () => ({ period, ...readyVerdict() }),
    createDraftImpl: async (args) => {
      created.drafts.push(args);
      return { id: 'alv-row-1', status: 'draft_pending_confirmation', period_key: args.period.key, verdict: args.verdict };
    },
    createAskImpl: async (args) => {
      created.asks.push(args);
      return { id: `ask-${created.asks.length}` };
    },
    deliverAsksImpl: async ({ evidenceRequestIds }) => created.delivered.push(...evidenceRequestIds)
  });
  assert.equal(result.action, 'confirmation_requested');
  assert.equal(created.drafts.length, 1);
  assert.equal(created.drafts[0].verdict.alvReturn.payable, 102);
  assert.equal(created.asks.length, 1);
  assert.equal(created.asks[0].evidenceType, 'alv_return');
  assert.equal(created.asks[0].requestPayload.alv_return.phase, 'confirm_request');
  assert.equal(created.asks[0].requestPayload.alv_return.alv_return_id, 'alv-row-1');
  assert.match(created.asks[0].question, /Maksettava vero 102,00 €/);
  assert.match(created.asks[0].question, /Vahvista vastaamalla/);
  assert.deepEqual(created.delivered, ['ask-1'], 'the confirm ask is DELIVERED, not parked');
});

test('start motion, ready compute over dates already covered: the refusal surfaces, NO ask is created or sent', async () => {
  const created = { asks: [], delivered: [] };
  const overlap = Object.assign(new Error('ALV return 2026-06 was not created: the return 2026-Q2 already covers some of these dates.'), { statusCode: 409, code: 'ALV_RETURN_PERIOD_OVERLAP' });
  await assert.rejects(
    startFinlandAlvReturnFilingInDb({
      firmId: 'firm-1', clientId: 'client-1', period: '2026-06',
      flagActsImpl: async () => true,
      liveOverlapImpl: async () => [],
      ownerLanguageImpl: async () => 'fi',
      scopeDriftImpl: async () => null,
      computeImpl: async () => ({ period, ...readyVerdict() }),
      createDraftImpl: async () => { throw overlap; },
      createAskImpl: async (args) => { created.asks.push(args); return { id: 'ask-x' }; },
      deliverAsksImpl: async ({ evidenceRequestIds }) => created.delivered.push(...evidenceRequestIds)
    }),
    (e) => e === overlap
  );
  assert.deepEqual(created, { asks: [], delivered: [] }, 'the owner is never asked to confirm a return that would double-report');
});

test('start motion over dates another live return covers: refused BEFORE the compute — nothing computed, nobody asked', async () => {
  const calls = { computed: 0, asks: 0, delivered: 0, overlapReads: [] };
  const covering = [{ id: 'alv-q3', period_key: '2026-Q3', period_type: 'quarter', starts_on: '2026-07-01', ends_on: '2026-09-30', status: 'filed' }];
  await assert.rejects(
    startFinlandAlvReturnFilingInDb({
      firmId: 'firm-1', clientId: 'client-1', period: '2026-09',
      flagActsImpl: async () => true,
      liveOverlapImpl: async (args) => { calls.overlapReads.push(args); return covering; },
      scopeDriftImpl: async () => { throw new Error('must not read drift for a covered period'); },
      computeImpl: async () => { calls.computed += 1; return { period, ...readyVerdict() }; },
      createDraftImpl: async () => { throw new Error('must not reach the writer'); },
      createAskImpl: async () => { calls.asks += 1; return { id: 'ask-x' }; },
      deliverAsksImpl: async () => { calls.delivered += 1; }
    }),
    (e) => e.code === 'ALV_RETURN_PERIOD_OVERLAP' && e.statusCode === 409 && /2026-Q3/.test(e.message)
      && e.details.overlapping[0].period_key === '2026-Q3'
  );
  assert.deepEqual({ computed: calls.computed, asks: calls.asks, delivered: calls.delivered }, { computed: 0, asks: 0, delivered: 0 });
  assert.deepEqual(calls.overlapReads.map((a) => a.period), [{ key: '2026-09', type: 'month', starts_on: '2026-09-01', ends_on: '2026-09-30' }]);
});

test('start motion, needs_review compute: NO row — the blockers ride an owner clarification ask', async () => {
  const created = { drafts: [], asks: [], delivered: [] };
  const result = await startFinlandAlvReturnFilingInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    period: '2026-06',
    flagActsImpl: async () => true,
    liveOverlapImpl: async () => [],
    ownerLanguageImpl: async () => 'fi',
    scopeDriftImpl: async () => null,
    computeImpl: async () => ({
      period,
      alvReturn: readyVerdict().alvReturn,
      review: { status: 'needs_review', blockers: ['uncoded_revenue_lines'], uncodedRevenueLines: [{ journal_id: 'j1' }], incompatibleLines: [] },
      provenance: {}
    }),
    createDraftImpl: async (args) => { created.drafts.push(args); return {}; },
    createAskImpl: async (args) => { created.asks.push(args); return { id: 'ask-review-1' }; },
    deliverAsksImpl: async ({ evidenceRequestIds }) => created.delivered.push(...evidenceRequestIds)
  });
  assert.equal(result.action, 'escalated');
  assert.deepEqual(result.blockers, ['uncoded_revenue_lines']);
  assert.equal(created.drafts.length, 0, 'a needs_review compute never mints a row');
  assert.equal(created.asks.length, 1);
  assert.equal(created.asks[0].evidenceType, 'alv_return_review');
  assert.match(created.asks[0].question, /1 tulotapahtumaa ilman ALV-käsittelyä/);
  assert.deepEqual(created.delivered, ['ask-review-1']);
});

test('start motion: the FINLAND_ALV_FILING gate is a typed 403 when dark', async () => {
  await assert.rejects(
    startFinlandAlvReturnFilingInDb({
      firmId: 'firm-1', clientId: 'client-1', period: '2026-06',
      flagActsImpl: async () => false,
      computeImpl: async () => { throw new Error('must not compute when the lane is dark'); }
    }),
    (e) => e.code === 'FINLAND_ALV_FILING_DISABLED' && e.statusCode === 403
  );
});

test('start motion, G-7: a filing_blocked scope-drift verdict escalates — NO draft even on a ready compute', async () => {
  const created = { drafts: [], asks: [], delivered: [] };
  const result = await startFinlandAlvReturnFilingInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    period: '2026-06',
    flagActsImpl: async () => true,
    liveOverlapImpl: async () => [],
    ownerLanguageImpl: async () => 'fi',
    scopeDriftImpl: async () => ({
      verdict: 'filing_blocked',
      triggers: [
        { id: 'construction_reverse_charge', severity: 'filing_blocked', evidence: { ledger_lines: 2 } },
        { id: 'inventory_activity', severity: 'supported_with_review', evidence: { ledger_lines: 1 } }
      ]
    }),
    computeImpl: async () => ({ period, ...readyVerdict() }),
    createDraftImpl: async (args) => { created.drafts.push(args); return {}; },
    createAskImpl: async (args) => { created.asks.push(args); return { id: 'ask-drift-1' }; },
    deliverAsksImpl: async ({ evidenceRequestIds }) => created.delivered.push(...evidenceRequestIds)
  });
  assert.equal(result.action, 'escalated');
  // Only the filing_blocked trigger becomes a blocker; the review-severity one
  // rides the watch surface, not the filing gate.
  assert.deepEqual(result.blockers, ['scope_drift_construction_reverse_charge']);
  assert.equal(created.drafts.length, 0, 'a drift-blocked filing never mints a draft');
  assert.equal(created.asks.length, 1);
  assert.equal(created.asks[0].evidenceType, 'alv_return_review');
  assert.match(created.asks[0].question, /käännetty ALV/);
  assert.deepEqual(created.delivered, ['ask-drift-1'], 'the clarification ask is DELIVERED — on the owner');

  // A merely-reviewable drift verdict does NOT gate the filing.
  const passThrough = { drafts: [], asks: [], delivered: [] };
  const ok = await startFinlandAlvReturnFilingInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    period: '2026-06',
    flagActsImpl: async () => true,
    liveOverlapImpl: async () => [],
    ownerLanguageImpl: async () => 'fi',
    scopeDriftImpl: async () => ({ verdict: 'supported_with_review', triggers: [{ id: 'cash_activity', severity: 'supported_with_review' }] }),
    computeImpl: async () => ({ period, ...readyVerdict() }),
    createDraftImpl: async (args) => {
      passThrough.drafts.push(args);
      return { id: 'alv-row-2', status: 'draft_pending_confirmation', period_key: args.period.key, verdict: args.verdict };
    },
    createAskImpl: async (args) => { passThrough.asks.push(args); return { id: 'ask-2' }; },
    deliverAsksImpl: async ({ evidenceRequestIds }) => passThrough.delivered.push(...evidenceRequestIds)
  });
  assert.equal(ok.action, 'confirmation_requested');
  assert.equal(passThrough.drafts.length, 1);
});

// ── The owner's language on the ALV escalation and confirm asks ──────────────
// A Finnish company whose owner chose English read both asks in Finnish, and a
// part-paid document was called "not yet recorded". The language is the one
// resolver's (getClientOwnerLanguageInDb by default; injected here).
const escalate = async ({ language, review }) => {
  const asks = [];
  const seen = [];
  await startFinlandAlvReturnFilingInDb({
    firmId: 'firm-1', clientId: 'client-1', period: '2026-06',
    flagActsImpl: async () => true,
    liveOverlapImpl: async () => [],
    ownerLanguageImpl: async (input) => { seen.push(input); return language; },
    scopeDriftImpl: async () => null,
    computeImpl: async () => ({ period, alvReturn: readyVerdict().alvReturn, review, provenance: {} }),
    createDraftImpl: async (args) => ({ id: 'alv-row-1', status: 'draft_pending_confirmation', period_key: args.period.key, verdict: args.verdict }),
    createAskImpl: async (args) => { asks.push(args); return { id: 'ask-1' }; },
    deliverAsksImpl: async () => {}
  });
  return { question: asks[0].question, seen };
};
const census = (rests) => ({ items: rests.map((r, i) => ({ document_id: `doc-${i}`, rests: r })) });

test('ALV escalation: English for an owner who chose English; a part-paid document is named as paid only in part', async () => {
  const review = {
    status: 'needs_review',
    blockers: ['uncoded_revenue_lines', 'unrecognized_sales'],
    uncodedRevenueLines: [{ journal_id: 'j1' }, { journal_id: 'j2' }],
    incompatibleLines: [{ journal_id: 'j3' }],
    unrecognizedSales: census(['no_settlement', 'part_settled_in_period']),
    unrecognizedPurchases: census(['part_settled_in_period', 'part_settled_in_period'])
  };
  const en = await escalate({ language: 'en', review });
  assert.deepEqual(en.seen, [{ firmId: 'firm-1', clientId: 'client-1' }]);
  assert.equal(en.question, [
    'The VAT return (2026-06) is not ready to file yet.',
    '2 income transactions have no VAT treatment yet. Tell me what sales these are.',
    '1 entry has a VAT code that does not fit the account. I will go through it with you.',
    "1 uploaded sales invoice or credit note is not yet recorded in this period's sales, so its sales and VAT are missing from the calculation.",
    '1 uploaded sales invoice is paid only in part in this period, so the sales and VAT of its unpaid remainder are missing from the calculation.',
    '2 uploaded purchase invoices are paid only in part in this period, so the costs and deductible VAT of their unpaid remainder are missing from the calculation.'
  ].join(' '));
  const fi = await escalate({ language: 'fi', review });
  assert.equal(fi.question, [
    'ALV-ilmoitus (2026-06) ei ole vielä valmis lähetettäväksi.',
    '2 tulotapahtumaa ilman ALV-käsittelyä — kerro, mitä myyntiä nämä ovat.',
    '1 kirjausta, joiden ALV-koodi ei sovi tilille — tarkistan ne kanssasi.',
    '1 ladattua myyntilaskua tai hyvityslaskua ei ole vielä kirjattu tämän kauden myyntiin, joten niiden myynti ja ALV puuttuvat laskelmasta.',
    '1 ladattu myyntilasku on maksettu tällä kaudella vain osittain, joten sen maksamattoman loppuosan myynti ja ALV puuttuvat laskelmasta.',
    '2 ladattua ostolaskua on maksettu tällä kaudella vain osittain, joten niiden maksamattoman loppuosan kulut ja vähennettävä ALV puuttuvat laskelmasta.'
  ].join(' '));
  assert.doesNotMatch(fi.question, /2 ladattua ostolaskua tai ostohyvityslaskua ei ole vielä kirjattu/, 'a part-paid bill is not called unrecorded');
});

test('ALV confirm ask: English for an owner who chose English, Finnish otherwise', async () => {
  const confirm = async (language) => {
    const asks = [];
    await startFinlandAlvReturnFilingInDb({
      firmId: 'firm-1', clientId: 'client-1', period: '2026-06',
      flagActsImpl: async () => true,
      liveOverlapImpl: async () => [],
      ownerLanguageImpl: async () => language,
      scopeDriftImpl: async () => null,
      computeImpl: async () => ({ period, ...readyVerdict() }),
      createDraftImpl: async (args) => ({ id: 'alv-row-1', status: 'draft_pending_confirmation', period_key: args.period.key, verdict: args.verdict }),
      createAskImpl: async (args) => { asks.push(args); return { id: 'ask-1' }; },
      deliverAsksImpl: async () => {}
    });
    return asks[0].question;
  };
  assert.match(await confirm('en'), /^VAT return, tax period 2026-06\nVAT payable 102\.00 €\./);
  assert.match(await confirm('en'), /Reply “yes” to confirm and I will file the return/);
  assert.match(await confirm('fi'), /^ALV-ilmoitus, verokausi 2026-06\nMaksettava vero 102,00 €\./);
});

test('the owner question gains one sentence for postings being corrected, in the owner language', async () => {
  const { buildFinlandAlvReviewQuestion } = await import('./finland/statutoryDb.js');
  const review = (count) => ({ status: 'needs_review', blockers: ['open_coding_corrections'], openCodingCorrections: { count, items: [] } });
  assert.equal(buildFinlandAlvReviewQuestion({ review: review(1), periodKey: '2026-06', language: 'fi' }),
    'ALV-ilmoitus (2026-06) ei ole vielä valmis lähetettäväksi. Yhtä tämän kauden kirjausta korjataan parhaillaan, ja ilmoitus odottaa, kunnes korjaus on tehty.');
  assert.equal(buildFinlandAlvReviewQuestion({ review: review(3), periodKey: '2026-06', language: 'fi' }),
    'ALV-ilmoitus (2026-06) ei ole vielä valmis lähetettäväksi. 3 tämän kauden kirjausta korjataan parhaillaan, ja ilmoitus odottaa, kunnes korjaukset on tehty.');
  assert.equal(buildFinlandAlvReviewQuestion({ review: review(2), periodKey: '2026-06', language: 'en' }),
    'The VAT return (2026-06) is not ready to file yet. 2 postings in this period are being corrected, and the return waits until that is done.');
  assert.equal(buildFinlandAlvReviewQuestion({ review: { status: 'ready', blockers: [] }, periodKey: '2026-06', language: 'en' }),
    'The VAT return (2026-06) is not ready to file yet.', 'no case, no sentence');
});
