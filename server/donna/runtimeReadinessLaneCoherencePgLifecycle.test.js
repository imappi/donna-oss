// RT-09 — readiness lane coherence, on the RT-06 appliance harness
// (docs/plan-2026-09-01-runtime-refactor-slices.md; audit F-06 and F-21).
//
// Three fixtures, real PostgreSQL, the real createDonnaRuntimeServer:
//
//   (a) a host-caused entity failure is BUDGET-FREE. A saga that fails on
//       host_certificate_not_pass — at birth under a failed host, or three
//       operator Retry clicks against the same failed host — keeps
//       attempt_count 0, rests failed/scheduled with next_retry_at null, and
//       heals on the FIRST Host A PASS renewal without a click. Before this
//       slice every such attempt charged the three-attempt episode budget and
//       the second click inside sixty seconds was refused as "not due"
//       (F-06: the only retry runners needed the host healthy already).
//   (b) the migration-127 fence is scoped to writes Donna did NOT itself
//       admit: a posting through the shared ledger writer that mints a chart
//       account runs under an admission decision, so its ledger_accounts
//       insert leaves the ready saga ready (F-21: the Desert Rose flap —
//       seven self-inflicted invalidations, 137 admission blocks). The
//       scope is the exact ready generation digest, set per transaction by
//       the admission helper; a stale digest scopes nothing.
//   (c) a FOREIGN dependency change — an operator editing the client's
//       jurisdiction — still invalidates in the writer's transaction, as
//       before.
//
// Host transitions are driven through persistHostReadinessAttempt (FAIL) and
// the runtime's own renewNow (PASS), never by waiting: the harness owns
// dispatch and cannot move the database clock (its header says so).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __writeLedgerJournalRows,
  updateClientProfileInDb,
  withFirmDbClient
} from './firmDb.js';
import {
  buildHostOperationalFailureCertificate,
  persistHostReadinessAttempt
} from './runtimeReadiness.js';
import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';

const ATTEMPT_ACTION = 'entity.provisioning.attempt';
const INVALIDATED_ACTION = 'entity.readiness.invalidated';

const hostWaitShape = (saga) => ({
  state: saga?.state,
  reason_code: saga?.reason_code,
  attempt_count: Number(saga?.attempt_count),
  retry_state: saga?.retry_state,
  next_retry_at: saga?.next_retry_at ?? null
});

// A two-line spend journal in the exact shape buildLedgerJournalForTransaction
// hands the shared writer; both accounts are NEW names, so the writer's
// upsertLedgerAccountForJournal mints them (the F-21 trigger path).
const coherenceJournal = ({ clientId, sequence }) => {
  const memo = `Lane coherence probe posting ${sequence}`;
  const supplies = {
    role: 'counterparty',
    code: null,
    name: `Coherence probe supplies ${sequence}`,
    type: 'expense',
    normal_balance: 'debit'
  };
  const bank = {
    role: 'bank',
    code: null,
    name: `Coherence probe current account ${sequence}`,
    type: 'bank',
    normal_balance: 'debit'
  };
  const line = (account, direction) => ({
    account,
    direction,
    debit: direction === 'debit' ? 42 : 0,
    credit: direction === 'credit' ? 42 : 0,
    amount: 42,
    currency: 'GBP',
    memo
  });
  return {
    source_type: 'transaction',
    source_id: `${clientId}-coherence-tx-${sequence}`,
    journal_date: '2026-08-15',
    currency: 'GBP',
    status: 'posted',
    memo,
    direction: 'spend',
    amount: 42,
    accounts: [supplies, bank],
    lines: [line(supplies, 'debit'), line(bank, 'credit')]
  };
};

test(
  'real PG (appliance): host-caused failures are budget-free and heal on the first PASS; the fence ignores admitted writes and still catches foreign ones',
  { skip: applianceHarnessSkipReason({ dark: ['anthropic'] }) },
  async () => {
    const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: false } });
    try {
      const { firmId } = appliance;
      const bootHost = await appliance.read.host();
      assert.equal(bootHost?.status, 'PASS', JSON.stringify(bootHost));
      assert.equal(appliance.runtime.schedulerRunning(), true, 'Host A admitted the scheduler');

      const readinessOf = (clientId) => appliance.read.readiness(clientId);
      const attemptsOf = (clientId) => appliance.read.audit({ clientId, action: ATTEMPT_ACTION });
      const invalidationsOf = (clientId) => appliance.read.audit({ clientId, action: INVALIDATED_ACTION });
      const projectionOf = async (clientId) => {
        const response = await appliance.api.request({ path: '/api/donna/firms/snapshot', auth: true });
        assert.equal(response.status, 200, response.text.slice(0, 300));
        return response.json?.clients?.find(({ id }) => id === clientId)?.runtime_readiness || null;
      };
      const retryRoute = (clientId) => appliance.api.request({
        method: 'POST',
        path: `/api/donna/firms/clients/${encodeURIComponent(clientId)}/readiness/retry`,
        auth: true,
        body: { firm_id: firmId }
      });
      const insertForeignAccount = async ({ clientId, name, guc = null }) => {
        await appliance.query('begin');
        try {
          if (guc != null) await appliance.query("select set_config('donna.admitted_generation', $1, true)", [guc]);
          await appliance.query(
            `insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, status, payload)
             values ($1, $2, $3, null, $4, 'expense', 'debit', 'active', '{}'::jsonb)`,
            [`${clientId}-foreign-${name.replace(/\W+/g, '-').toLowerCase()}`, firmId, clientId, name]
          );
          await appliance.query('commit');
        } catch (error) {
          await appliance.query('rollback').catch(() => {});
          throw error;
        }
      };

      // ── Two clients born under a PASS host ─────────────────────────────
      const { clientId: clientB, readiness: bornB } = await appliance.createClient();
      const { clientId: clientC, readiness: bornC } = await appliance.createClient();
      assert.equal(bornB?.state, 'ready', JSON.stringify(bornB));
      assert.equal(bornC?.state, 'ready', JSON.stringify(bornC));

      // ── (b) an ADMITTED posting that mints two chart accounts leaves the saga ready ──
      const readyDigestC = bornC.ready_dependency_digest;
      assert.ok(readyDigestC, 'a ready saga carries its generation digest');
      const posted = await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          const result = await __writeLedgerJournalRows({
            client,
            firmId,
            clientId: clientC,
            journal: coherenceJournal({ clientId: clientC, sequence: 1 }),
            payload: { source: 'rt09_lane_coherence_fixture' }
          });
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw error;
        }
      });
      assert.ok(posted, 'the admitted posting committed');
      const mintedAtPosting = await appliance.read.audit({ clientId: clientC, action: 'ledger.account.created_at_posting' });
      assert.equal(mintedAtPosting.length, 2, 'the posting minted both new accounts (the F-21 trigger fired twice)');
      const afterPostingC = await readinessOf(clientC);
      assert.equal(afterPostingC.state, 'ready', `an admitted write must not invalidate the generation that admitted it: ${JSON.stringify(hostWaitShape(afterPostingC))}`);
      assert.equal(afterPostingC.ready_dependency_digest, readyDigestC);
      assert.equal(afterPostingC.observed_dependency_digest, readyDigestC, 'the admission predicate still sees one unbroken generation');
      assert.deepEqual(await invalidationsOf(clientC), [], 'no entity.readiness.invalidated receipt for an admitted write');
      const scopedReceipts = await appliance.read.audit({ clientId: clientC, action: 'entity.readiness.admitted_write_scoped' });
      assert.equal(scopedReceipts.length, 2, 'each suppressed invalidation is receipted, never silent');
      assert.deepEqual(
        scopedReceipts.map(({ metadata }) => [metadata.dependency_table, metadata.dependency_operation, metadata.ready_dependency_digest]),
        [['ledger_accounts', 'insert', readyDigestC], ['ledger_accounts', 'insert', readyDigestC]]
      );

      // The next observation rolls the generation forward honestly: the
      // idempotent create replay (the real route) re-certifies the CURRENT
      // chart — code-less minted accounts are the sanctioned shape under the
      // unpinned intake profile — and closes on a new ready digest.
      const { readiness: recertifiedC } = await appliance.createClient({ id: clientC });
      assert.equal(recertifiedC.state, 'ready', JSON.stringify(hostWaitShape(recertifiedC)));
      assert.notEqual(recertifiedC.ready_dependency_digest, readyDigestC, 'the admitted chart growth is part of the next certified generation');
      assert.equal(Number(recertifiedC.attempt_count), 0);

      // ── The fence keys on the EXACT digest, at SQL level ───────────────
      const readyDigestB = bornB.ready_dependency_digest;
      await insertForeignAccount({ clientId: clientB, name: 'Scoped by exact digest', guc: readyDigestB });
      assert.equal((await readinessOf(clientB)).state, 'ready', 'a transaction carrying the exact ready digest is an admitted write');
      await insertForeignAccount({ clientId: clientB, name: 'Stale digest scopes nothing', guc: 'not-the-ready-generation' });
      const invalidatedB = await readinessOf(clientB);
      assert.equal(invalidatedB.state, 'failed', 'a stale admitted-generation value scopes nothing');
      assert.equal(invalidatedB.reason_code, 'entity_dependency_changed');
      assert.equal(invalidatedB.retry_state, 'scheduled');
      assert.equal(Number(invalidatedB.attempt_count), 0, 'a fresh episode opens');
      assert.ok(invalidatedB.next_retry_at, 'a dependency invalidation is immediately due');

      // ── (a) the host fails on a REQUIRED check; entity retries must not burn budget ──
      const failedHostCertificate = buildHostOperationalFailureCertificate({
        certificate: (await appliance.read.host()).certificate,
        checkId: 'database_schema',
        reasonCode: 'rt09_probe_host_down'
      });
      const failedHost = await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: failedHostCertificate,
        eventType: 'retry'
      });
      assert.equal(failedHost.status, 'FAIL');
      assert.equal((await appliance.read.host()).status, 'FAIL');

      // (a2) three operator Retry clicks (the real route) against the failed host.
      for (const click of [1, 2, 3]) {
        const response = await retryRoute(clientB);
        assert.equal(response.status, 200, `Retry click ${click} → ${response.status}: ${response.text.slice(0, 300)}`);
        assert.deepEqual(hostWaitShape(await readinessOf(clientB)), {
          state: 'failed',
          reason_code: 'host_certificate_not_pass',
          attempt_count: 0,
          retry_state: 'scheduled',
          next_retry_at: null
        }, `Retry click ${click} against a failed host charges nothing and schedules no clock`);
      }
      const hostWaitReceiptsB = (await attemptsOf(clientB))
        .filter(({ metadata }) => metadata?.earliest_failure?.reason_code === 'host_certificate_not_pass');
      assert.equal(hostWaitReceiptsB.length, 3, 'every host-wait attempt is still receipted');
      assert.deepEqual(
        hostWaitReceiptsB.map(({ metadata }) => [metadata.budget_charged, metadata.budget_exemption?.kind]),
        [[false, 'host_wait'], [false, 'host_wait'], [false, 'host_wait']]
      );
      const waitingProjection = await projectionOf(clientB);
      assert.equal(waitingProjection?.waiting_for_host, true, JSON.stringify(waitingProjection));
      assert.equal(waitingProjection.can_retry_now, false, 'the card offers no Retry while the runtime host is the blocker');
      assert.equal(waitingProjection.can_reopen, false);
      assert.equal(waitingProjection.label, 'Waiting for the runtime host');
      assert.equal(waitingProjection.responsible_system, 'donna_runtime');

      // (a1) a client BORN under the failed host.
      const { clientId: clientA, readiness: bornA } = await appliance.createClient();
      assert.deepEqual(hostWaitShape(bornA), {
        state: 'failed',
        reason_code: 'host_certificate_not_pass',
        attempt_count: 0,
        retry_state: 'scheduled',
        next_retry_at: null
      }, 'a birth under a failed host opens no clock and charges no budget');

      // ── The FIRST PASS renewal heals both, with no click ───────────────
      const renewal = await appliance.runtime.hostReadiness.renewNow();
      assert.equal(renewal?.status, 'PASS', JSON.stringify(renewal?.certificate?.checks?.map(({ id, status }) => [id, status])));
      assert.equal((await appliance.read.host()).status, 'PASS');
      for (const clientId of [clientA, clientB]) {
        const healed = await readinessOf(clientId);
        assert.equal(healed.state, 'ready', `${clientId} heals on the first PASS renewal: ${JSON.stringify(hostWaitShape(healed))}`);
        assert.equal(Number(healed.attempt_count), 0);
        assert.equal(healed.retry_state, 'idle');
      }
      assert.deepEqual(
        await appliance.read.audit({ action: 'entity.readiness.episode_reopened' }),
        [],
        'no reopen was needed — nothing was ever exhausted'
      );
      const healReceipts = (await attemptsOf(clientB)).filter(({ metadata }) => metadata.lifecycle === 'boot_heal_retry');
      assert.equal(healReceipts.length, 1, 'one heal attempt closed the episode');
      assert.equal(healReceipts[0].metadata.budget_charged, true, 'an entity-side observation is still budgeted');

      // ── (c) a FOREIGN profile edit still invalidates, as before ─────────
      await updateClientProfileInDb({
        firmId,
        clientId: clientC,
        profilePatch: { jurisdiction: 'AE' },
        actorId: appliance.memberId
      });
      const foreignEditC = await readinessOf(clientC);
      assert.equal(foreignEditC.state, 'failed');
      assert.equal(foreignEditC.reason_code, 'entity_dependency_changed');
      assert.equal(foreignEditC.retry_state, 'scheduled');
      assert.ok(foreignEditC.next_retry_at, 'a foreign invalidation stays immediately due');
      const foreignInvalidations = await invalidationsOf(clientC);
      assert.equal(foreignInvalidations.length, 1);
      assert.equal(foreignInvalidations[0].metadata.dependency_table, 'clients');
      assert.equal(foreignInvalidations[0].metadata.dependency_operation, 'update');
      const foreignProjection = await projectionOf(clientC);
      assert.equal(foreignProjection.waiting_for_host, false);
      assert.equal(foreignProjection.can_retry_now, true, 'an entity-side invalidation keeps the operator Retry');
    } finally {
      await appliance.stop();
    }
  }
);
