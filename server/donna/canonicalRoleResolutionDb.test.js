// Seam tests for the canonical-role lane's first caller (the audit's standing
// rail: assert what a client's run actually receives and writes, not just what
// the pure modules would compute).
//
// The db client here is a fake that answers ANY unmatched SQL with
// { rows: [] } — exactly the shape that silently resolves "flag off" (the
// feedChatProposalShadow trap). The flag-dark test therefore asserts the
// config-plane query actually RAN, so a future refactor that stops consulting
// the plane cannot pass by defaulting.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_ROLE_RESOLUTION_FLAG_KEY,
  buildDefaultCanonicalRoleCompose,
  deriveRequiredRolesForClient,
  runCanonicalRoleResolutionSweep,
  __runCanonicalRoleResolutionWithClient
} from './canonicalRoleResolutionDb.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';

const fakeDbClient = (responders = []) => {
  const queries = [];
  return {
    queries,
    sqlsMatching: (pattern) => queries.filter((entry) => pattern.test(entry.sql)),
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      for (const [pattern, respond] of responders) {
        if (pattern.test(sql)) {
          return typeof respond === 'function' ? respond({ sql, params }) : respond;
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const fakeImpls = () => {
  const minted = [];
  const upserts = [];
  return {
    minted,
    upserts,
    mintEvidenceRequest: async (args) => {
      minted.push(args);
      return { id: `req-${args.accountRole}` };
    },
    upsertLedgerAccount: async (args) => {
      upserts.push(args);
      return `upserted-${args.account?.code || args.account?.name}`;
    },
    ledgerRecordId: (...parts) => `ledger-${parts.join('-')}`,
    normalBalanceForAccountClass: (klass) =>
      (['liability', 'equity', 'revenue'].includes(String(klass || '').toLowerCase()) ? 'credit' : 'debit')
  };
};

const fakeCompose = (proposals) => {
  const calls = [];
  const compose = async (request) => {
    calls.push(request);
    return { model: 'strong-model-under-test', output: JSON.stringify({ proposals }) };
  };
  compose.calls = calls;
  return compose;
};

const clientRowResponder = [/from clients/, {
  rows: [{ id: CLIENT, company_name: 'Brix Ltd', jurisdiction: 'GB', entity_type: 'ltd', status: 'active' }]
}];

const flagActsResponder = [/from client_capability_config/, {
  rows: [{ flag_key: CANONICAL_ROLE_RESOLUTION_FLAG_KEY, stage: 'canary', source: 'manual', client_id: CLIENT }]
}];

const GB_LEDGER_CHART_ROWS = [
  { id: 'la-2220', code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', currency: null, tax_type: null, canonical_role: null },
  { id: 'la-2230', code: '2230', name: 'Corporation tax payable', account_type: 'liability', normal_balance: 'credit', currency: null, tax_type: null, canonical_role: null },
  { id: 'la-4000', code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', currency: null, tax_type: null, canonical_role: 'revenue.operating' }
];

await test('flag-dark: the run stops before the model, and the config plane was genuinely consulted', async () => {
  const db = fakeDbClient([
    clientRowResponder
    // No config responder: the fake answers { rows: [] }, which must resolve
    // as OFF (envFallback () => false), never as on.
  ]);
  const compose = fakeCompose([]);
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, compose, impls: fakeImpls(), env: {}
  });
  assert.equal(receipt.status, 'flag_dark');
  assert.equal(compose.calls.length, 0, 'no model call while the flag is dark');
  assert.equal(db.sqlsMatching(/update ledger_accounts/).length, 0);
  assert.equal(db.sqlsMatching(/insert into/).length, 0, 'no writes at all while dark');
  // The trap: prove the stage came from asking the plane, not from a default.
  assert.ok(
    db.sqlsMatching(/from client_capability_config/).length >= 1,
    'the config-plane read must actually run'
  );
});

await test('acting: confident invariant-clean proposals are assigned with compare-and-swap, audited, and receipted with the model id', async () => {
  const db = fakeDbClient([
    clientRowResponder,
    flagActsResponder,
    [/from ledger_accounts/, { rows: GB_LEDGER_CHART_ROWS }],
    [/update ledger_accounts/, { rows: [], rowCount: 1 }]
  ]);
  const impls = fakeImpls();
  const compose = fakeCompose([
    { account_id: 'la-2220', role: 'liability.sales_tax_payable', confidence: 0.97, rationale: 'VAT control account' },
    { account_id: 'la-2230', role: 'liability.tax_payable', confidence: 0.95, rationale: 'Corporation tax liability' }
  ]);
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, compose, impls, env: {}, triggeredBy: 'test'
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.assignments_applied, 2);
  assert.equal(receipt.assignments_stale, 0);
  assert.equal(receipt.asks_minted, 0);
  assert.equal(impls.minted.length, 0);
  // The model id is part of the receipt.
  assert.equal(receipt.proposer.model_used, 'strong-model-under-test');
  assert.equal(receipt.plan.unresolved_resting_firm_side, 0);

  // Compare-and-swap: a role is FILLED, never overwritten.
  const updates = db.sqlsMatching(/update ledger_accounts/);
  assert.equal(updates.length, 2);
  assert.ok(updates.every((entry) => /canonical_role is null/.test(entry.sql)));

  // One audit row per assignment plus the run receipt, inside the transaction.
  const assignmentAudits = db.sqlsMatching(/insert into audit_events/)
    .filter((entry) => entry.params.includes('ledger.account.role_assigned')
      || /ledger\.account\.role_assigned/.test(entry.sql));
  assert.equal(assignmentAudits.length, 2);
  const runAudits = db.sqlsMatching(/canonical_role\.resolution_run/);
  assert.equal(runAudits.length, 1);
  const beginAt = db.queries.findIndex((entry) => entry.sql === 'begin');
  const commitAt = db.queries.findIndex((entry) => entry.sql === 'commit');
  const firstUpdateAt = db.queries.findIndex((entry) => /update ledger_accounts/.test(entry.sql));
  assert.ok(beginAt >= 0 && beginAt < firstUpdateAt && firstUpdateAt < commitAt, 'writes run inside the transaction');
});

await test('singleton contention becomes exactly one OWNER ask through the standing-subject writer, and nothing is assigned', async () => {
  const db = fakeDbClient([
    clientRowResponder,
    flagActsResponder,
    [/from ledger_accounts/, { rows: GB_LEDGER_CHART_ROWS }]
  ]);
  const impls = fakeImpls();
  const compose = fakeCompose([
    { account_id: 'la-2220', role: 'liability.sales_tax_payable', confidence: 0.91, rationale: 'VAT liability' },
    { account_id: 'la-2230', role: 'liability.sales_tax_payable', confidence: 0.89, rationale: 'Tax liability' }
  ]);
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, compose, impls, env: {}
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.assignments_applied, 0);
  assert.equal(receipt.asks_minted, 1);
  assert.equal(db.sqlsMatching(/update ledger_accounts/).length, 0);
  assert.equal(impls.minted.length, 1);
  const ask = impls.minted[0];
  assert.equal(ask.accountRole, 'liability.sales_tax_payable');
  assert.equal(ask.evidenceType, 'account_role_ambiguous');
  assert.equal(ask.markTransactionNeedsClient, false);
  assert.match(ask.question, /2220/);
  assert.match(ask.question, /2230/);
  assert.equal(ask.requestContext.canonical_role, 'liability.sales_tax_payable');
});

await test('a synced xero-mirror account with no ledger row is minted THROUGH the existing upsert writer, archived rows excluded', async () => {
  const mirrorId = `ledger-account-${FIRM}-${CLIENT}-820`;
  const db = fakeDbClient([
    clientRowResponder,
    flagActsResponder,
    [/select canonical_role from ledger_accounts/, { rows: [{ canonical_role: 'liability.sales_tax_payable' }] }],
    [/from ledger_accounts/, { rows: [] }],
    [/from xero_accounts/, {
      rows: [
        { xero_account_id: 'x-820', code: '820', name: 'VAT', type: 'CURRLIAB', class: 'LIABILITY', status: 'ACTIVE', tax_type: null },
        { xero_account_id: 'x-999', code: '999', name: 'Old archived account', type: 'EXPENSE', class: 'EXPENSE', status: 'ARCHIVED', tax_type: null }
      ]
    }]
  ]);
  const impls = fakeImpls();
  const compose = fakeCompose([
    { account_id: mirrorId, role: 'liability.sales_tax_payable', confidence: 0.96, rationale: 'VAT control' }
  ]);
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, compose, impls, env: {}
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.assignments_applied, 1);
  assert.equal(impls.upserts.length, 1);
  const upsert = impls.upserts[0];
  assert.equal(upsert.account.code, '820');
  assert.equal(upsert.account.canonical_role, 'liability.sales_tax_payable');
  assert.equal(upsert.account.type, 'liability', 'Xero class, not the unfoldable CURRLIAB type');
  assert.equal(upsert.account.normal_balance, 'credit');
  // The archived row never reached the model.
  assert.equal(compose.calls.length, 1);
  assert.ok(!compose.calls[0].prompt.includes('Old archived account'));
});

await test('a below-floor proposal on a non-required role rides the run receipt as a NAMED deferral: no write, no ask, never invisible', async () => {
  const db = fakeDbClient([
    clientRowResponder,
    flagActsResponder,
    [/from ledger_accounts/, { rows: GB_LEDGER_CHART_ROWS }]
  ]);
  const impls = fakeImpls();
  const compose = fakeCompose([
    { account_id: 'la-2230', role: 'liability.tax_payable', confidence: 0.3, rationale: 'unsure' }
  ]);
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, compose, impls, env: {},
    requiredRoles: [] // caller-supplied wins: nothing is required, so nothing may interrupt the owner
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.assignments_applied, 0);
  assert.equal(receipt.asks_minted, 0);
  assert.equal(impls.minted.length, 0, 'a role nothing requires must not mint an owner ask');
  assert.equal(db.sqlsMatching(/update ledger_accounts/).length, 0, 'below the floor must not post');
  // The deferral lane (Kari 2026-08-01, option B): counted in the plan receipt
  // AND listed per account on the persisted run receipt.
  assert.equal(receipt.plan.deferred_to_next_sweep, 1);
  assert.deepEqual(receipt.deferred_to_next_sweep, [{
    account_id: 'la-2230', code: '2230', name: 'Corporation tax payable',
    role: 'liability.tax_payable', refusal: 'below_confidence_floor', confidence: 0.3
  }]);
  assert.equal(receipt.plan.unresolved_resting_firm_side, 0);
  // The run receipt still persists as an audit event carrying the deferral.
  assert.equal(db.sqlsMatching(/canonical_role\.resolution_run/).length, 1);
});

await test('no compose wired means an honest model_dark receipt, not a heuristic and not a write', async () => {
  const db = fakeDbClient([
    clientRowResponder,
    flagActsResponder,
    [/from ledger_accounts/, { rows: GB_LEDGER_CHART_ROWS }]
  ]);
  const impls = fakeImpls();
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, impls, env: {}
  });
  assert.equal(receipt.status, 'model_dark');
  assert.equal(receipt.reason, 'compose_unavailable');
  assert.equal(receipt.unroled_targets, 2);
  assert.equal(db.sqlsMatching(/update ledger_accounts/).length, 0);
  assert.equal(impls.minted.length, 0);
});

await test('a fully-roled chart short-circuits before any model call', async () => {
  const db = fakeDbClient([
    clientRowResponder,
    flagActsResponder,
    [/from ledger_accounts/, {
      rows: [{ id: 'la-4000', code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', currency: null, tax_type: null, canonical_role: 'revenue.operating' }]
    }]
  ]);
  const compose = fakeCompose([]);
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, compose, impls: fakeImpls(), env: {}
  });
  assert.equal(receipt.status, 'nothing_to_resolve');
  assert.equal(compose.calls.length, 0);
});

await test('a role settled since the chart read is reported stale, never forced', async () => {
  const db = fakeDbClient([
    clientRowResponder,
    flagActsResponder,
    [/from ledger_accounts/, { rows: GB_LEDGER_CHART_ROWS }],
    // rowCount 0: the compare-and-swap found the role no longer null.
    [/update ledger_accounts/, { rows: [], rowCount: 0 }]
  ]);
  const compose = fakeCompose([
    { account_id: 'la-2220', role: 'liability.sales_tax_payable', confidence: 0.97, rationale: 'VAT control' }
  ]);
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: db, firmId: FIRM, clientId: CLIENT, compose, impls: fakeImpls(), env: {}
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.assignments_applied, 0);
  assert.equal(receipt.assignments_stale, 1);
  assert.equal(db.sqlsMatching(/ledger\.account\.role_assigned/).length, 0, 'no audit row for a write that did not happen');
});

await test('deriveRequiredRolesForClient: requirements follow posting reality and never over-ask on unknown', () => {
  const onDate = '2026-07-31';
  const registered = { status: 'registered', registered_from: '2026-01-01' };
  const invoicingActs = { OUTBOUND_INVOICING: { stage: 'canary' } };

  // GB with an EFFECTIVE registration requires the VAT control, invoicing dark or not.
  const vatOnly = deriveRequiredRolesForClient({
    jurisdiction: 'GB', profile: { vat_registration: registered }, snapshot: {}, env: {}, onDate
  });
  assert.deepEqual(vatOnly.roles, ['liability.sales_tax_payable']);
  assert.equal(vatOnly.evidence.gb_vat_registered, true);
  assert.equal(vatOnly.evidence.outbound_invoicing_acts, false);

  // Invoicing acting on an accrual book adds the AR legs.
  const full = deriveRequiredRolesForClient({
    jurisdiction: 'GB', profile: { vat_registration: registered }, snapshot: invoicingActs, env: {}, onDate
  });
  assert.deepEqual(full.roles, ['asset.accounts_receivable', 'liability.sales_tax_payable', 'revenue.operating']);

  // A cash-basis book never posts AR at issuance, so invoicing derives nothing.
  const cash = deriveRequiredRolesForClient({
    jurisdiction: 'GB', profile: { accounting_basis: 'cash' }, snapshot: invoicingActs, env: {}, onDate
  });
  assert.deepEqual(cash.roles, []);
  assert.equal(cash.evidence.accounting_basis, 'cash');

  // UNKNOWN registration (no record) must not require the VAT control: asking a
  // maybe-unregistered owner which account is "the VAT one" is the over-asking
  // the old [] default existed to prevent.
  const unknown = deriveRequiredRolesForClient({ jurisdiction: 'GB', profile: {}, snapshot: {}, env: {}, onDate });
  assert.deepEqual(unknown.roles, []);
  assert.equal(unknown.evidence.gb_vat_registered, null);

  // FI resolves its control accounts by statutory code, not by role: nothing
  // VAT-shaped derives, and the AR legs still follow the role-resolved writer.
  const fi = deriveRequiredRolesForClient({ jurisdiction: 'FI', profile: {}, snapshot: invoicingActs, env: {}, onDate });
  assert.deepEqual(fi.roles, ['asset.accounts_receivable', 'revenue.operating']);
  assert.equal(fi.evidence.gb_vat_registered, null);
});

await test('a derived VAT requirement with no candidate becomes the OWNER question, receipted as derived; an explicit caller list wins', async () => {
  const gbRegisteredClientRow = [/from clients/, {
    rows: [{
      id: CLIENT, company_name: 'Brix Ltd', jurisdiction: 'GB', entity_type: 'gb-ltd', status: 'active',
      profile: { vat_registration: { status: 'registered', registered_from: '2026-01-01' } }
    }]
  }];
  const responders = () => [
    gbRegisteredClientRow,
    flagActsResponder,
    [/from ledger_accounts/, { rows: GB_LEDGER_CHART_ROWS }],
    [/update ledger_accounts/, { rows: [], rowCount: 1 }]
  ];
  const proposals = [
    { account_id: 'la-2230', role: 'liability.tax_payable', confidence: 0.95, rationale: 'Corporation tax liability' }
  ];

  const impls = fakeImpls();
  const receipt = await __runCanonicalRoleResolutionWithClient({
    client: fakeDbClient(responders()), firmId: FIRM, clientId: CLIENT,
    compose: fakeCompose(proposals), impls, env: {}, now: '2026-07-31T00:00:00Z'
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.required_roles_source, 'derived');
  assert.deepEqual(receipt.required_roles, ['liability.sales_tax_payable']);
  assert.equal(receipt.required_roles_evidence.gb_vat_registered, true);
  assert.equal(receipt.asks_minted, 1);
  const ask = impls.minted[0];
  assert.equal(ask.accountRole, 'liability.sales_tax_payable');
  assert.equal(ask.evidenceType, 'account_role_missing');
  // The unroled account the Keep layer would accept is offered by code.
  assert.match(ask.question, /2220/);

  // The same run with an explicit (empty) caller list derives nothing and asks nothing.
  const callerImpls = fakeImpls();
  const callerReceipt = await __runCanonicalRoleResolutionWithClient({
    client: fakeDbClient(responders()), firmId: FIRM, clientId: CLIENT,
    compose: fakeCompose(proposals), impls: callerImpls, env: {}, now: '2026-07-31T00:00:00Z',
    requiredRoles: []
  });
  assert.equal(callerReceipt.required_roles_source, 'caller');
  assert.deepEqual(callerReceipt.required_roles, []);
  assert.equal(callerReceipt.asks_minted, 0);
  assert.equal(callerImpls.minted.length, 0);
});

await test('the sweep finds unroled-chart clients, runs each fail-soft, and tallies honest per-client statuses', async () => {
  const sweepQueries = [];
  const runCalls = [];
  const receipts = {
    'client-a': { status: 'flag_dark' },
    'client-b': { status: 'completed', assignments_applied: 2, asks_minted: 1 }
  };
  const result = await runCanonicalRoleResolutionSweep({
    firmId: FIRM,
    limit: 5,
    env: {},
    deps: {
      withFirmDbClient: async (fn) => fn({
        query: async (sql, params) => {
          sweepQueries.push({ sql, params });
          if (/from ledger_accounts/.test(sql)) {
            return { rows: [
              { client_id: 'client-a', unroled_accounts: 3 },
              { client_id: 'client-b', unroled_accounts: 1 },
              { client_id: 'client-c', unroled_accounts: 2 }
            ] };
          }
          return { rows: [] };
        }
      }),
      runForClient: async (args) => {
        runCalls.push(args);
        const receipt = receipts[args.clientId];
        if (!receipt) throw new Error('boom');
        return receipt;
      }
    }
  });

  assert.equal(result.considered, 3);
  assert.equal(runCalls.length, 3);
  assert.ok(runCalls.every((call) => call.triggeredBy === 'canonical_role_resolution_sweep'));
  assert.deepEqual(result.tally, { flag_dark: 1, completed: 1, error: 1 });
  const errored = result.clients.find((entry) => entry.client_id === 'client-c');
  assert.equal(errored.status, 'error');
  assert.equal(errored.reason, 'boom');
  const completed = result.clients.find((entry) => entry.client_id === 'client-b');
  assert.equal(completed.assignments_applied, 2);
  assert.equal(completed.asks_minted, 1);
  // The candidate query is bounded and scoped: unroled active accounts of
  // non-deleted clients only, capped at the limit.
  const candidateQuery = sweepQueries.find((entry) => /canonical_role is null/.test(entry.sql));
  assert.ok(/status = 'active'/.test(candidateQuery.sql));
  assert.ok(/'deleted'/.test(candidateQuery.sql));
  assert.deepEqual(candidateQuery.params, [FIRM, 5]);
});

await test('the sweep cap holds even when the store over-returns, and an empty book sweeps clean', async () => {
  const runCalls = [];
  const overReturning = async (fn) => fn({
    query: async () => ({ rows: [
      { client_id: 'client-a', unroled_accounts: 1 },
      { client_id: 'client-b', unroled_accounts: 1 }
    ] })
  });
  const capped = await runCanonicalRoleResolutionSweep({
    firmId: FIRM, limit: 1, env: {},
    deps: { withFirmDbClient: overReturning, runForClient: async (args) => { runCalls.push(args); return { status: 'flag_dark' }; } }
  });
  assert.equal(capped.considered, 1);
  assert.equal(runCalls.length, 1);

  const empty = await runCanonicalRoleResolutionSweep({
    firmId: FIRM, limit: 5, env: {},
    deps: { withFirmDbClient: async (fn) => fn({ query: async () => ({ rows: [] }) }), runForClient: async () => { throw new Error('must not run'); } }
  });
  assert.equal(empty.considered, 0);
  assert.deepEqual(empty.clients, []);
  assert.deepEqual(empty.tally, {});
});

await test('buildDefaultCanonicalRoleCompose: dark without a key; with one, the RESPONSE model rides the receipt', async () => {
  assert.equal(buildDefaultCanonicalRoleCompose({ env: {} }), null);

  const requests = [];
  const compose = buildDefaultCanonicalRoleCompose({
    env: { ANTHROPIC_API_KEY: 'key-under-test' },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          model: 'resolved-by-the-api',
          content: [{ type: 'text', text: '{"proposals": []}' }]
        })
      };
    }
  });
  const result = await compose({ model: 'requested-model', prompt: 'PROMPT' });
  assert.equal(result.model, 'resolved-by-the-api');
  assert.equal(result.output, '{"proposals": []}');
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'requested-model');
  assert.equal(body.messages[0].content, 'PROMPT');
  assert.equal(requests[0].init.headers['x-api-key'], 'key-under-test');
});

await test('owner language: a Finnish client gets the role question in Finnish from the client row already read', async () => {
  const db = fakeDbClient([
    [/from clients/, { rows: [{ id: CLIENT, company_name: 'Esimerkki Oy', jurisdiction: 'FI', entity_type: 'oy', status: 'active', profile: {} }] }],
    flagActsResponder,
    [/from ledger_accounts/, { rows: GB_LEDGER_CHART_ROWS }]
  ]);
  const impls = fakeImpls();
  const compose = fakeCompose([
    { account_id: 'la-2220', role: 'liability.sales_tax_payable', confidence: 0.91, rationale: 'VAT liability' },
    { account_id: 'la-2230', role: 'liability.sales_tax_payable', confidence: 0.89, rationale: 'Tax liability' }
  ]);
  await __runCanonicalRoleResolutionWithClient({ client: db, firmId: FIRM, clientId: CLIENT, compose, impls, env: {} });
  assert.equal(impls.minted.length, 1);
  assert.match(impls.minted[0].question, /^Kirjanpidossasi on useampi tili, joka voisi olla ALV-velkatili: 2220 VAT control tai 2230 Corporation tax payable\./);
  assert.equal(impls.minted[0].requestContext.canonical_role, 'liability.sales_tax_payable');
});
