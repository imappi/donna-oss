#!/usr/bin/env node
// The Kultalanka coding-only view (plan §8.7): the 36 bank lines as FIK-3
// cases, so the Finnish coding lane (`--lane=fi-coding --corpus=
// fi-kultalanka-2025-02-coding`) can run them on single-line disposable books.
// DEVELOPMENT ONLY: one entity, one month — never a holdout.
//
// The corpus is DERIVED from the month's label file; it is committed because
// FIK-3 freezes a corpus by its digest, and `--check` (run by the tests)
// refuses any drift from the labels. The FIK-3 book seeds one source per line,
// so a line settled by several sources, a refund group, the Nets report rows,
// a payslip or a loan schedule is a `source` gap: it stays in the operational
// denominator as incomplete work and is never credited.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './jev_decision_plane_protocol.js';
import { loadKultalankaLabels, goldRole, OPERATOR_REVIEWER } from './fi_kultalanka_eval.js';

export const CODING_VIEW_CORPUS = 'fi-kultalanka-2025-02-coding';
export const CODING_VIEW_DIR = resolve(ROOT, 'data/evals/fixtures', CODING_VIEW_CORPUS);
// The single account the FIK-3 book reads for each key account (the posting
// path's account code, else its palette name), and the ALV code the writer
// stamps where the key says "veroton" (unopted rent and insurance are exempt;
// fees and settlements are outside ALV; allocation components post NONE).
// FIK-3 compares exact accounts; the month scorer is authoritative for the
// crosswalk's wider acceptance sets.
export const FIK3_ACCOUNT = Object.freeze({ 1910: '1910', 1700: 'Myyntisaamiset', 1760: '2940', 2939: '2939', 1930: 'Payroll withholding and employer health-insurance payable',
  1940: 'Payroll withholding and employer health-insurance payable', 1950: 'TyEL and payroll contributions payable', 1955: 'TyEL and payroll contributions payable', 2620: 'Loan payable', 3000: 'Sales',
  3010: 'Sales', 3580: 'Interest income', 4010: 'Rent', 4080: 'Travel', 4140: 'Utilities', 4340: 'Operating supplies', 4351: 'Operating supplies', 4540: 'Office expenses', 4560: 'Telecommunications',
  5000: 'Payroll', 5210: 'Meals and entertainment', 5460: 'Insurance', 5560: 'Software subscriptions', 5570: 'Marketing', 5960: 'Meals and entertainment', 5990: 'Bank fees', 7020: 'Operating supplies',
  7090: 'Owner drawings', 8810: 'Interest expense', 'NETS-PALKKIO': 'Platform and processor fees' });
export const FIK3_VEROTON = Object.freeze({ 4010: 'ALV_EXEMPT', 5460: 'ALV_EXEMPT', 5960: 'ALV_EXEMPT', 5990: 'ALV_OUT_OF_SCOPE', 1930: 'ALV_OUT_OF_SCOPE', 1940: 'ALV_OUT_OF_SCOPE', 1950: 'ALV_OUT_OF_SCOPE',
  1955: 'ALV_OUT_OF_SCOPE', 3580: 'ALV_OUT_OF_SCOPE', 'NETS-PALKKIO': 'NONE', 8810: 'NONE', 2620: 'NONE' });
const SEEDABLE = new Set(['supplier_bill', 'sales_invoice', 'receipt']);

const fik3Journal = (labels, journal) => journal.filter(l => !labels.crosswalk.find(x => x.key_account === l.account).accept.represented_by_alv_code).map(l => ({
  role: goldRole(l) === 'counterparty' ? 'counterparty' : goldRole(l), account: FIK3_ACCOUNT[l.account], direction: l.direction, amount: l.amount,
  tax_code: l.alv === 'exempt' ? (FIK3_VEROTON[l.account] ?? 'ALV_EXEMPT') : l.alv === 'none' ? (['1930', '1940', '1950', '1955'].includes(l.account) ? 'ALV_OUT_OF_SCOPE' : 'NONE') : labels.alv_classes[l.alv][0]
}));
const fik3Ask = ask => ({ evidence_type: ask.evidence_type, ...(ask.kinds?.length === 1 ? { kind: ask.kinds[0] } : {}) });
const fik3Gold = (labels, gold) => gold.terminal === 'ask_owner' ? { terminal: 'ask_owner', journal: [], ask: fik3Ask(gold.ask) } : { terminal: 'posted', journal: fik3Journal(labels, gold.journal), ask: null };

export function buildCodingCases(labels = loadKultalankaLabels()) {
  return labels.lines.filter(l => l.bank).map(line => {
    const group = line.group ? labels.groups.find(g => g.id === line.group) : null;
    const docs = line.source_files.map(f => labels.documents.find(d => d.file === f)).filter(Boolean);
    const gap = group ? `refund group ${group.id}: the gold spans ${group.members.join(', ')}; the FIK-3 book seeds one line`
      : line.decision_class === 'processor_settlement' ? 'the Nets report settles by row; the FIK-3 book cannot seed a settlement row'
      : line.source_files.length > 1 ? `settled by ${line.source_files.length} sources; the FIK-3 book seeds one`
      : line.source_files.length === 1 && !docs.length ? 'its source (payslip or loan schedule) is not a seedable FIK-3 document type' : null;
    // The key prints no complete journal for B08/B16/B21/B27: the original slot
    // carries the adjudicated gross-up or the group gold so the case validates;
    // those cases are source gaps and are never scored.
    const originalGold = line.original.journal === null ? { ...line.original, journal: line.proposed_gold ?? line.adjudicated?.journal ?? group.gold } : line.original;
    const doc = docs.length === 1 && SEEDABLE.has(docs[0].document_type) && !gap ? docs[0] : null;
    const a = line.adjudication;
    return {
      id: `kl-${line.id.toLowerCase()}`, title: `Kultalanka 02/2025 ${line.key_row}`, split: 'development', family: `kultalanka-${line.decision_class}`, entity: 'kampaamo-kultalanka-oy', period: '2025-02',
      decision_class: line.decision_class, strong_is_alternative: true,
      book: { entity_type: 'fi-oy', company_name: labels.entity.company_name, accounting_basis: labels.entity.accounting_basis }, facts: [],
      transaction: { date: line.bank.date, description: `${line.bank.kind} ${line.bank.counterparty} ${line.bank.message}`, money_in: line.bank.direction === 'in' ? line.bank.amount : 0, money_out: line.bank.direction === 'out' ? line.bank.amount : 0, currency: 'EUR' },
      document: doc ? { document_type: doc.document_type, party: doc.party, total_amount: doc.total_amount, tax_amount: doc.tax_amount, lines: doc.lines, match_status: 'auto_matched' } : null,
      labels: { original: fik3Gold(labels, originalGold), adjudicated: a.status === 'adjudicated' ? fik3Gold(labels, line.adjudicated) : null,
        adjudication: a.status === 'adjudicated' ? { status: 'adjudicated', reviewer: OPERATOR_REVIEWER, date: a.date } : { status: a.status } },
      expressible: gap ? { status: 'gap', gap: 'source', detail: gap } : { status: 'expressible' },
      derived_from: { labels: `${labels.pack}/labels.json`, line: line.id, ...(line.original.journal === null ? { original_note: 'The key prints no complete journal for this line; the original slot carries the adjudicated journal or group gold and the case is never scored.' } : {}) }
    };
  });
}
const render = c => JSON.stringify(c, null, 2) + '\n';
export function checkCodingCorpus(labels = loadKultalankaLabels()) {
  const want = new Map(buildCodingCases(labels).map(c => [`${c.id}.json`, render(c)]));
  const have = readdirSync(CODING_VIEW_DIR).filter(f => f.endsWith('.json'));
  const drift = [...new Set([...want.keys(), ...have])].filter(f => !have.includes(f) || want.get(f) !== readFileSync(join(CODING_VIEW_DIR, f), 'utf8'));
  return drift.sort();
}
export function writeCodingCorpus(labels = loadKultalankaLabels()) {
  rmSync(CODING_VIEW_DIR, { recursive: true, force: true });
  mkdirSync(CODING_VIEW_DIR, { recursive: true });
  for (const c of buildCodingCases(labels)) writeFileSync(join(CODING_VIEW_DIR, `${c.id}.json`), render(c));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--write')) writeCodingCorpus();
  const drift = checkCodingCorpus();
  if (drift.length) { console.error(`coding view out of date: ${drift.join(', ')} (run with --write)`); process.exitCode = 2; }
  else console.log(`${CODING_VIEW_CORPUS}: in sync`);
}
