import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OBLIGATION_NON_POSTING_POLICY,
  isObligationDerived,
  enforceNonPostingPolicy,
  buildObligationRows,
  writeObligationsForContractSql
} from './contractObligations.js';

describe('contractObligations', () => {
  // ── Non-posting policy ───────────────────────────────────────────

  it('OBLIGATION_NON_POSTING_POLICY has correct shape', () => {
    assert.deepEqual(OBLIGATION_NON_POSTING_POLICY.allowed_statuses, ['suggested', 'suggested_pending_audit']);
    assert.equal(OBLIGATION_NON_POSTING_POLICY.auto_match_passed, false);
    assert.equal(OBLIGATION_NON_POSTING_POLICY.blocker, 'obligation_derived_requires_human_confirm');
  });

  it('isObligationDerived returns true for contract_obligation_reconciliation source', () => {
    assert.equal(
      isObligationDerived({ payload: { source: 'contract_obligation_reconciliation' } }),
      true
    );
  });

  it('isObligationDerived returns false for other sources', () => {
    assert.equal(isObligationDerived({ payload: { source: 'receipt_reconciliation' } }), false);
    assert.equal(isObligationDerived({ payload: {} }), false);
    assert.equal(isObligationDerived({}), false);
    assert.equal(isObligationDerived(null), false);
  });

  it('enforceNonPostingPolicy forces suggested_pending_audit on obligation matches', () => {
    const match = {
      id: 'm1',
      status: 'auto_matched',
      payload: {
        source: 'contract_obligation_reconciliation',
        auto_match_passed: true
      }
    };
    const enforced = enforceNonPostingPolicy(match);
    assert.equal(enforced.status, 'suggested_pending_audit');
    assert.equal(enforced.payload.auto_match_passed, false);
    assert.equal(enforced.payload.blocker, 'obligation_derived_requires_human_confirm');
    assert.equal(enforced.payload.source, 'contract_obligation_reconciliation');
  });

  it('enforceNonPostingPolicy passes through non-obligation matches unchanged', () => {
    const match = {
      id: 'm2',
      status: 'auto_matched',
      payload: { source: 'receipt_reconciliation' }
    };
    const result = enforceNonPostingPolicy(match);
    assert.equal(result.status, 'auto_matched');
    assert.equal(result, match);
  });

  // ── buildObligationRows ──────────────────────────────────────────

  it('buildObligationRows generates deterministic ids', () => {
    const rows = buildObligationRows({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: [
        { obligation_type: 'rent', payer: 'Acme', payee: 'Landlord', frequency: 'monthly', amount: 5000, currency: 'GBP' },
        { obligation_type: 'deposit', payer: 'Acme', payee: 'Landlord', frequency: 'one_time', amount: 10000, currency: 'GBP' }
      ]
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].firm_id, 'f1');
    assert.equal(rows[0].client_id, 'c1');
    assert.equal(rows[0].document_id, 'doc1');
    assert.equal(rows[0].obligation_type, 'rent');
    assert.equal(rows[0].amount, 5000);
    assert.equal(rows[1].obligation_type, 'deposit');
    assert.equal(rows[1].amount, 10000);

    const rows2 = buildObligationRows({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: [
        { obligation_type: 'rent', amount: 5000 }
      ]
    });
    assert.equal(rows[0].id, rows2[0].id, 'same document + index produces same id');
  });

  it('buildObligationRows returns empty array for no obligations', () => {
    assert.deepEqual(buildObligationRows({ firmId: 'f', clientId: 'c', documentId: 'd' }), []);
    assert.deepEqual(buildObligationRows({ firmId: 'f', clientId: 'c', documentId: 'd', obligations: [] }), []);
  });

  it('buildObligationRows defaults payer_role/payee_role to party', () => {
    const rows = buildObligationRows({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: [{ obligation_type: 'rent', amount: 1000 }]
    });
    assert.equal(rows[0].payer_role, 'party');
    assert.equal(rows[0].payee_role, 'party');
  });

  it('buildObligationRows wraps source_evidence as { snippet }', () => {
    const rows = buildObligationRows({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: [{ obligation_type: 'rent', amount: 1000, source_evidence: 'clause 4.1' }]
    });
    assert.deepEqual(rows[0].source_evidence, { snippet: 'clause 4.1' });
  });

  it('buildObligationRows handles null source_evidence', () => {
    const rows = buildObligationRows({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: [{ obligation_type: 'rent', amount: 1000, source_evidence: null }]
    });
    assert.deepEqual(rows[0].source_evidence, {});
  });

  // ── writeObligationsForContractSql ────────────────────────────────

  it('writeObligationsForContractSql generates delete + insert SQL', () => {
    const result = writeObligationsForContractSql({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: [
        { obligation_type: 'rent', payer: 'Acme', payee: 'Owner', amount: 3000, currency: 'GBP', frequency: 'monthly' }
      ]
    });
    assert.ok(result.deleteSql.includes('DELETE FROM document_obligations'));
    assert.deepEqual(result.deleteParams, ['f1', 'doc1']);
    assert.ok(result.insertSql.includes('INSERT INTO document_obligations'));
    assert.ok(result.insertSql.includes('ON CONFLICT'));
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].obligation_type, 'rent');
  });

  it('writeObligationsForContractSql returns null sql for empty obligations', () => {
    const result = writeObligationsForContractSql({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: []
    });
    assert.equal(result.sql, null);
    assert.deepEqual(result.rows, []);
  });

  it('writeObligationsForContractSql handles multiple obligations', () => {
    const result = writeObligationsForContractSql({
      firmId: 'f1',
      clientId: 'c1',
      documentId: 'doc1',
      obligations: [
        { obligation_type: 'rent', amount: 3000, frequency: 'monthly' },
        { obligation_type: 'deposit', amount: 6000, frequency: 'one_time' },
        { obligation_type: 'insurance_premium', amount: 500, frequency: 'annual' }
      ]
    });
    assert.equal(result.rows.length, 3);
    assert.ok(result.insertSql.includes('VALUES'));
    const valueCount = (result.insertSql.match(/\)/g) || []).length;
    assert.ok(valueCount >= 3, 'multiple value rows');
  });
});
