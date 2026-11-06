// Kampaamo Kultalanka Oy, February 2025 — the automated, repeatable scoring of
// the Finnish test pack (data/evals/fixtures/fi-kultalanka-2025-02). Plan:
// docs/plan-2026-09-22-fi-jev-decision-knowledge.md §8.7. Pure functions only:
// label validation, the section-C arithmetic, and the line-by-line score of a
// book snapshot. It replaces the hand scoring from untracked laptop scripts.
//
// Reuse, not a second scorer: each bank line is translated through the
// label file's crosswalk into a FIK-3 case and scored by the FIK-3 consequence
// scorer (`scoreFiOutcome`, `attributeFiError`, `armSummary`); the ALV
// economics come from the production return builder
// (`buildAlvReturnFromLedgerLines`). What is added here is only what a whole
// month needs and a single FIK-3 case does not: finding each label's bank row
// and sources in a real book, the key-account crosswalk, refund groups,
// several journals per line, and the section-C comparison.
//
// Labels: the answer key verbatim as the ORIGINAL label; Ilkka's 2026-09-24
// adjudications as the ADJUDICATED label; anything else where the key and the
// running tree disagree is DISPUTED (no gold; excluded from accuracy, kept in
// the operational denominator as incomplete work). Nothing here is writer
// authority or a production terminal.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { hash } from '../server/donna/jevEvidenceContract.js';
import { buildAlvReturnFromLedgerLines } from '../server/donna/finland/alvReturn.js';
import { ROOT } from './jev_decision_plane_protocol.js';
import { scoreFiOutcome, attributeFiError, armSummary, interruptionClass } from './jev_decision_plane_fi.js';

export const KULTALANKA_PACK = 'fi-kultalanka-2025-02';
export const KULTALANKA_DIR = resolve(ROOT, 'data/evals/fixtures', KULTALANKA_PACK);
export const LABELS_VERSION = 'fi-kultalanka-labels-v1';
export const SCORE_VERSION = 'fi-kultalanka-score-v1';
export const OPERATOR_REVIEWER = 'Ilkka Halonen (operator; not professional review)';
export const PERIOD = Object.freeze({ key: '2025-02', start: '2025-02-01', end: '2025-02-28' });
export const loadKultalankaLabels = (dir = KULTALANKA_DIR) => JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
export const labelsDigest = labels => hash(labels);

const fail = code => { throw new Error(code); };
const str = v => typeof v === 'string' && v.trim().length > 0;
const iso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const cents = n => Math.round(Number(n) * 100);
const eur = c => c / 100;
const signed = l => (l.direction === 'debit' ? 1 : -1) * cents(l.amount);
const TERMINALS = ['posted', 'ask_owner'];
const STATUSES = ['agreed', 'adjudicated', 'disputed'];

// ── Key-space journals ──────────────────────────────────────────────────────
// A label line is { account (key chart), direction, amount, alv (class) } with
// an optional role; the role the posting path writes is derived from the key
// account (bank leg, input/output ALV legs), else the base line.
const DEFAULT_ROLES = Object.freeze({ 1910: 'bank', 1760: 'alv_input_deductible', 1761: 'alv_input_deductible', 2937: 'alv_output', 2939: 'alv_output' });
export const goldRole = l => l.role ?? DEFAULT_ROLES[l.account] ?? 'counterparty';
export const journalBalances = journal => Array.isArray(journal) && journal.length > 0 && journal.reduce((t, l) => t + signed(l), 0) === 0;
const legOn = (journal, account) => journal.filter(l => l.account === account).reduce((t, l) => t + signed(l), 0);
const lineSigned = line => (line.bank ? (line.bank.direction === 'in' ? 1 : -1) * cents(line.bank.amount) : 0);
const journalsOf = labels => [
  ...labels.lines.flatMap(l => [l.original?.journal, l.adjudicated?.journal, l.proposed_gold, ...(l.representation_alternatives || []).map(a => a.journal)]),
  ...labels.groups.map(g => g.gold)
].filter(j => Array.isArray(j) && j.length);

// The gold a line is scored against: none for a disputed line; a group's
// shared gold for a group member; else the adjudicated label, else the original.
export function goldOfLine(labels, line) {
  if (line.adjudication.status === 'disputed') return null;
  const group = line.group ? labels.groups.find(g => g.id === line.group) : null;
  if (group) return { terminal: 'posted', journal: group.gold, ask: null, group: group.id, alternatives: [] };
  const gold = line.adjudicated ?? line.original;
  return { ...gold, group: null, alternatives: (line.representation_alternatives || []).map(a => a.journal) };
}

// ── Validation ──────────────────────────────────────────────────────────────
export function validateLabels(labels, { sourceDir = null } = {}) {
  const bad = why => fail(`invalid_kultalanka_labels:${why}`);
  if (labels?.version !== LABELS_VERSION || labels.pack !== KULTALANKA_PACK) bad('version');
  const e = labels.entity;
  if (!e || e.entity_type !== 'fi-oy' || e.period !== PERIOD.key || !Number.isFinite(e.bank?.opening) || !Number.isFinite(e.bank?.closing)) bad('entity');
  const ids = new Set();
  const bankLines = labels.lines.filter(l => l.bank);
  if (bankLines.length !== 36 || labels.lines.length !== 37) bad('line_count');
  bankLines.forEach((l, i) => { if (l.bank.statement_row !== i + 1 || !iso(l.bank.date) || !(l.bank.amount > 0) || !['in', 'out'].includes(l.bank.direction)) bad(`bank_row:${l.id}`); });
  if (cents(e.bank.opening) + bankLines.reduce((t, l) => t + lineSigned(l), 0) !== cents(e.bank.closing)) bad('bank_rows_do_not_reach_closing_balance');
  const accounts = new Map(labels.crosswalk.map(x => [x.key_account, x]));
  if (accounts.size !== labels.crosswalk.length || labels.crosswalk.some(x => !str(x.key_name) || !x.accept || !Object.values(x.accept).some(v => v === true || (Array.isArray(v) && v.length)))) bad('crosswalk');
  const covered = journal => journal.every(l => accounts.has(l.account) && labels.alv_classes[l.alv] && ['debit', 'credit'].includes(l.direction) && cents(l.amount) > 0);
  for (const journal of journalsOf(labels)) {
    if (!covered(journal)) bad('crosswalk_coverage');
    if (!journalBalances(journal)) bad('journal_does_not_balance');
  }
  const validAsk = a => a && str(a.evidence_type) && (a.kinds === undefined || (Array.isArray(a.kinds) && a.kinds.every(k => /^ask_[a-z_]+$/.test(k))))
    && (a.also === undefined || a.also.every(x => str(x.evidence_type)));
  const validGold = (g, line) => {
    if (!g || !TERMINALS.includes(g.terminal)) return false;
    if (g.terminal === 'ask_owner') return validAsk(g.ask) && Array.isArray(g.journal) && g.journal.length === 0;
    if (g.journal === null) return str(g.incomplete);
    // A posted bank line's journal moves the bank by exactly the statement amount.
    return !line.bank || legOn(g.journal, '1910') === lineSigned(line);
  };
  for (const line of labels.lines) {
    if (!str(line.id) || ids.has(line.id)) bad('line_id'); ids.add(line.id);
    if (!line.verbatim || !str(line.key_row) || !str(line.decision_class)) bad(`line_text:${line.id}`);
    if (!validGold(line.original, line)) bad(`original:${line.id}`);
    const a = line.adjudication;
    if (!STATUSES.includes(a?.status)) bad(`adjudication:${line.id}`);
    if (a.status === 'adjudicated' && (a.reviewer !== OPERATOR_REVIEWER || !iso(a.date) || !str(a.reason) || !validGold(line.adjudicated, line))) bad(`adjudicated:${line.id}`);
    if (a.status !== 'adjudicated' && line.adjudicated !== null) bad(`adjudicated_without_adjudication:${line.id}`);
    if (a.status === 'disputed' && (!str(a.reason) || !['ilkka', 'claude_for_ilkka'].includes(a.raised_by) || (a.raised_by === 'ilkka') !== (a.reviewer === OPERATOR_REVIEWER))) bad(`dispute:${line.id}`);
    if (a.status === 'disputed' && !a.tree_position?.citations?.length) bad(`dispute_without_tree_citation:${line.id}`);
    if (line.original.journal === null && !line.group && a.status === 'agreed') bad(`incomplete_original_without_gold:${line.id}`);
    for (const alt of line.representation_alternatives || []) if (!str(alt.basis) || legOn(alt.journal, '1910') !== lineSigned(line)) bad(`alternative:${line.id}`);
    if (line.proposed_gold && (a.status !== 'disputed' || (line.bank && legOn(line.proposed_gold, '1910') !== lineSigned(line)))) bad(`proposal:${line.id}`);
    for (const f of line.source_files) if (!labels.sources.some(s => s.file === f)) bad(`unknown_source:${line.id}`);
  }
  for (const g of labels.groups) {
    const members = labels.lines.filter(l => l.group === g.id);
    if (!str(g.derivation) || hash(members.map(m => m.id).sort()) !== hash([...g.members].sort())) bad(`group:${g.id}`);
    if (legOn(g.gold, '1910') !== members.reduce((t, m) => t + lineSigned(m), 0)) bad(`group_bank:${g.id}`);
  }
  if (labels.sources.length !== 28 || !labels.sources.some(s => s.file === labels.answer_key.file)) bad('sources');
  if (sourceDir) for (const s of labels.sources) if (createHash('sha256').update(readFileSync(join(sourceDir, s.file))).digest('hex') !== s.sha256) bad(`source_digest:${s.file}`);
  if (hash(computeSectionC(labels)) !== hash(labels.section_c.adjudicated)) bad('section_c_arithmetic');
  return { lines: labels.lines.length, bank_lines: bankLines.length, by_status: Object.fromEntries(STATUSES.map(s => [s, labels.lines.filter(l => l.adjudication.status === s).map(l => l.id)])) };
}

// ── Section C: the adjudicated monthly expectations ─────────────────────────
// Each original section-C figure is the sum of its recorded contributions.
// A contribution from a disputed line (or a C-level dispute) stays undecided;
// one from a line Ilkka adjudicated to an owner question is pending at rest (the
// line posts nothing until the owner answers); the rest is decided. The
// adjudicated figure at rest is the decided sum; the key's position adds the
// undecided contributions back. Line-sourced amounts are re-derived from the
// line's own key journal so a label edit cannot drift from its arithmetic.
export const C_FIGURES = Object.freeze(['sales_net', 'output_vat', 'input_vat_deductible', 'reverse_charge_vat', 'nets_fees']);
const FIGURE_OF = {
  sales_net: j => -(legOn(j, '3000') + legOn(j, '3010')),
  output_vat: j => -j.filter(l => goldRole(l) === 'alv_output' && l.account === '2939').reduce((t, l) => t + signed(l), 0),
  input_vat_deductible: j => legOn(j, '1760'),
  reverse_charge_vat: j => legOn(j, '1761'),
  nets_fees: j => legOn(j, 'NETS-PALKKIO')
};
const contributionStatus = (labels, c) => {
  if (c.c_dispute) return 'disputed';
  // A document recognised when issued (accrual) is decided whatever its
  // settling bank line's adjudication: the line only clears the receivable.
  if (c.recognition === 'on_issue') return 'decided';
  const lines = c.lines.map(id => labels.lines.find(l => l.id === id) || fail(`invalid_kultalanka_labels:contribution_line:${id}`));
  if (lines.some(l => l.adjudication.status === 'disputed')) return 'disputed';
  if (lines.some(l => l.adjudication.status === 'adjudicated' && l.adjudicated.terminal === 'ask_owner')) return 'pending_owner';
  return 'decided';
};
const keyJournalOf = (labels, id) => {
  const line = labels.lines.find(l => l.id === id);
  const group = line.group && labels.groups.find(g => g.id === line.group);
  return group ? group.gold : line.original.journal;
};
const fmt = c => (c / 100).toFixed(2).replace('.', ',');
// A capability gap is decided gold the tree cannot yet produce (CG-1: an
// uploaded sales invoice recognised when issued). Its figures are part of the
// at-rest expectation, so a book omitting them fails; the gap only NAMES the
// shortfall. Its amounts must equal the contributions that carry it.
const GAP_FIGURES = Object.freeze({ sales_net: 'amount_sales', output_vat: 'amount_output_vat' });
function gapItems(labels, figure, parts) {
  const gaps = labels.section_c.capability_gaps || [];
  for (const c of parts.filter(x => x.capability_gap)) {
    const gap = gaps.find(g => g.id === c.capability_gap);
    if (!gap || c.recognition !== 'on_issue' || c.c_dispute) fail(`invalid_kultalanka_labels:capability_gap:${c.capability_gap}`);
  }
  return gaps.map(g => {
    const amount = parts.filter(c => c.capability_gap === g.id).reduce((t, c) => t + cents(c.amount), 0);
    if (amount !== cents(g[GAP_FIGURES[figure]] ?? 0)) fail(`invalid_kultalanka_labels:capability_gap_amount:${g.id}:${figure}`);
    return amount ? { id: g.id, kind: g.kind, amount: eur(amount) } : null;
  }).filter(Boolean);
}
const gapNote = (labels, figure, parts) => gapItems(labels, figure, parts).map(g => `, of which ${fmt(cents(g.amount))} is ${g.id} (a capability gap the tree cannot yet produce)`).join('');
export function computeSectionC(labels) {
  const out = {};
  for (const figure of C_FIGURES) {
    const original = labels.section_c.original.find(r => r.key === figure);
    const parts = labels.section_c.contributions.filter(c => c.figure === figure);
    if (!original || !parts.length || parts.reduce((t, c) => t + cents(c.amount), 0) !== cents(original.amount)) fail(`invalid_kultalanka_labels:section_c_contributions:${figure}`);
    for (const c of parts) if (c.derived_from === 'lines') {
      const seen = new Set();
      const derived = c.lines.map(id => keyJournalOf(labels, id)).filter(j => j && !seen.has(j) && seen.add(j)).reduce((t, j) => t + FIGURE_OF[figure](j), 0);
      if (derived !== cents(c.amount)) fail(`invalid_kultalanka_labels:section_c_line_amount:${figure}:${c.lines.join('+')}`);
    }
    const by = s => parts.filter(c => contributionStatus(labels, c) === s);
    const sum = xs => xs.reduce((t, c) => t + cents(c.amount), 0);
    // A decided line Ilkka adjudicated to a different posting contributes its
    // adjudicated amount; the key's amount stays in the original column.
    const adjudicatedAmount = c => {
      const ls = c.lines.map(id => labels.lines.find(l => l.id === id));
      if (c.derived_from !== 'lines' || !ls.some(l => l.adjudication.status === 'adjudicated' && l.adjudicated.terminal === 'posted')) return cents(c.amount);
      return ls.reduce((t, l) => t + FIGURE_OF[figure](l.adjudication.status === 'adjudicated' ? l.adjudicated.journal : keyJournalOf(labels, l.id)), 0);
    };
    const adjustments = by('decided').filter(c => adjudicatedAmount(c) !== cents(c.amount));
    const decided = by('decided').reduce((t, c) => t + adjudicatedAmount(c), 0), pending = sum(by('pending_owner')), undecided = sum(by('disputed'));
    // An undecided line-derived item also carries the disputed line's proposed
    // amount, so a book taking the proposal (e.g. the receipt's cent split) is explained.
    const proposed = c => { const ls = c.lines.map(id => labels.lines.find(l => l.id === id)); return c.derived_from === 'lines' && !c.c_dispute && ls.every(l => l.proposed_gold) ? eur(ls.reduce((t, l) => t + FIGURE_OF[figure](l.proposed_gold), 0)) : null; };
    const items = xs => xs.map(c => ({ id: c.c_dispute || c.lines.join('+'), amount: c.amount, derived_from: c.derived_from, ...(proposed(c) !== null && cents(proposed(c)) !== cents(c.amount) ? { proposed_amount: proposed(c) } : {}) }));
    const adjustment = adjustments.reduce((t, c) => t + adjudicatedAmount(c) - cents(c.amount), 0);
    out[figure] = { original: original.amount, at_rest: eur(decided), with_key_disputes: eur(decided + undecided), pending_owner: eur(pending), undecided: eur(undecided),
      pending_items: items(by('pending_owner')), undecided_items: items(by('disputed')),
      capability_gap_items: gapItems(labels, figure, parts),
      // The key gives some decided figures only as a monthly total (the Nets
      // rows): the book rounds each settlement, so each may differ by a cent.
      rounding_tolerance_cents: by('decided').filter(c => c.derived_from === 'section_c').length,
      arithmetic: `${fmt(cents(original.amount))} − ${fmt(pending)} pending owner (${by('pending_owner').map(c => c.lines.join('+')).join(', ') || '—'}) − ${fmt(undecided)} undecided (${by('disputed').map(c => c.c_dispute || c.lines.join('+')).join(', ') || '—'})${adjustment ? ` ${adjustment > 0 ? '+' : '−'} ${fmt(Math.abs(adjustment))} adjudicated (${adjustments.map(c => c.lines.join('+')).join(', ')})` : ''} = ${fmt(decided)} at rest${gapNote(labels, figure, parts)}` };
  }
  const due = (o, i) => eur(cents(o) - cents(i));
  const vatOriginal = labels.section_c.original.find(r => r.key === 'vat_due').amount;
  if (cents(vatOriginal) !== cents(out.output_vat.original) - cents(out.input_vat_deductible.original)) fail('invalid_kultalanka_labels:section_c_vat_due');
  out.vat_due = { original: vatOriginal, at_rest: due(out.output_vat.at_rest, out.input_vat_deductible.at_rest), with_key_disputes: due(out.output_vat.with_key_disputes, out.input_vat_deductible.with_key_disputes),
    arithmetic: `output ALV − domestic input ALV (reverse charge nets to zero): at rest ${fmt(cents(out.output_vat.at_rest))} − ${fmt(cents(out.input_vat_deductible.at_rest))} = ${fmt(cents(out.output_vat.at_rest) - cents(out.input_vat_deductible.at_rest))}; with the key's disputed positions ${fmt(cents(out.output_vat.with_key_disputes))} − ${fmt(cents(out.input_vat_deductible.with_key_disputes))} = ${fmt(cents(out.output_vat.with_key_disputes) - cents(out.input_vat_deductible.with_key_disputes))}; original ${fmt(cents(vatOriginal))}` };
  return out;
}

// ── Finding each label in a book ────────────────────────────────────────────
// A bank label is the book's transaction with the same date, direction and
// amount (identical rows are assigned in statement order); a source is the
// uploaded document with the same bytes, else the same file name.
export function identify(labels, snapshot) {
  const byKey = new Map();
  for (const tx of [...snapshot.transactions].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))) {
    const dir = Number(tx.money_in) > 0 ? 'in' : 'out';
    const key = `${tx.date}|${dir}|${cents(dir === 'in' ? tx.money_in : tx.money_out)}`;
    (byKey.get(key) || byKey.set(key, []).get(key)).push(tx);
  }
  const taken = new Map(), lineTx = {};
  for (const line of labels.lines.filter(l => l.bank)) {
    const key = `${line.bank.date}|${line.bank.direction}|${cents(line.bank.amount)}`;
    const n = taken.get(key) || 0; taken.set(key, n + 1);
    lineTx[line.id] = byKey.get(key)?.[n] ?? null;
  }
  const docOf = {};
  for (const s of labels.sources) docOf[s.file] = snapshot.documents.find(d => d.checksum_sha256 === s.sha256) || snapshot.documents.find(d => d.filename === s.file) || null;
  const claimed = new Set(Object.values(lineTx).filter(Boolean).map(t => t.id));
  return { lineTx, docOf, missing_bank_rows: Object.entries(lineTx).filter(([, t]) => !t).map(([id]) => id).sort(),
    unlabelled_transactions: snapshot.transactions.filter(t => !claimed.has(t.id)).map(t => ({ id: t.id, date: t.date, money_in: t.money_in, money_out: t.money_out })),
    missing_sources: labels.sources.filter(s => s.file !== labels.answer_key.file && !docOf[s.file]).map(s => s.file) };
}

// ── The consequence of one line (or refund group) ───────────────────────────
const POSTED = j => ['posted', 'closed'].includes(j.status) && !j.reversed_at;
const SOURCE_DOCUMENT_JOURNALS = ['supplier_bill', 'document_settlement'];
const accepts = (x, l) => x && ((x.accept.roles || []).includes(l.canonical_role) || (x.accept.account_codes || []).includes(String(l.account_code ?? ''))
  || (x.accept.account_names || []).includes(l.account_name));
// Net the actual lines of a journal set per account and ALV code: a bill's
// payable (or an owner-funds leg) cleared inside the set disappears, exactly as
// the key books a paid bill straight to expense.
export function netLines(lines) {
  const acc = new Map();
  for (const l of lines) {
    const tax = String(l.tax_type || 'NONE').toUpperCase();
    const key = `${l.account_code || ''}|${l.account_name || ''}|${tax}`;
    const row = acc.get(key) || acc.set(key, { account_code: l.account_code ?? null, account_name: l.account_name ?? null, canonical_role: l.canonical_role ?? null, role: l.role ?? null, tax_type: tax, cents: 0 }).get(key);
    row.cents += (l.direction === 'debit' ? 1 : -1) * cents(l.amount);
    if (!row.role && l.role) row.role = l.role;
  }
  return [...acc.values()].filter(r => r.cents !== 0).map(({ cents: c, ...r }) => ({ ...r, direction: c > 0 ? 'debit' : 'credit', amount: eur(Math.abs(c)) }));
}
// Map the actual lines into key space against one gold journal. Greedy, three
// passes: account + ALV + amount, then account + amount (an ALV difference),
// then ALV + amount (an account difference). Matched lines take the gold's key
// account and canonical code; the rest keep a `donna:` account so the FIK-3
// difference classifier sees what is extra or missing.
export function mapToKeySpace(labels, actual, goldJournal) {
  const cross = new Map(labels.crosswalk.map(x => [x.key_account, x]));
  const canon = cls => labels.alv_classes[cls][0];
  const acceptsTax = (cls, code) => labels.alv_classes[cls].includes(code);
  const pool = actual.map((l, i) => ({ ...l, i, used: false }));
  // The gold nets exactly as the book does (per account, ALV class and role):
  // two input-ALV legs of one receipt are one 2940 movement in the ledger.
  const netted = new Map();
  for (const l of goldJournal) {
    const key = `${l.account}|${l.alv}|${goldRole(l)}`;
    const row = netted.get(key) || netted.set(key, { account: l.account, alv: l.alv, role: goldRole(l), cents: 0 }).get(key);
    row.cents += signed(l);
  }
  const gold = [...netted.values()].filter(r => r.cents !== 0).map(({ cents: c, ...r }) => ({ ...r, direction: c > 0 ? 'debit' : 'credit', amount: eur(Math.abs(c)), match: null }));
  const matchable = gold.filter(g => !cross.get(g.account)?.accept.represented_by_alv_code);
  const passes = [(g, a) => accepts(cross.get(g.account), a) && acceptsTax(g.alv, a.tax_type), (g, a) => accepts(cross.get(g.account), a), (g, a) => acceptsTax(g.alv, a.tax_type)];
  for (const pass of passes) for (const g of matchable.filter(x => !x.match)) {
    const a = pool.find(x => !x.used && x.direction === g.direction && cents(x.amount) === cents(g.amount) && pass(g, x));
    if (a) { a.used = true; g.match = a; }
  }
  // Reverse charge has ONE accepted representation: the self-assessed tax and
  // deduction ride the base line's ALV code, as the production return computes
  // them (finland/alvReturn.js). Posted 1761/2937-style legs would count twice in
  // 307 and in the domestic input legs, so they stay unmatched and are material.
  const kept = gold.filter(g => !cross.get(g.account)?.accept.represented_by_alv_code);
  const fik3Gold = kept.map(g => ({ role: g.role, account: g.account, direction: g.direction, amount: g.amount, tax_code: canon(g.alv) }));
  const mapped = [
    ...kept.filter(g => g.match).map(g => ({ role: /^alv_/.test(g.match.role || '') ? g.match.role : g.role, account: accepts(cross.get(g.account), g.match) ? g.account : `donna:${g.match.canonical_role || g.match.account_code || g.match.account_name}`,
      direction: g.match.direction, amount: g.match.amount, tax_code: acceptsTax(g.alv, g.match.tax_type) ? canon(g.alv) : g.match.tax_type })),
    ...pool.filter(a => !a.used).map(a => ({ role: a.role || 'counterparty', account: `donna:${a.canonical_role || a.account_code || a.account_name}`, direction: a.direction, amount: a.amount, tax_code: a.tax_type }))
  ];
  return { gold: fik3Gold, mapped };
}
// Which open owner questions answer the label's ask, normalized to its primary type.
const OPEN_ASK = ['draft', 'open'];
export function askAccepted(ask, actualAsk, decision) {
  if (!OPEN_ASK.includes(actualAsk.status)) return false;
  const selected = /^ask_/.test(decision?.selected || '') ? decision.selected : null;
  if (actualAsk.evidence_type === ask.evidence_type) return !ask.kinds || !selected || ask.kinds.includes(selected);
  return (ask.also || []).some(x => x.evidence_type === actualAsk.evidence_type
    && (!x.question_mentions || x.question_mentions.some(w => String(actualAsk.question || '').toLowerCase().includes(w))));
}

export function scoreLine(labels, line, snapshot, found, { decisionOf }) {
  const gold = goldOfLine(labels, line);
  const group = gold?.group ? labels.groups.find(g => g.id === gold.group) : null;
  const memberIds = group ? group.members : [line.id];
  const txs = memberIds.map(id => found.lineTx[id]).filter(Boolean);
  const docs = [...new Set(labels.lines.filter(l => memberIds.includes(l.id)).flatMap(l => l.source_files))].map(f => found.docOf[f]).filter(Boolean);
  const cashDoc = line.cash_document ? found.docOf[line.cash_document.file] : null;
  const tx = found.lineTx[line.id] ?? null;
  const decision = tx ? decisionOf(tx.payload || {}) : null;
  if (line.bank && !tx) return { line, missing: 'bank_row_not_in_book' };
  if (line.cash_document && !cashDoc) return { line, missing: 'source_not_in_book' };
  const txIds = new Set(txs.map(t => t.id));
  const matches = snapshot.matches.filter(m => txIds.has(m.bank_transaction_id));
  const settled = new Set(matches.filter(m => ['auto_matched', 'confirmed'].includes(m.status)).map(m => m.matched_object_id));
  const journals = snapshot.journals.filter(j => POSTED(j) && ((j.source_type === 'transaction' && txIds.has(j.source_id))
    || (SOURCE_DOCUMENT_JOURNALS.includes(j.source_type) && settled.has(j.source_id)) || (cashDoc && j.source_id === cashDoc.id)));
  const actual = netLines(journals.flatMap(j => j.lines));
  const docIds = new Set([...docs.map(d => d.id), ...(cashDoc ? [cashDoc.id] : [])]);
  const asks = snapshot.asks.filter(a => txIds.has(a.transaction_id) || docIds.has(a.document_id));
  // Pick the gold representation the book is closest to (an accepted
  // alternative, e.g. revenue on the settling bank line, scores as the gold).
  // A representation alternative (revenue on the settling bank line) holds only
  // while no sales-invoice or credit-note journal exists in the book: then that
  // revenue cannot be recognised twice nor leave a receivable open.
  const alternativesAllowed = !snapshot.journals.some(j => POSTED(j) && ['sales_invoice', 'credit_note'].includes(j.source_type));
  const golds = gold?.terminal === 'posted' ? [gold.journal, ...(alternativesAllowed ? gold.alternatives : [])] : [];
  const candidates = golds.map(j => mapToKeySpace(labels, actual, j));
  const zero = candidates.findIndex(c => hash([...c.mapped].map(x => JSON.stringify(x)).sort()) === hash([...c.gold].map(x => JSON.stringify(x)).sort()));
  const chosen = candidates[zero >= 0 ? zero : 0] ?? mapToKeySpace(labels, actual, []);
  const accepted = gold?.ask ? asks.filter(a => askAccepted(gold.ask, a, decision)) : [];
  // A.3-style interim posting: an accepted receipt question with a VAT-free
  // temporary journal rests on the owner, not as a posting.
  const interim = Boolean(gold?.interim_posting === 'no_input_vat' && accepted.length && journals.length
    && !actual.some(l => l.role === 'alv_input_deductible' || /_INPUT$|ACQUISITION/.test(l.tax_type)));
  const bankLeg = labels.crosswalk.find(x => x.key_account === '1910');
  const bank = actual.filter(l => l.role === 'bank' || accepts(bankLeg, l)).reduce((t, l) => t + signed(l), 0);
  const expectedBank = txs.reduce((t, x) => t + (Number(x.money_in) > 0 ? cents(x.money_in) : -cents(x.money_out)), 0);
  const duplicates = expectedBank !== 0 && bank !== expectedBank && bank % expectedBank === 0 ? Math.abs(bank / expectedBank) - 1 : 0;
  const expectedDocs = new Set(docs.map(d => d.id));
  const fik3Case = { id: line.id, decision_class: line.decision_class, family: line.decision_class, expressible: { status: 'expressible' },
    labels: { original: gold ? { terminal: gold.terminal, journal: gold.terminal === 'posted' ? chosen.gold : [], ask: gold.ask ? { evidence_type: gold.ask.evidence_type } : null, reconciliation: [...expectedDocs] } : { terminal: 'posted', journal: [], ask: null },
      adjudicated: null, adjudication: { status: gold ? 'agreed' : 'disputed' } } };
  const convergenceOf = row => ({ state: row?.convergence_state ?? null, reason: row?.convergence_reason ?? null, drift: false });
  const fik3Snapshot = {
    provider_failure: decision?.provider_failure ?? null, decision, refusal: tx?.payload?.ledger_post_refusal?.code ?? null,
    journals: journals.length && !interim ? [{ status: 'posted', lines: chosen.mapped }] : [],
    asks: asks.map(a => ({ evidence_type: accepted.includes(a) ? gold.ask.evidence_type : a.evidence_type, status: a.status })),
    reconciliation: matches.map(m => ({ matched_object_id: m.matched_object_id, status: m.status, seeded: false })),
    convergence: convergenceOf(tx ?? cashDoc)
  };
  if (gold?.ask?.kinds && decision?.selected && /^ask_/.test(decision.selected) && !gold.ask.kinds.includes(decision.selected) && !accepted.length) fik3Snapshot.asks = fik3Snapshot.asks.map(a => ({ ...a, evidence_type: `wrong_kind:${a.evidence_type}` }));
  const score = scoreFiOutcome(fik3Case, fik3Snapshot);
  // Objective safety runs whatever the label status: a dispute removes the
  // line from accuracy grading, never from the check that a posting moves the
  // bank by exactly the statement amount or that evidence is the line's own.
  const material = kind => { score.material_wrong_autonomous_action = true; score.correct_complete = false; if (!score.material_kinds.includes(kind)) score.material_kinds.push(kind); };
  if (journals.length && !interim && expectedBank !== 0 && bank !== expectedBank) {
    if (duplicates > 0) { score.duplicate_journals = duplicates; material('duplicate_journal'); } else material('bank_leg_mismatch');
  }
  if (!score.gold_scored) {
    score.false_reconciliations = matches.filter(m => ['auto_matched', 'confirmed'].includes(m.status) && !expectedDocs.has(m.matched_object_id)).length;
    if (score.false_reconciliations) material('false_reconciliation');
  }
  // An open owner question beside a correct posting still interrupts the owner.
  const openAsks = asks.filter(a => OPEN_ASK.includes(a.status));
  if (gold?.terminal === 'posted' && score.terminal === 'posted' && openAsks.length) {
    score.redundant_open_asks = openAsks.length;
    score.avoidable_interruption ||= interruptionClass(fik3Snapshot, 'ask');
    score.correct_complete = false;
  }
  return { line, gold, fik3Case, fik3Snapshot, score, interim_posting: interim, journals: journals.map(j => ({ id: j.id, source_type: j.source_type })), actual_lines: actual, mapped_lines: chosen.mapped, gold_lines: chosen.gold,
    asks: asks.map(a => ({ id: a.id, evidence_type: a.evidence_type, status: a.status, accepted: accepted.includes(a) })), tx_ids: [...txIds] };
}

// ── Economics against section C ─────────────────────────────────────────────
// The production return builder over the period's posted lines, beside the
// posted ALV legs; each figure compared with the adjudicated expectation.
export function monthEconomics(labels, snapshot) {
  const lines = snapshot.journals.filter(j => POSTED(j) && j.journal_date >= PERIOD.start && j.journal_date <= PERIOD.end).flatMap(j => j.lines);
  let alv = null, alvError = null;
  try {
    alv = buildAlvReturnFromLedgerLines({ period: PERIOD.key, lines: lines.map(l => ({ debit: l.direction === 'debit' ? Number(l.amount) : 0, credit: l.direction === 'credit' ? Number(l.amount) : 0,
      tax_type: l.tax_type, role: l.role, account_code: l.account_code, account_type: l.account_type })) });
  } catch (error) { alvError = error.message; }
  const sum = (pred, sign) => eur(lines.filter(pred).reduce((t, l) => t + sign * (l.direction === 'debit' ? 1 : -1) * cents(l.amount), 0));
  const b = alv?.alvReturn?.boxes;
  const box = (...ks) => (b ? eur(ks.reduce((t, k) => t + cents(b[k] || 0), 0)) : null);
  const actual = {
    sales_net: sum(l => l.canonical_role === 'revenue.operating', -1),
    output_vat: box('301', '302', '303'),
    input_vat_deductible: sum(l => l.role === 'alv_input_deductible', 1),
    reverse_charge_vat: box('304', '305', '306', '318'),
    nets_fees: sum(l => l.canonical_role === 'expense.platform_fees', 1)
  };
  actual.vat_due = actual.output_vat === null ? null : eur(cents(actual.output_vat) - cents(actual.input_vat_deductible));
  const expected = labels.section_c.adjudicated;
  // A figure passes when the book equals the at-rest expectation plus an exact
  // subset of the undecided items: the report names which disputed items the
  // book took the key's position on. An item the key only gives as a monthly
  // total (the Nets rows) may differ by one cent of per-row rounding.
  const explain = (figure, value) => {
    const e = expected[figure], items = e.undecided_items;
    let best = null;
    // Each item is absent, at the key's amount, or at its proposed amount.
    const options = items.map(x => [null, x.amount, ...(x.proposed_amount !== undefined ? [x.proposed_amount] : [])]);
    const combos = options.reduce((acc, opts) => acc.flatMap(prefix => opts.map(o => [...prefix, o])), [[]]);
    for (const combo of combos) {
      const chosen = items.map((x, i) => combo[i] === null ? null : { ...x, taken: combo[i], as: combo[i] === x.amount ? 'key' : 'proposal' }).filter(Boolean);
      const target = cents(e.at_rest) + chosen.reduce((t, x) => t + cents(x.taken), 0);
      const tolerance = chosen.filter(x => x.derived_from === 'section_c').length + (e.rounding_tolerance_cents || 0);
      if (Math.abs(cents(value) - target) <= tolerance && (!best || chosen.length < best.chosen.length)) best = { chosen, target };
    }
    return best;
  };
  // A failing figure whose shortfall is exactly a subset of the named
  // capability gaps is attributed to them. It still FAILS: an omission is
  // never a passing alternative.
  const gapAttribution = (name, value) => {
    const gaps = expected[name].capability_gap_items || [];
    const subsets = gaps.reduce((acc, g) => acc.flatMap(p => [p, [...p, g]]), [[]]).filter(x => x.length);
    for (const subset of subsets) {
      const shortfall = subset.reduce((t, g) => t + cents(g.amount), 0), found = explain(name, eur(cents(value) + shortfall));
      if (found) return { ids: subset.map(g => g.id), shortfall: eur(shortfall), found };
    }
    return null;
  };
  const checks = ['sales_net', 'output_vat', 'input_vat_deductible', 'reverse_charge_vat', 'nets_fees'].map(name => {
    const e = expected[name], a = actual[name], found = a === null ? null : explain(name, a);
    const gap = found || a === null ? null : gapAttribution(name, a);
    return { name, actual: a, expected_at_rest: e.at_rest, expected_with_key_disputes: e.with_key_disputes, original: e.original, pass: Boolean(found),
      key_positions_taken: found ? found.chosen.filter(x => x.as === 'key').map(x => x.id) : null, proposals_taken: found ? found.chosen.filter(x => x.as === 'proposal').map(x => x.id) : null, expected: found ? eur(found.target) : null,
      capability_gaps: gap ? gap.ids : [], ...(gap ? { shortfall: gap.shortfall, expected_with_gap_closed: eur(gap.found.target) } : {}) };
  });
  const byName = Object.fromEntries(checks.map(c => [c.name, c]));
  const dueExpected = byName.output_vat.pass && byName.input_vat_deductible.pass ? eur(cents(byName.output_vat.expected) - cents(byName.input_vat_deductible.expected)) : null;
  const dueTolerance = checks.filter(c => ['output_vat', 'input_vat_deductible'].includes(c.name)).reduce((t, c) => t + Math.abs(cents(c.actual) - cents(c.expected ?? c.actual)), 0);
  const duePass = dueExpected !== null && actual.vat_due !== null && Math.abs(cents(actual.vat_due) - cents(dueExpected)) <= dueTolerance;
  // The due figure inherits the gaps that alone explain its components' shortfall.
  const dueGapTarget = ['output_vat', 'input_vat_deductible'].every(n => byName[n].pass || byName[n].capability_gaps.length)
    ? eur(cents(byName.output_vat.expected ?? byName.output_vat.expected_with_gap_closed) - cents(byName.input_vat_deductible.expected ?? byName.input_vat_deductible.expected_with_gap_closed)) : null;
  const dueGaps = !duePass && dueGapTarget !== null && actual.vat_due !== null ? [...new Set([...byName.output_vat.capability_gaps, ...byName.input_vat_deductible.capability_gaps])] : [];
  checks.push({ name: 'vat_due', actual: actual.vat_due, expected_at_rest: expected.vat_due.at_rest, expected_with_key_disputes: expected.vat_due.with_key_disputes, original: expected.vat_due.original,
    pass: duePass, key_positions_taken: null, expected: dueExpected, capability_gaps: dueGaps,
    ...(dueGaps.length ? { shortfall: eur(cents(byName.output_vat.shortfall ?? 0) - cents(byName.input_vat_deductible.shortfall ?? 0)), expected_with_gap_closed: dueGapTarget } : {}) });
  const gapsSeen = new Set(checks.flatMap(c => c.capability_gaps));
  const capabilityGaps = (labels.section_c.capability_gaps || []).map(g => ({ ...g, observed: gapsSeen.has(g.id), failing_checks: checks.filter(c => c.capability_gaps.includes(g.id)).map(c => c.name) }));
  return { status: checks.every(c => c.pass) ? 'PASS' : 'INCOMPLETE', checks, capability_gaps: capabilityGaps, alv_return: alv ? { boxes: alv.alvReturn.boxes, payable: alv.alvReturn.payable, review: alv.review?.status ?? null, blockers: alv.review?.blockers ?? [], control_check: alv.review?.controlCheck ?? null } : { error: alvError },
    measurement: 'Posted lines dated 1.–28.2.2025 through finland/alvReturn.js buildAlvReturnFromLedgerLines; input ALV is the posted deductible legs, as section C sums them. A figure passes when it equals the decided (at-rest) expectation plus an exact subset of the undecided items, named in key_positions_taken. A failing figure whose shortfall is exactly a named capability gap still fails; the gap is named in its capability_gaps and in capability_gaps[].observed.' };
}

// ── The month report ────────────────────────────────────────────────────────
export function scoreMonth(labels, snapshot, { decisionOf, source = 'unspecified' } = {}) {
  if (typeof decisionOf !== 'function') fail('decision_reader_required');
  const found = identify(labels, snapshot);
  const scored = labels.lines.map(line => scoreLine(labels, line, snapshot, found, { decisionOf }));
  const outcomes = scored.map(s => s.missing
    ? { id: s.line.id, case_id: s.line.id, arm: 'month', split: 'development', family: s.line.decision_class, decision_class: s.line.decision_class, completion: 'incomplete', evidence_path: s.missing }
    : { id: s.line.id, case_id: s.line.id, arm: 'month', split: 'development', family: s.line.decision_class, decision_class: s.line.decision_class, completion: 'complete',
      evidence_path: `${s.fik3Snapshot.decision?.engine ?? 'none'}:${s.score.terminal}`, score: s.score, error_attribution: attributeFiError(s.fik3Case, s.fik3Snapshot, s.score),
      deciding_probability: s.fik3Snapshot.decision?.deciding_probability ?? null, band: 'no_probability', calls: 0, second_passes: 0, strong_calls: 0, usage: { input_tokens: 0, output_tokens: 0 }, usd: null,
      provider_ms: 0, wall_ms: null, fallbacks: { provider_failure: s.fik3Snapshot.provider_failure ? 1 : 0, schema_dropped: 0, unplanned_requests_refused: 0 } });
  const summary = armSummary(outcomes);
  // A missing row is incomplete work, never silently dropped from the denominator.
  summary.cases = labels.lines.length; summary.incomplete_work = labels.lines.length - summary.correct_complete;
  const duplicateRecon = (() => {
    const seen = new Map();
    for (const s of scored.filter(x => !x.missing)) for (const m of s.fik3Snapshot.reconciliation.filter(r => ['auto_matched', 'confirmed'].includes(r.status))) {
      const owners = seen.get(m.matched_object_id) || seen.set(m.matched_object_id, new Set()).get(m.matched_object_id);
      owners.add(s.line.group || s.line.id);
    }
    const multi = new Set((labels.multi_line_documents || []).map(f => found.docOf[f]?.id).filter(Boolean));
    return [...seen.entries()].filter(([doc, owners]) => owners.size > 1 && !multi.has(doc)).map(([doc, owners]) => ({ document_id: doc, lines: [...owners].sort() }));
  })();
  return {
    version: SCORE_VERSION, labels_version: labels.version, labels_sha256: labelsDigest(labels), source, period: PERIOD, entity: labels.entity.company_name,
    identification: { missing_bank_rows: found.missing_bank_rows, missing_sources: found.missing_sources, unlabelled_transactions: found.unlabelled_transactions },
    by_status: Object.fromEntries(STATUSES.map(s => [s, labels.lines.filter(l => l.adjudication.status === s).length])),
    summary, duplicate_reconciliations: duplicateRecon,
    lines: scored.map(s => s.missing ? { id: s.line.id, status: s.line.adjudication.status, missing: s.missing } : {
      id: s.line.id, status: s.line.adjudication.status, group: s.line.group, gold_terminal: s.gold?.terminal ?? null, terminal: s.score.terminal, correct_complete: s.score.correct_complete,
      material: s.score.material_kinds, journal_differences: s.score.journal_differences, wrong_owner_ask: s.score.wrong_owner_ask, missing_owner_ask: s.score.missing_owner_ask,
      avoidable_interruption: s.score.avoidable_interruption, redundant_open_asks: s.score.redundant_open_asks ?? 0, false_reconciliations: s.score.false_reconciliations, duplicate_journals: s.score.duplicate_journals, interim_posting: s.interim_posting,
      convergence: s.fik3Snapshot.convergence.state, convergence_reason: s.fik3Snapshot.convergence.reason, coding_state: found.lineTx[s.line.id]?.coding_state ?? null,
      engine: s.fik3Snapshot.decision?.engine ?? null, selected: s.fik3Snapshot.decision?.selected ?? null, asks: s.asks, journals: s.journals, mapped: s.mapped_lines, gold: s.gold_lines,
      attribution: attributeFiError(s.fik3Case, s.fik3Snapshot, s.score) }),
    economics: monthEconomics(labels, snapshot),
    models: snapshot.models ?? null,
    measurement: 'Line-by-line against the adjudicated labels through the FIK-3 consequence scorer, after the crosswalk maps each posted line into the key\'s chart. Disputed lines carry no gold: excluded from accuracy, counted as incomplete work. Model ids are read from the book, never from code defaults.'
  };
}
