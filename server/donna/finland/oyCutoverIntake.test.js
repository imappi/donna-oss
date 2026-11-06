import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OY_CUTOVER_PHASES,
  OY_CUTOVER_DOCUMENTS,
  OY_CUTOVER_BLOCKER_SURFACE,
  OY_CUTOVER_BLOCKER_REASON_CODE,
  evaluateOyCutoverIntake,
  labelForCutoverDocument,
  mintOyCutoverBlocker
} from './oyCutoverIntake.js';

const makeClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      for (const h of handlers) {
        if (sql.includes(h.match)) {
          if (h.throw) throw h.throw;
          return h.rows ? { rows: h.rows } : { rows: [] };
        }
      }
      return { rows: [{ id: 'stat-blocker-x', inserted: true, status: 'open', maybe_reopened: false }] };
    }
  };
};

// The full material-document key set (every 'material' doc) — a complete cutover.
const allMaterialKeys = OY_CUTOVER_DOCUMENTS
  .filter((d) => d.materiality === 'material')
  .map((d) => d.key);

test('the catalog is closed, phased, and well-formed', () => {
  assert.deepEqual(OY_CUTOVER_PHASES, ['essential', 'reconciliation', 'tax_foundation', 'governance']);
  const keys = OY_CUTOVER_DOCUMENTS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate document keys');
  for (const d of OY_CUTOVER_DOCUMENTS) {
    assert.ok(OY_CUTOVER_PHASES.includes(d.phase), `${d.key} phase`);
    assert.ok(['material', 'recommended'].includes(d.materiality), `${d.key} materiality`);
    assert.ok(['always', 'conditional'].includes(d.applicability), `${d.key} applicability`);
    assert.ok(d.name_fi && d.name_en, `${d.key} needs both names`);
  }
});

test('an empty intake refuses opening balances and mints a blocker directive on the accountant', () => {
  const verdict = evaluateOyCutoverIntake({ provided: [], notApplicable: [] });
  assert.equal(verdict.opening_balance_ready, false);
  assert.ok(verdict.missing_material.length > 0);
  assert.ok(verdict.blocker && verdict.blocker.should_mint);
  assert.equal(verdict.blocker.surface, OY_CUTOVER_BLOCKER_SURFACE);
  assert.equal(verdict.blocker.reason_code, OY_CUTOVER_BLOCKER_REASON_CODE);
  assert.equal(verdict.blocker.severity, 'review_required');
  assert.equal(verdict.blocker.assigned_to, 'accountant');
  // Two-terminal-states: the refusal is durable work, not a bare warning.
  assert.deepEqual(verdict.blocker.missing_material, verdict.missing_material);
});

test('supplying every material document makes opening balances ready with no blocker', () => {
  const verdict = evaluateOyCutoverIntake({ provided: allMaterialKeys });
  assert.equal(verdict.opening_balance_ready, true);
  assert.equal(verdict.blocker, null);
  assert.deepEqual(verdict.missing_material, []);
  // Every phase reports complete.
  for (const p of verdict.phases) assert.equal(p.complete, true, `${p.phase} should be complete`);
});

test('a not-applicable mark drops a CONDITIONAL material document from the requirement', () => {
  // Provide everything except a conditional material doc, and mark it N/A.
  const provided = allMaterialKeys.filter((k) => k !== 'loan_schedules');
  const verdict = evaluateOyCutoverIntake({ provided, notApplicable: ['loan_schedules'] });
  assert.equal(verdict.opening_balance_ready, true, 'N/A conditional doc should not block');
  assert.ok(verdict.not_applicable.includes('loan_schedules'));
  assert.ok(verdict.blocker === null);
});

test('a not-applicable mark does NOT drop an ALWAYS-applicable material document', () => {
  const provided = allMaterialKeys.filter((k) => k !== 'articles_of_association');
  const verdict = evaluateOyCutoverIntake({ provided, notApplicable: ['articles_of_association'] });
  // articles_of_association is applicability 'always' — the N/A mark is ignored.
  assert.equal(verdict.opening_balance_ready, false);
  assert.ok(verdict.missing_material.includes('articles_of_association'));
});

test('a missing RECOMMENDED document does not block but is reported', () => {
  // prepayments is recommended + conditional; omit it, provide all material.
  const verdict = evaluateOyCutoverIntake({ provided: allMaterialKeys });
  assert.equal(verdict.opening_balance_ready, true);
  assert.ok(verdict.missing_recommended.includes('prepayments'));
});

test('phase completeness tracks the missing material documents per phase', () => {
  // Provide only the essential-phase material docs.
  const essentialMaterial = OY_CUTOVER_DOCUMENTS
    .filter((d) => d.phase === 'essential' && d.materiality === 'material')
    .map((d) => d.key);
  const verdict = evaluateOyCutoverIntake({ provided: essentialMaterial });
  const essential = verdict.phases.find((p) => p.phase === 'essential');
  assert.equal(essential.complete, true);
  const taxFoundation = verdict.phases.find((p) => p.phase === 'tax_foundation');
  assert.equal(taxFoundation.complete, false);
  assert.ok(taxFoundation.missing_material.length > 0);
});

test('labelForCutoverDocument resolves a key and returns null for an unknown one', () => {
  assert.equal(labelForCutoverDocument('nope'), null);
  const label = labelForCutoverDocument('carried_loss_position');
  assert.ok(label.name_fi && label.name_en);
});

test('mintOyCutoverBlocker mints the blocker for an incomplete set and no-ops when ready', async () => {
  const ready = evaluateOyCutoverIntake({ provided: allMaterialKeys });
  assert.equal(await mintOyCutoverBlocker({ client: makeClient(), firmId: 'f', clientId: 'c', verdict: ready }), null);

  const incomplete = evaluateOyCutoverIntake({ provided: [] });
  const client = makeClient();
  const result = await mintOyCutoverBlocker({ client, firmId: 'f', clientId: 'c', verdict: incomplete });
  assert.ok(result && result.id, 'mint returns a blocker id');
  // It routed through statutory_blockers with the cutover surface + reason.
  const insert = client.calls.find((c) => c.sql.includes('insert into statutory_blockers'));
  assert.ok(insert, 'a statutory_blockers insert was issued');
  assert.ok(insert.params.includes(OY_CUTOVER_BLOCKER_REASON_CODE));
  assert.ok(insert.params.includes(OY_CUTOVER_BLOCKER_SURFACE));
});

test('mintOyCutoverBlocker soft-fails to null before migration 076 (42P01)', async () => {
  const incomplete = evaluateOyCutoverIntake({ provided: [] });
  const dead = makeClient([{ match: 'insert into statutory_blockers', throw: Object.assign(new Error('missing'), { code: '42P01' }) }]);
  assert.equal(await mintOyCutoverBlocker({ client: dead, firmId: 'f', clientId: 'c', verdict: incomplete }), null);
});
