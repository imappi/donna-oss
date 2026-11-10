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

test('start motion, needs_review compute: NO row — the blockers ride an owner clarification ask', async () => {
  const created = { drafts: [], asks: [], delivered: [] };
  const result = await startFinlandAlvReturnFilingInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    period: '2026-06',
    flagActsImpl: async () => true,
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
