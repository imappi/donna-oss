// G-6 (FI-15) — the prepayment_register_checks writers (migration 068) against
// a pattern-matching fake pg client (the finlandSuomifiMandateDb.test.js
// style): audit-as-precondition, the not-registered-supplier escalation lane
// (deterministic ask id, delivered after commit), and the quiet paths.
// node --test server/donna/finlandPrepaymentRegisterDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __recordPrepaymentRegisterCheckWithClient,
  recordPrepaymentRegisterCheckInDb
} from './statutoryRegistry.js';
import { PREPAYMENT_REGISTER_EVIDENCE_TYPE } from './finland/prepaymentRegister.js';

const fakeClient = ({ billCount = 0 } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes('insert into prepayment_register_checks')) {
        return {
          rows: [{
            id: params[0], firm_id: params[1], client_id: params[2], subject_type: params[3],
            business_id: params[4], counterparty_name: params[5], counterparty_key: params[6],
            status: params[7], checked_on: params[8], source: params[9],
            reference: params[10], note: params[11], recorded_by: params[12]
          }]
        };
      }
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 1 }] };
      if (sql.includes('from documents')) {
        return { rows: [{ bill_count: billCount, last_bill_on: billCount ? '2026-07-01' : null }] };
      }
      if (sql.includes('insert into client_evidence_requests')) {
        return {
          rows: [{
            id: params[0], firm_id: params[1], client_id: params[2], status: 'open',
            evidence_type: params[3], question: params[4], request_payload: JSON.parse(params[5]),
            send_count: 0, created_by: params[6]
          }]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const record = ({ client, check, deliveries }) => recordPrepaymentRegisterCheckInDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  check,
  actorId: 'kari@books.example',
  onDate: '2026-07-11',
  deliverAsksImpl: async (args) => { deliveries.push(args); },
  withFirmDbClientFn: async (fn) => fn(client)
});

test('record self check: insert + audit in one transaction, operator-attributed, no escalation', async () => {
  const client = fakeClient();
  const deliveries = [];
  const result = await record({
    client,
    deliveries,
    check: { subjectType: 'self', status: 'registered', checkedOn: '2026-07-11', reference: 'ytj.fi' }
  });
  assert.equal(result.check.subject_type, 'self');
  assert.equal(result.check.status, 'registered');
  assert.equal(result.check.recorded_by, 'kari@books.example');
  assert.equal(result.escalation, null);
  assert.deepEqual(deliveries, []);
  const auditQuery = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.ok(auditQuery.sql.includes('prepayment_register.check_recorded'), 'audit action pinned');
  assert.equal(auditQuery.params[2], 'kari@books.example', 'the acting member is attributed');
  const order = client.queries.map((q) => q.sql.split(/\s+/).slice(0, 4).join(' '));
  assert.ok(order.indexOf('begin') < order.findIndex((s) => s.startsWith('insert into prepayment_register_checks')), 'runs in the transaction');
  assert.ok(client.queries.some((q) => q.sql === 'commit'));
});

test('a not-registered supplier WITH recent bills escalates: deterministic ask, delivered after commit', async () => {
  const client = fakeClient({ billCount: 2 });
  const deliveries = [];
  const result = await record({
    client,
    deliveries,
    check: { subjectType: 'supplier', counterpartyName: 'Konsultti Ky', status: 'not_registered', checkedOn: '2026-07-11' }
  });
  assert.ok(result.escalation, 'escalation minted');
  assert.equal(result.escalation.bill_count, 2);
  const ask = result.escalation.ask;
  assert.equal(ask.evidence_type, PREPAYMENT_REGISTER_EVIDENCE_TYPE);
  assert.match(ask.id, /^prepayment-register-firm-1-client-1-/, 'deterministic per-supplier id');
  assert.match(ask.question, /Konsultti Ky/);
  assert.match(ask.question, /Donna ei toimita ennakonpidätystä/);
  assert.deepEqual(deliveries.map((d) => d.evidenceRequestIds), [[ask.id]], 'delivered over the ask substrate');
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.ok(askInsert.sql.includes('on conflict (id) do update'), 're-checks reopen the same ask, never a sibling');
  assert.doesNotMatch(askInsert.sql, /first_sent_at|last_sent_at|send_count \+ 1/, 'the mint and a re-check write no sent stamp: only a deliverer stamps');
  const commitIdx = client.queries.findIndex((q) => q.sql === 'commit');
  const askIdx = client.queries.indexOf(askInsert);
  assert.ok(askIdx < commitIdx, 'the ask mints inside the same transaction');
});

test('quiet paths: no bills → no ask; a registered supplier → no bills query at all', async () => {
  const noBills = fakeClient({ billCount: 0 });
  const deliveries = [];
  const skipped = await record({
    client: noBills,
    deliveries,
    check: { subjectType: 'supplier', counterpartyName: 'Etä Paja', status: 'not_registered', checkedOn: '2026-07-11' }
  });
  assert.equal(skipped.escalation, null);
  assert.deepEqual(deliveries, []);

  const registered = fakeClient();
  const ok = await record({
    client: registered,
    deliveries,
    check: { subjectType: 'supplier', counterpartyName: 'Siivous OY', status: 'registered', checkedOn: '2026-07-11' }
  });
  assert.equal(ok.escalation, null);
  assert.ok(!registered.queries.some((q) => q.sql.includes('from documents')), 'no escalation probe for a registered supplier');
});

test('a bad shape refuses with 400 and rolls back — nothing recorded, nothing audited', async () => {
  const client = fakeClient();
  await assert.rejects(
    record({ client, deliveries: [], check: { subjectType: 'supplier', status: 'registered', checkedOn: '2026-07-11' } }),
    (e) => e.statusCode === 400 && /counterparty_name/.test(e.message)
  );
  assert.ok(client.queries.some((q) => q.sql === 'rollback'));
  assert.ok(!client.queries.some((q) => q.sql.includes('insert into prepayment_register_checks')));
});

test('__recordPrepaymentRegisterCheckWithClient validates the Y-tunnus at the writer', async () => {
  const client = fakeClient();
  await assert.rejects(
    __recordPrepaymentRegisterCheckWithClient({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      check: { subjectType: 'self', status: 'registered', checkedOn: '2026-07-11', businessId: '1234567-8' }
    }),
    (e) => e.statusCode === 400 && /Y-tunnus/.test(e.message)
  );
});
