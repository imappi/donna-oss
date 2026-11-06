#!/usr/bin/env node
// AE-2 production comparison seam. Privileged document policy remains in
// server/donna/world; this adapter gives the persisted candidate journal to
// Donna's real AE VAT201 computation and reports exact parity plus named
// unsupported lanes. It never patches production output into a green score.

import { buildAeVatReturnFromLedgerLines } from '../server/donna/ae/vatReturn.js';
import { evaluateAeVatPeriodWorld, projectAeVatDocuments } from '../server/donna/world/aeVatPeriod.js';

export function compareAeVatWorldWithProduction(worldSpec) {
  const oracle = evaluateAeVatPeriodWorld(worldSpec);
  if (!oracle.ok) return { status: 'invalid_world', oracle, supportedParity: null, gaps: [] };

  const supportedDocuments = worldSpec.vatDocuments.filter((document) =>
    document.lane !== 'customs_declared_goods'
      && document.inputRecovery?.basis !== 'residual_standard_method');
  const supportedIds = new Set(supportedDocuments.map(({ id }) => id));
  const supportedLines = worldSpec.candidateJournalLines.filter(({ documentId }) => supportedIds.has(documentId));
  const expected = projectAeVatDocuments(supportedDocuments);
  const production = runProduction({ oracle, lines: supportedLines });
  const observed = normalizeProduction(production.vatReturn);
  const supportedParity = {
    status: JSON.stringify(observed) === JSON.stringify(normalizeExpected(expected)) ? 'pass' : 'fail',
    expected: normalizeExpected(expected),
    observed,
  };

  const gaps = [];
  for (const document of worldSpec.vatDocuments) {
    let gapId = null;
    if (document.lane === 'customs_declared_goods') gapId = 'customs_goods_box6_not_consumed_by_production_return';
    else if (document.inputRecovery?.basis === 'residual_standard_method') gapId = 'partial_input_recovery_not_representable_by_posting_code';
    if (!gapId) continue;
    const lines = worldSpec.candidateJournalLines.filter(({ documentId }) => documentId === document.id);
    let observedCode = null;
    let observedProjection = null;
    try {
      observedProjection = normalizeProduction(runProduction({ oracle, lines }).vatReturn);
    } catch (error) {
      observedCode = error.code || error.name;
    }
    gaps.push({
      gapId,
      documentId: document.id,
      status: 'production_incomplete',
      expectedProjection: normalizeExpected(projectAeVatDocuments([document])),
      observedCode,
      observedProjection,
    });
  }
  return { status: supportedParity.status === 'pass' ? 'pass_with_named_gaps' : 'fail', oracle, supportedParity, gaps };
}

function runProduction({ oracle, lines }) {
  return buildAeVatReturnFromLedgerLines({
    period: oracle.period,
    establishmentEmirate: oracle.establishmentEmirate,
    qualifyingEcommerceRegistrant: false,
    lines: lines.map((line, index) => ({
      journal_id: line.documentId,
      line_no: index + 1,
      debit: Number(line.debitAed),
      credit: Number(line.creditAed),
      account_type: line.accountType,
      tax_type: line.taxType,
      role: line.role || null,
    })),
  });
}

function normalizeExpected(projection) {
  return {
    standardRatedSupplies: projection.fields.standard_rated_supplies,
    reverseChargeSupplies: projection.fields.reverse_charge_supplies,
    goodsImports: projection.fields.goods_imports,
    standardRatedExpenses: projection.fields.standard_rated_expenses,
    reverseChargeExpenses: {
      amount: projection.fields.reverse_charge_expenses.amount,
      recoverable_vat: projection.fields.reverse_charge_expenses.recoverable_vat,
    },
    totals: projection.totals,
    netVat: projection.net_vat,
    outcome: projection.outcome,
  };
}

function normalizeProduction(vatReturn) {
  return {
    standardRatedSupplies: {
      by_emirate: Object.fromEntries(Object.entries(vatReturn.fields.standard_rated_supplies.by_emirate)
        .map(([key, value]) => [key, pair(value.amount, value.vat)])),
      total: pair(vatReturn.fields.standard_rated_supplies.total.amount, vatReturn.fields.standard_rated_supplies.total.vat),
    },
    reverseChargeSupplies: pair(vatReturn.fields.reverse_charge_supplies.amount, vatReturn.fields.reverse_charge_supplies.vat),
    goodsImports: pair(vatReturn.fields.goods_imports.amount, vatReturn.fields.goods_imports.vat),
    standardRatedExpenses: {
      amount: fixed(vatReturn.fields.standard_rated_expenses.amount),
      recoverable_vat: fixed(vatReturn.fields.standard_rated_expenses.recoverable_vat),
    },
    reverseChargeExpenses: {
      amount: fixed(vatReturn.fields.reverse_charge_expenses.amount),
      recoverable_vat: fixed(vatReturn.fields.reverse_charge_expenses.recoverable_vat),
    },
    totals: {
      output_vat: fixed(vatReturn.totals.output_vat),
      recoverable_vat: fixed(vatReturn.totals.recoverable_vat),
    },
    netVat: fixed(vatReturn.netVat),
    outcome: vatReturn.outcome,
  };
}

function pair(amount, vat) { return { amount: fixed(amount), vat: fixed(vat) }; }
function fixed(value) { return Number(value).toFixed(2); }
