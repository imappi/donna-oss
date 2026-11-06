import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SG_DEMO_1_BOOK_SCHEMA_VERSION,
  SG_DEMO_1_ENTITY_ID,
  SG_DEMO_1_EVALUATION_RECEIPT_VERSION,
  SG_DEMO_1_EVIDENCE_RECEIPT_VERSION,
  SG_DEMO_1_PERIOD_ID,
  SG_DEMO_1_SOURCE_SCHEMA_VERSION,
  SG_DEMO_1_WORLD_ID,
  canonicalJson,
} from './sgDemo1Definition.js';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(MODULE_PATH), '../../..');
const MONEY = /^-?(0|[1-9]\d*)\.\d{2}$/;
const RATE = /^(0|[1-9]\d*)\.\d{2,4}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TERMINALS = new Set(['auto_reconciled', 'on_owner']);
const EVALUATOR_SOURCE_SHA256 = digest(readFileSync(MODULE_PATH));
const EXPECTED_STATEMENT_ORDER = Object.freeze([
  'doc_statement_dbs_2026_01', 'doc_statement_ocbc_2026_01', 'doc_statement_airwallex_2026_01', 'doc_statement_wise_2026_01',
  'doc_statement_dbs_2026_02', 'doc_statement_ocbc_2026_02', 'doc_statement_airwallex_2026_02', 'doc_statement_wise_2026_02',
  'doc_statement_dbs_2026_03', 'doc_statement_ocbc_2026_03', 'doc_statement_airwallex_2026_03', 'doc_statement_wise_2026_03',
]);
const EXPECTED_TRIAL_BALANCE_ORDER = Object.freeze(['1910', '1900', '2951', '4000', '4400', '7000', '7600', '7800', '2000', '2251', '2950', '3000', '3200', '9300', '3900']);
const EXPECTED_SOURCE_ORDER = Object.freeze([
  'iras_gst_rate', 'iras_gst_inclusive', 'iras_gst_return', 'iras_input_tax', 'iras_imported_services',
  'iras_international_services', 'iras_exempt_supplies', 'iras_interest', 'iras_cit_giro', 'cpf_employer',
  'abs_paynow', 'dbs_terms', 'ocbc_terms', 'airwallex_account', 'wise_fees',
]);

export const SG_DEMO_1_DEFAULT_PATHS = Object.freeze({
  book: path.join(ROOT, 'data/worlds/sg/sg-demo-1-book-v1.json'),
  sourceManifest: path.join(ROOT, 'data/worlds/sg/sg-demo-1-source-manifest-v1.json'),
  evidenceReceipts: path.join(ROOT, 'server/donna/fixtures/sg-demo-1/receipts.json'),
  evidenceDir: path.join(ROOT, 'server/donna/fixtures/sg-demo-1'),
  committedReceipt: path.join(ROOT, 'data/worlds/sg/receipts/sg-demo-1-goldset-v1.json'),
});

export function loadSgDemo1Inputs(paths = {}) {
  const resolved = { ...SG_DEMO_1_DEFAULT_PATHS, ...paths };
  const bookText = readFileSync(resolved.book, 'utf8');
  const sourceManifestText = readFileSync(resolved.sourceManifest, 'utf8');
  const evidenceReceiptsText = readFileSync(resolved.evidenceReceipts, 'utf8');
  return {
    book: JSON.parse(bookText),
    bookText,
    sourceManifest: JSON.parse(sourceManifestText),
    sourceManifestText,
    evidenceReceipts: JSON.parse(evidenceReceiptsText),
    evidenceReceiptsText,
    evidenceDir: resolved.evidenceDir,
  };
}

export function evaluateSgDemo1({
  book,
  bookText = `${canonicalJson(book)}\n`,
  sourceManifest,
  sourceManifestText = `${canonicalJson(sourceManifest)}\n`,
  evidenceReceipts,
  evidenceReceiptsText = `${canonicalJson(evidenceReceipts)}\n`,
  evidenceDir = SG_DEMO_1_DEFAULT_PATHS.evidenceDir,
  verifyEvidenceBytes = true,
} = {}) {
  const errors = [];
  const invariants = [];
  const run = (id, check) => {
    const before = errors.length;
    try {
      check();
    } catch (error) {
      add(errors, 'SG_INVARIANT_EXCEPTION', id, error instanceof Error ? error.message : String(error));
    }
    invariants.push({ id, status: errors.length === before ? 'pass' : 'fail' });
  };

  run('strict_schema', () => validateSchemas(book, sourceManifest, evidenceReceipts, errors));
  run('canonical_bytes', () => {
    checkCanonicalText(book, bookText, 'book', errors);
    checkCanonicalText(sourceManifest, sourceManifestText, 'source_manifest', errors);
    checkCanonicalText(evidenceReceipts, evidenceReceiptsText, 'evidence_receipts', errors);
  });
  run('source_manifest', () => validateSourceManifest(sourceManifest, book, errors));
  run('identity_and_references', () => validateIdentityAndReferences(book, errors));
  run('statement_footing', () => validateStatementFooting(book, errors));
  run('journal_footing', () => validateJournalFooting(book, errors));
  run('trial_balance', () => validateTrialBalance(book, errors));
  run('gst_f5', () => validateGstF5(book, errors));
  run('match_economics', () => validateMatchEconomics(book, errors));
  run('cash_bridge', () => validateCashBridge(book, errors));
  run('two_terminal_states', () => validateTerminalStates(book, errors));
  run('owner_asks', () => validateOwnerCases(book, errors));
  run('cross_entity_isolation', () => validateCrossEntityIsolation(book, errors));
  run('evidence_receipts', () => validateEvidenceReceipts(book, evidenceReceipts, evidenceDir, verifyEvidenceBytes, errors));

  const artifactRows = Array.isArray(evidenceReceipts?.artifacts) ? evidenceReceipts.artifacts : [];
  const bookCanonical = safeCanonical(book);
  const sourceCanonical = safeCanonical(sourceManifest);
  const evidenceCanonical = safeCanonical(evidenceReceipts);
  const totals = isPlainObject(book?.controls) ? {
    debit: sumTrialSide(book.trial_balance, 'debit'),
    credit: sumTrialSide(book.trial_balance, 'credit'),
    statement_closing_sgd: book.controls.statement_closing_sgd ?? null,
    posted_bank_control_sgd: book.controls.posted_bank_control_sgd ?? null,
    owner_pending_movement_sgd: book.controls.owner_pending_movement_sgd ?? null,
    gst_payable_sgd: book.gst_f5?.box8 ?? null,
    profit_sgd: book.controls.profit_sgd ?? null,
  } : {};
  const receiptBody = {
    schema_version: SG_DEMO_1_EVALUATION_RECEIPT_VERSION,
    status: errors.length === 0 ? 'pass' : 'fail',
    world_id: book?.world_id ?? null,
    entity_id: book?.entity?.id ?? null,
    period_id: book?.period?.id ?? null,
    digests: {
      book_sha256: digest(bookCanonical),
      source_manifest_sha256: digest(sourceCanonical),
      evidence_tree_sha256: digest(evidenceCanonical),
      evaluator_source_sha256: EVALUATOR_SOURCE_SHA256,
    },
    counts: {
      bank_lines: count(book?.bank_lines),
      statements: count(book?.statements),
      primary_evidence: count(book?.evidence),
      rendered_evidence: artifactRows.length,
      event_groups: count(book?.events) + (book?.opening_journal ? 1 : 0),
      journals: count(book?.events) + (book?.opening_journal ? 1 : 0),
      owner_cases: count(book?.owner_cases),
      bank_lines_auto_reconciled: asArray(book?.bank_lines).filter((row) => row?.terminal === 'auto_reconciled').length,
      bank_lines_on_owner: asArray(book?.bank_lines).filter((row) => row?.terminal === 'on_owner').length,
      owner_evidence_placeholders: count(book?.owner_cases),
    },
    totals,
    invariants,
    error_codes: [...new Set(errors.map(({ code }) => code))].sort(),
  };
  const receipt = Object.freeze({ ...receiptBody, receipt_sha256: digest(canonicalJson(receiptBody)) });
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), receipt });
}

function validateSchemas(book, sourceManifest, evidenceReceipts, errors) {
  exactKeys(book, ['schema_version', 'world_id', 'source_manifest_id', 'fixture_clock', 'entity', 'period', 'accounts', 'opening_journal', 'statements', 'bank_lines', 'evidence', 'events', 'owner_cases', 'gst_f5', 'reverse_charge_alternative', 'trial_balance', 'controls', 'cross_entity_decoys'], 'book', errors);
  if (book?.schema_version !== SG_DEMO_1_BOOK_SCHEMA_VERSION) add(errors, 'SG_SCHEMA_VERSION', 'book.schema_version', `must be ${SG_DEMO_1_BOOK_SCHEMA_VERSION}`);
  exactKeys(book?.entity, ['id', 'legal_name', 'jurisdiction', 'entity_type', 'functional_currency', 'book_basis', 'financial_year_end', 'gst_registered', 'gst_rate', 'owner_actor_id'], 'book.entity', errors);
  exactKeys(book?.period, ['id', 'start', 'end'], 'book.period', errors);
  asArray(book?.accounts).forEach((row, index) => exactKeys(row, ['code', 'name', 'type'], `book.accounts[${index}]`, errors));
  validateJournalShape(book?.opening_journal, 'book.opening_journal', errors);
  asArray(book?.statements).forEach((row, index) => {
    exactKeys(row, ['id', 'entity_id', 'account_id', 'provider_style', 'month', 'closing_date', 'currency', 'opening_balance', 'closing_balance', 'closing_sgd_measurement', 'bank_line_ids', 'terminal', 'filename'], `book.statements[${index}]`, errors);
    moneyFields(row, ['opening_balance', 'closing_balance', 'closing_sgd_measurement'], `book.statements[${index}]`, errors);
  });
  asArray(book?.bank_lines).forEach((row, index) => {
    exactKeys(row, ['id', 'entity_id', 'date', 'account_id', 'currency', 'amount', 'narrative', 'reference', 'group_id', 'terminal', 'sgd_measurement'], `book.bank_lines[${index}]`, errors);
    moneyFields(row, ['amount', 'sgd_measurement'], `book.bank_lines[${index}]`, errors);
  });
  asArray(book?.evidence).forEach((row, index) => {
    exactKeys(row, ['id', 'entity_id', 'event_id', 'kind', 'filename', 'title', 'document_date', 'currency', 'total_amount', 'reference', 'details', 'terminal'], `book.evidence[${index}]`, errors);
    moneyFields(row, ['total_amount'], `book.evidence[${index}]`, errors);
  });
  asArray(book?.events).forEach((row, index) => {
    const pathName = `book.events[${index}]`;
    exactKeys(row, ['id', 'entity_id', 'date', 'bank_line_ids', 'evidence_id', 'match_id', 'journal', 'coding', 'gst', 'terminal'], pathName, errors);
    exactKeys(row?.coding, ['authority_basis', 'account_codes', 'gst_code'], `${pathName}.coding`, errors);
    exactKeys(row?.gst, ['box1', 'box2', 'box5', 'box6', 'box7', 'box13', 'box14', 'exempt_non_fx_box3', 'realized_fx'], `${pathName}.gst`, errors);
    moneyFields(row?.gst, ['box1', 'box2', 'box5', 'box6', 'box7', 'box13', 'box14', 'exempt_non_fx_box3', 'realized_fx'], `${pathName}.gst`, errors);
    validateJournalShape(row?.journal, `${pathName}.journal`, errors);
  });
  asArray(book?.owner_cases).forEach((row, index) => {
    exactKeys(row, ['id', 'entity_id', 'bank_line_id', 'ask_id', 'required_evidence_id', 'expected_evidence_type', 'question', 'sgd_movement', 'expected_coding', 'actor_id', 'audience', 'authority_basis', 'terminal'], `book.owner_cases[${index}]`, errors);
    moneyFields(row, ['sgd_movement'], `book.owner_cases[${index}]`, errors);
  });
  exactKeys(book?.gst_f5, ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box8', 'box9', 'box13', 'box14', 'exempt_non_fx_box3', 'realized_fx_net'], 'book.gst_f5', errors);
  moneyFields(book?.gst_f5, ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box8', 'box9', 'box13', 'box14', 'exempt_non_fx_box3', 'realized_fx_net'], 'book.gst_f5', errors);
  exactKeys(book?.reverse_charge_alternative, ['owner_case_id', 'base_sgd', 'box1_increment', 'box14_increment', 'box6_increment', 'box7_increment', 'base_fixture_posting'], 'book.reverse_charge_alternative', errors);
  moneyFields(book?.reverse_charge_alternative, ['base_sgd', 'box1_increment', 'box14_increment', 'box6_increment'], 'book.reverse_charge_alternative', errors);
  asArray(book?.trial_balance).forEach((row, index) => {
    exactKeys(row, ['account_code', 'debit', 'credit'], `book.trial_balance[${index}]`, errors);
    moneyFields(row, ['debit', 'credit'], `book.trial_balance[${index}]`, errors);
  });
  exactKeys(book?.controls, ['statement_closing_sgd', 'posted_bank_control_sgd', 'owner_pending_movement_sgd', 'petty_cash_sgd', 'cash_and_cash_equivalents_sgd', 'opening_cash_sgd', 'cash_increase_sgd', 'revenue_and_other_income_sgd', 'expenses_sgd', 'profit_sgd', 'input_gst_asset_sgd', 'output_gst_liability_sgd', 'closing_equity_sgd', 'assets_including_input_gst_sgd'], 'book.controls', errors);
  moneyFields(book?.controls, ['statement_closing_sgd', 'posted_bank_control_sgd', 'owner_pending_movement_sgd', 'petty_cash_sgd', 'cash_and_cash_equivalents_sgd', 'opening_cash_sgd', 'cash_increase_sgd', 'revenue_and_other_income_sgd', 'expenses_sgd', 'profit_sgd', 'input_gst_asset_sgd', 'output_gst_liability_sgd', 'closing_equity_sgd', 'assets_including_input_gst_sgd'], 'book.controls', errors);
  asArray(book?.cross_entity_decoys).forEach((row, index) => {
    exactKeys(row, ['id', 'entity_id', 'date', 'currency', 'amount', 'reference', 'expected_match_id', 'terminal'], `book.cross_entity_decoys[${index}]`, errors);
    moneyFields(row, ['amount'], `book.cross_entity_decoys[${index}]`, errors);
  });

  exactKeys(sourceManifest, ['schema_version', 'id', 'retrieved_at', 'sources'], 'source_manifest', errors);
  if (sourceManifest?.schema_version !== SG_DEMO_1_SOURCE_SCHEMA_VERSION) add(errors, 'SG_SOURCE_SCHEMA_VERSION', 'source_manifest.schema_version', `must be ${SG_DEMO_1_SOURCE_SCHEMA_VERSION}`);
  asArray(sourceManifest?.sources).forEach((row, index) => exactKeys(row, ['id', 'title', 'url', 'retrieved_content_sha256', 'stored_interpretation', 'stored_interpretation_sha256'], `source_manifest.sources[${index}]`, errors));

  exactKeys(evidenceReceipts, ['schema_version', 'world_id', 'world_seed', 'renderer_version', 'artifacts'], 'evidence_receipts', errors);
  if (evidenceReceipts?.schema_version !== SG_DEMO_1_EVIDENCE_RECEIPT_VERSION) add(errors, 'SG_EVIDENCE_SCHEMA_VERSION', 'evidence_receipts.schema_version', `must be ${SG_DEMO_1_EVIDENCE_RECEIPT_VERSION}`);
  asArray(evidenceReceipts?.artifacts).forEach((row, index) => exactKeys(row, ['id', 'file', 'frozen_date', 'sha256', 'byte_length', 'terminal'], `evidence_receipts.artifacts[${index}]`, errors));

  if (!RATE.test(book?.entity?.gst_rate ?? '')) add(errors, 'SG_SCHEMA_RATE', 'book.entity.gst_rate', 'must be a decimal rate');
  for (const [value, pathName, pattern] of [
    [book?.period?.start, 'book.period.start', ISO_DAY], [book?.period?.end, 'book.period.end', ISO_DAY],
    [book?.entity?.functional_currency, 'book.entity.functional_currency', ISO_CURRENCY],
  ]) if (!pattern.test(value ?? '')) add(errors, 'SG_SCHEMA_FORMAT', pathName, 'has invalid format');
  asArray(book?.bank_lines).forEach((row, index) => validateCommonFormats(row, `book.bank_lines[${index}]`, errors));
  asArray(book?.statements).forEach((row, index) => {
    validateCommonFormats({ ...row, date: row.closing_date }, `book.statements[${index}]`, errors);
    if (!ISO_MONTH.test(row?.month ?? '')) add(errors, 'SG_SCHEMA_FORMAT', `book.statements[${index}].month`, 'must be YYYY-MM');
  });
}

function validateSourceManifest(sourceManifest, book, errors) {
  if (sourceManifest?.id !== book?.source_manifest_id) add(errors, 'SG_SOURCE_ID_MISMATCH', 'source_manifest.id', 'must match book.source_manifest_id');
  if (sourceManifest?.retrieved_at !== '2026-09-02') add(errors, 'SG_SOURCE_DATE', 'source_manifest.retrieved_at', 'must pin the research date');
  if (count(sourceManifest?.sources) !== 15) add(errors, 'SG_SOURCE_COUNT', 'source_manifest.sources', 'must contain 15 declared primary sources');
  exactOrder(asArray(sourceManifest?.sources).map(({ id }) => id), EXPECTED_SOURCE_ORDER, 'source_manifest.sources', errors);
  unique(asArray(sourceManifest?.sources).map(({ id }) => id), 'source_manifest.sources.id', errors);
  for (const [index, source] of asArray(sourceManifest?.sources).entries()) {
    if (typeof source.url !== 'string' || !source.url.startsWith('https://')) add(errors, 'SG_SOURCE_URL', `source_manifest.sources[${index}].url`, 'must be HTTPS');
    if (!SHA256.test(source.retrieved_content_sha256 ?? '')) add(errors, 'SG_SOURCE_CONTENT_DIGEST', `source_manifest.sources[${index}]`, 'retrieved content digest must be pinned');
    if (!SHA256.test(source.stored_interpretation_sha256 ?? '') || digest(source.stored_interpretation ?? '') !== source.stored_interpretation_sha256) {
      add(errors, 'SG_SOURCE_DIGEST', `source_manifest.sources[${index}]`, 'stored interpretation digest mismatch');
    }
  }
}

function validateIdentityAndReferences(book, errors) {
  if (book?.world_id !== SG_DEMO_1_WORLD_ID) add(errors, 'SG_WORLD_ID', 'book.world_id', `must be ${SG_DEMO_1_WORLD_ID}`);
  if (book?.entity?.id !== SG_DEMO_1_ENTITY_ID) add(errors, 'SG_ENTITY_ID', 'book.entity.id', `must be ${SG_DEMO_1_ENTITY_ID}`);
  if (book?.period?.id !== SG_DEMO_1_PERIOD_ID) add(errors, 'SG_PERIOD_ID', 'book.period.id', `must be ${SG_DEMO_1_PERIOD_ID}`);
  const accountCodes = unique(asArray(book?.accounts).map(({ code }) => code), 'book.accounts.code', errors);
  const lineIds = unique(asArray(book?.bank_lines).map(({ id }) => id), 'book.bank_lines.id', errors);
  const statementIds = unique(asArray(book?.statements).map(({ id }) => id), 'book.statements.id', errors);
  const evidenceIds = unique(asArray(book?.evidence).map(({ id }) => id), 'book.evidence.id', errors);
  const eventIds = unique(asArray(book?.events).map(({ id }) => id), 'book.events.id', errors);
  unique(asArray(book?.events).map(({ match_id }) => match_id), 'book.events.match_id', errors);
  const ownerIds = unique(asArray(book?.owner_cases).map(({ id }) => id), 'book.owner_cases.id', errors);
  unique(asArray(book?.owner_cases).map(({ ask_id }) => ask_id), 'book.owner_cases.ask_id', errors);
  unique(asArray(book?.owner_cases).map(({ required_evidence_id }) => required_evidence_id), 'book.owner_cases.required_evidence_id', errors);
  const accountOrder = asArray(book?.accounts).map(({ code }) => code);
  exactOrder(accountOrder, [...accountOrder].sort((left, right) => Number(left) - Number(right)), 'book.accounts', errors);
  exactOrder(asArray(book?.statements).map(({ id }) => id), EXPECTED_STATEMENT_ORDER, 'book.statements', errors);
  exactOrder(asArray(book?.bank_lines).map(({ id }) => id), sequence('b', 31, 3), 'book.bank_lines', errors);
  exactOrder(asArray(book?.evidence).map(({ event_id }) => event_id), ['E00', ...sequence('E', 20, 2)], 'book.evidence', errors);
  exactOrder(asArray(book?.events).map(({ id }) => id), sequence('E', 20, 2), 'book.events', errors);
  exactOrder(asArray(book?.owner_cases).map(({ id }) => id), sequence('U', 8, 2), 'book.owner_cases', errors);
  exactOrder(asArray(book?.trial_balance).map(({ account_code }) => account_code), EXPECTED_TRIAL_BALANCE_ORDER, 'book.trial_balance', errors);
  exactOrder(asArray(book?.cross_entity_decoys).map(({ id }) => id), ['decoy_b001_sibling'], 'book.cross_entity_decoys', errors);
  exactOrder(asArray(book?.opening_journal?.lines).map(({ id }) => id), sequence('journal_e00_l', 6, 2), 'book.opening_journal.lines', errors);
  for (const statement of asArray(book?.statements)) {
    exactOrder(asArray(statement.bank_line_ids), [...asArray(statement.bank_line_ids)].sort(), `book.statements.${statement.id}.bank_line_ids`, errors);
    if (statement.entity_id !== SG_DEMO_1_ENTITY_ID) add(errors, 'SG_FOREIGN_STATEMENT', `book.statements.${statement.id}`, 'belongs to another entity');
    for (const id of asArray(statement.bank_line_ids)) if (!lineIds.has(id)) add(errors, 'SG_DANGLING_BANK_LINE', `book.statements.${statement.id}.bank_line_ids`, id);
  }
  for (const item of asArray(book?.evidence)) {
    if (!eventIds.has(item.event_id) && item.event_id !== 'E00') add(errors, 'SG_DANGLING_EVENT', `book.evidence.${item.id}.event_id`, item.event_id);
    if (item.entity_id !== SG_DEMO_1_ENTITY_ID) add(errors, 'SG_FOREIGN_EVIDENCE', `book.evidence.${item.id}`, 'belongs to another entity');
  }
  for (const item of asArray(book?.events)) {
    exactOrder(asArray(item.bank_line_ids), [...asArray(item.bank_line_ids)].sort(), `book.events.${item.id}.bank_line_ids`, errors);
    exactOrder(asArray(item.journal?.lines).map(({ id }) => id), sequence(`journal_${item.id.toLowerCase()}_l`, count(item.journal?.lines), 2), `book.events.${item.id}.journal.lines`, errors);
    exactOrder(asArray(item.coding?.account_codes), [...new Set(asArray(item.journal?.lines).map(({ account_code }) => account_code))], `book.events.${item.id}.coding.account_codes`, errors);
    if (!evidenceIds.has(item.evidence_id)) add(errors, 'SG_DANGLING_EVIDENCE', `book.events.${item.id}.evidence_id`, item.evidence_id);
    if (item.entity_id !== SG_DEMO_1_ENTITY_ID) add(errors, 'SG_FOREIGN_EVENT', `book.events.${item.id}`, 'belongs to another entity');
    for (const id of asArray(item.bank_line_ids)) if (!lineIds.has(id)) add(errors, 'SG_DANGLING_BANK_LINE', `book.events.${item.id}.bank_line_ids`, id);
    for (const code of asArray(item.coding?.account_codes)) if (!accountCodes.has(code)) add(errors, 'SG_DANGLING_ACCOUNT', `book.events.${item.id}.coding.account_codes`, code);
  }
  for (const item of asArray(book?.owner_cases)) {
    if (!lineIds.has(item.bank_line_id)) add(errors, 'SG_DANGLING_BANK_LINE', `book.owner_cases.${item.id}.bank_line_id`, item.bank_line_id);
    if (!ownerIds.has(item.id)) add(errors, 'SG_DANGLING_OWNER_CASE', `book.owner_cases.${item.id}`, item.id);
  }
  const coverage = [...asArray(book?.events).flatMap(({ bank_line_ids }) => asArray(bank_line_ids)), ...asArray(book?.owner_cases).map(({ bank_line_id }) => bank_line_id)];
  if (coverage.length !== lineIds.size || new Set(coverage).size !== lineIds.size) add(errors, 'SG_BANK_LINE_COVERAGE', 'book.bank_lines', 'each line must be covered exactly once');
  for (const line of asArray(book?.bank_lines)) {
    if (line.entity_id !== SG_DEMO_1_ENTITY_ID) add(errors, 'SG_FOREIGN_BANK_LINE', `book.bank_lines.${line.id}`, 'belongs to another entity');
    const coveredGroup = asArray(book?.events).find(({ bank_line_ids }) => asArray(bank_line_ids).includes(line.id))?.id
      ?? asArray(book?.owner_cases).find(({ bank_line_id }) => bank_line_id === line.id)?.id;
    if (line.group_id !== coveredGroup) add(errors, 'SG_GROUP_MISMATCH', `book.bank_lines.${line.id}.group_id`, `expected ${coveredGroup}`);
  }
  if (statementIds.size !== 12) add(errors, 'SG_STATEMENT_COUNT', 'book.statements', 'must contain 12 statements');
}

function validateStatementFooting(book, errors) {
  const linesById = new Map(asArray(book?.bank_lines).map((line) => [line.id, line]));
  const seen = [];
  const previousByAccount = new Map();
  for (const statement of asArray(book?.statements)) {
    const opening = cents(statement.opening_balance);
    const closing = cents(statement.closing_balance);
    if (opening === null || closing === null) continue;
    const previous = previousByAccount.get(statement.account_id);
    if (previous !== undefined && opening !== previous) add(errors, 'SG_STATEMENT_CONTINUITY', `book.statements.${statement.id}`, 'opening does not equal prior close');
    let movement = 0n;
    for (const id of asArray(statement.bank_line_ids)) {
      const line = linesById.get(id);
      if (!line) continue;
      if (line.account_id !== statement.account_id || line.currency !== statement.currency || !line.date.startsWith(statement.month)) {
        add(errors, 'SG_STATEMENT_LINE_SCOPE', `book.statements.${statement.id}.bank_line_ids`, id);
      }
      movement += cents(line.amount) ?? 0n;
      seen.push(id);
    }
    if (opening + movement !== closing) add(errors, 'SG_STATEMENT_FOOTING', `book.statements.${statement.id}`, `${opening + movement} != ${closing}`);
    previousByAccount.set(statement.account_id, closing);
  }
  if (seen.length !== count(book?.bank_lines) || new Set(seen).size !== count(book?.bank_lines)) add(errors, 'SG_STATEMENT_COVERAGE', 'book.statements', 'bank lines must appear exactly once');
}

function validateJournalFooting(book, errors) {
  const journalIds = [];
  const lineIds = [];
  for (const journal of [book?.opening_journal, ...asArray(book?.events).map(({ journal: value }) => value)]) {
    if (!journal) continue;
    journalIds.push(journal.id);
    let debit = 0n;
    let credit = 0n;
    for (const line of asArray(journal.lines)) {
      lineIds.push(line.id);
      debit += cents(line.debit) ?? 0n;
      credit += cents(line.credit) ?? 0n;
      if ((cents(line.debit) ?? 0n) > 0n && (cents(line.credit) ?? 0n) > 0n) add(errors, 'SG_JOURNAL_LINE_SIDEDNESS', `journal.${journal.id}.${line.id}`, 'line cannot debit and credit');
    }
    if (debit !== credit) add(errors, 'SG_JOURNAL_UNBALANCED', `journal.${journal.id}`, `${debit} != ${credit}`);
  }
  unique(journalIds, 'journals.id', errors);
  unique(lineIds, 'journals.lines.id', errors);
  if (journalIds.length !== 21) add(errors, 'SG_JOURNAL_COUNT', 'journals', 'must contain opening plus 20 event journals');
}

function validateTrialBalance(book, errors) {
  const netByAccount = new Map();
  for (const journal of [book?.opening_journal, ...asArray(book?.events).map(({ journal: value }) => value)]) {
    for (const line of asArray(journal?.lines)) {
      const net = (cents(line.debit) ?? 0n) - (cents(line.credit) ?? 0n);
      netByAccount.set(line.account_code, (netByAccount.get(line.account_code) ?? 0n) + net);
    }
  }
  const expected = new Map(asArray(book?.trial_balance).map((row) => [row.account_code, (cents(row.debit) ?? 0n) - (cents(row.credit) ?? 0n)]));
  for (const [code, net] of netByAccount) {
    if (net !== 0n && expected.get(code) !== net) add(errors, 'SG_TRIAL_BALANCE_ACCOUNT', `book.trial_balance.${code}`, `${expected.get(code)} != ${net}`);
    if (net === 0n && expected.has(code)) add(errors, 'SG_TRIAL_BALANCE_ZERO_ACCOUNT', `book.trial_balance.${code}`, 'zero account must be omitted');
  }
  for (const [code, net] of expected) if ((netByAccount.get(code) ?? 0n) !== net) add(errors, 'SG_TRIAL_BALANCE_ACCOUNT', `book.trial_balance.${code}`, `${net} != ${netByAccount.get(code)}`);
  const debit = asArray(book?.trial_balance).reduce((sum, row) => sum + (cents(row.debit) ?? 0n), 0n);
  const credit = asArray(book?.trial_balance).reduce((sum, row) => sum + (cents(row.credit) ?? 0n), 0n);
  if (debit !== 3_800_480n || credit !== 3_800_480n || debit !== credit) add(errors, 'SG_TRIAL_BALANCE_TOTAL', 'book.trial_balance', `${debit}/${credit}`);
}

function validateGstF5(book, errors) {
  const sum = (key) => asArray(book?.events).reduce((total, item) => total + (cents(item.gst?.[key]) ?? 0n), 0n);
  const box1 = sum('box1');
  const box2 = sum('box2');
  const exempt = sum('exempt_non_fx_box3');
  const fx = sum('realized_fx');
  const calculated = {
    box1,
    box2,
    box3: exempt + abs(fx),
    box4: box1 + box2 + exempt + abs(fx),
    box5: sum('box5'),
    box6: sum('box6'),
    box7: sum('box7'),
    box8: sum('box6') - sum('box7'),
    box9: 0n,
    box13: sum('box13'),
    box14: sum('box14'),
    exempt_non_fx_box3: exempt,
    realized_fx_net: fx,
  };
  for (const [key, value] of Object.entries(calculated)) {
    if (cents(book?.gst_f5?.[key]) !== value) add(errors, 'SG_GST_F5_MISMATCH', `book.gst_f5.${key}`, `${cents(book?.gst_f5?.[key])} != ${value}`);
  }
  const pinned = { box1: 630000n, box2: 282000n, box3: 4780n, box4: 916780n, box5: 615000n, box6: 56700n, box7: 55350n, box8: 1350n, box9: 0n, box13: 1036780n, box14: 0n };
  for (const [key, value] of Object.entries(pinned)) if (calculated[key] !== value) add(errors, 'SG_GST_F5_PIN', `book.gst_f5.${key}`, `${calculated[key]} != ${value}`);
  const rc = book?.reverse_charge_alternative;
  if (cents(rc?.base_sgd) !== 53600n || cents(rc?.box1_increment) !== 53600n || cents(rc?.box14_increment) !== 53600n || cents(rc?.box6_increment) !== 4824n || rc?.box7_increment !== 'conditional_on_input_tax_entitlement' || rc?.base_fixture_posting !== 'none_on_owner') {
    add(errors, 'SG_REVERSE_CHARGE_ALTERNATIVE', 'book.reverse_charge_alternative', 'must preserve the fact-dependent alternative');
  }
}

function validateMatchEconomics(book, errors) {
  const eventById = new Map(asArray(book?.events).map((item) => [item.id, item]));
  const lineById = new Map(asArray(book?.bank_lines).map((item) => [item.id, item]));
  const e02 = eventById.get('E02');
  if ((cents(e02?.gst?.box1) ?? 0n) + (cents(e02?.gst?.box6) ?? 0n) !== cents(lineById.get('b002')?.amount)
    || (cents(e02?.gst?.box6) ?? 0n) * 109n !== (cents(lineById.get('b002')?.amount) ?? 0n) * 9n) add(errors, 'SG_GST_INCLUSIVE_9_109', 'book.events.E02', 'inclusive split does not equal 9/109');
  const e08 = eventById.get('E08');
  const netRevenue = journalNetCredit(e08?.journal, '3000');
  const netOutputGst = journalNetCredit(e08?.journal, '2950');
  const fee = journalNetDebit(e08?.journal, '7800');
  const feeGst = journalNetDebit(e08?.journal, '2951');
  const cash = journalNetDebit(e08?.journal, '1910');
  if (netRevenue !== 280000n || netOutputGst !== 25200n || fee !== 10000n || feeGst !== 900n || cash !== 294300n || netRevenue + netOutputGst - fee - feeGst !== cash) add(errors, 'SG_PAYOUT_ECONOMICS', 'book.events.E08', 'gross/refund/fee/net relationship failed');
  const e06 = eventById.get('E06');
  if (journalNetDebit(e06?.journal, '7800') !== 34800n || journalNetDebit(e06?.journal, '2951') !== 0n || journalNetDebit(e06?.journal, '3900') !== 240n || cents(lineById.get('b006')?.sgd_measurement) !== -35040n) add(errors, 'SG_FOREIGN_VAT_OR_FX', 'book.events.E06', 'foreign VAT exclusion or realised FX failed');
  for (const [id, cashIds, expectedFx] of [['E10', ['b011', 'b012'], 520n], ['E11', ['b013', 'b014'], 1000n]]) {
    const item = eventById.get(id);
    if (canonicalJson(item?.bank_line_ids) !== canonicalJson(cashIds) || cents(item?.gst?.realized_fx) !== expectedFx) add(errors, 'SG_FX_GROUP', `book.events.${id}`, 'FX group or result mismatch');
  }
  if (journalNetDebit(eventById.get('E12')?.journal, '1910') !== 0n || sumGst(eventById.get('E12')) !== 0n) add(errors, 'SG_INTERNAL_TRANSFER', 'book.events.E12', 'own-account transfer created economics');
  if (cents(eventById.get('E20')?.gst?.box1) !== 0n || cents(eventById.get('E20')?.gst?.box13) !== 120000n) add(errors, 'SG_OUT_OF_SCOPE', 'book.events.E20', 'out-of-scope treatment mismatch');
}

function validateCashBridge(book, errors) {
  const latest = asArray(book?.statements).filter(({ month }) => month === '2026-03');
  const statement = latest.reduce((sum, row) => sum + (cents(row.closing_sgd_measurement) ?? 0n), 0n);
  const owner = asArray(book?.owner_cases).reduce((sum, row) => sum + (cents(row.sgd_movement) ?? 0n), 0n);
  const postedBank = trialNet(book, '1910');
  const pettyCash = trialNet(book, '1900');
  const revenue = ['3000', '3200', '3900', '9300'].reduce((sum, code) => sum - trialNet(book, code), 0n);
  const expense = ['4000', '4400', '7000', '7600', '7800'].reduce((sum, code) => sum + trialNet(book, code), 0n);
  const profit = revenue - expense;
  const gstPayable = -trialNet(book, '2950') - trialNet(book, '2951');
  const cash = postedBank + pettyCash;
  const expected = book?.controls ?? {};
  for (const [pathName, actual] of [
    ['statement_closing_sgd', statement], ['owner_pending_movement_sgd', owner], ['posted_bank_control_sgd', postedBank],
    ['petty_cash_sgd', pettyCash], ['cash_and_cash_equivalents_sgd', cash], ['revenue_and_other_income_sgd', revenue],
    ['expenses_sgd', expense], ['profit_sgd', profit], ['input_gst_asset_sgd', trialNet(book, '2951')],
    ['output_gst_liability_sgd', -trialNet(book, '2950')],
  ]) if (cents(expected[pathName]) !== actual) add(errors, 'SG_CASH_CONTROL', `book.controls.${pathName}`, `${cents(expected[pathName])} != ${actual}`);
  if (statement - postedBank !== owner || owner !== -498600n) add(errors, 'SG_UNEXPLAINED_BANK_LINE', 'book.controls.owner_pending_movement_sgd', `${statement} - ${postedBank} != ${owner}`);
  if (cents(expected.cash_increase_sgd) !== cash - (cents(expected.opening_cash_sgd) ?? 0n) || (cents(expected.cash_increase_sgd) ?? 0n) !== profit + gstPayable) add(errors, 'SG_CASH_BRIDGE', 'book.controls.cash_increase_sgd', 'cash increase must equal profit plus GST payable');
  const closingEquity = 2000000n + 707000n + profit;
  const assets = cash + trialNet(book, '2951');
  if (cents(expected.closing_equity_sgd) !== closingEquity || cents(expected.assets_including_input_gst_sgd) !== assets || assets !== closingEquity + (-trialNet(book, '2950'))) add(errors, 'SG_BALANCE_SHEET', 'book.controls', 'assets do not equal liabilities plus equity');
}

function validateTerminalStates(book, errors) {
  const values = [
    ...asArray(book?.bank_lines).map(({ terminal }) => terminal),
    ...asArray(book?.statements).map(({ terminal }) => terminal),
    ...asArray(book?.evidence).map(({ terminal }) => terminal),
    ...asArray(book?.events).map(({ terminal }) => terminal),
    ...asArray(book?.owner_cases).map(({ terminal }) => terminal),
    ...asArray(book?.cross_entity_decoys).map(({ terminal }) => terminal),
  ];
  for (const value of values) if (!TERMINALS.has(value)) add(errors, 'SG_NON_TERMINAL_STATE', 'terminal', String(value));
  if (asArray(book?.bank_lines).filter(({ terminal }) => terminal === 'auto_reconciled').length !== 23 || asArray(book?.bank_lines).filter(({ terminal }) => terminal === 'on_owner').length !== 8) add(errors, 'SG_TERMINAL_COUNTS', 'book.bank_lines', 'must be 23 auto-reconciled and 8 on-owner');
  for (const event of asArray(book?.events)) if (event.terminal !== 'auto_reconciled') add(errors, 'SG_EVENT_NOT_TERMINAL', `book.events.${event.id}`, event.terminal);
}

function validateOwnerCases(book, errors) {
  if (count(book?.owner_cases) !== 8) add(errors, 'SG_OWNER_CASE_COUNT', 'book.owner_cases', 'must contain 8 cases');
  for (const item of asArray(book?.owner_cases)) {
    const line = asArray(book?.bank_lines).find(({ id }) => id === item.bank_line_id);
    if (line?.terminal !== 'on_owner' || line?.group_id !== item.id) add(errors, 'SG_OWNER_LINE_STATE', `book.owner_cases.${item.id}`, 'line must rest on this owner case');
    if (item.actor_id !== 'principal/owner-sg-demo-1' || item.audience !== 'customer_human' || item.authority_basis !== 'missing_business_fact' || item.expected_coding !== 'blocked_missing_business_fact' || item.terminal !== 'on_owner') add(errors, 'SG_OWNER_RECEIPT', `book.owner_cases.${item.id}`, 'actor/audience/authority/coding/terminal mismatch');
    if (typeof item.question !== 'string' || item.question.length < 40 || !item.question.includes('?')) add(errors, 'SG_OWNER_QUESTION', `book.owner_cases.${item.id}.question`, 'question must be explicit');
  }
  if (asArray(book?.owner_cases).find(({ id }) => id === 'U02')?.question.includes('reverse charge')) add(errors, 'SG_OWNER_TAX_CONCLUSION', 'book.owner_cases.U02.question', 'must ask for business facts, not a tax conclusion');
}

function validateCrossEntityIsolation(book, errors) {
  if (count(book?.cross_entity_decoys) !== 1) return add(errors, 'SG_DECOY_COUNT', 'book.cross_entity_decoys', 'must contain one sibling decoy');
  const source = asArray(book?.bank_lines).find(({ id }) => id === 'b001');
  const decoy = book.cross_entity_decoys[0];
  for (const key of ['date', 'currency', 'amount', 'reference']) if (decoy[key] !== source?.[key]) add(errors, 'SG_DECOY_NOT_COLLIDING', `book.cross_entity_decoys[0].${key}`, 'must equal b001');
  if (decoy.entity_id === source?.entity_id || decoy.entity_id !== 'entity_sg_demo_1_sibling' || decoy.expected_match_id !== null) add(errors, 'SG_CROSS_ENTITY_MATCH', 'book.cross_entity_decoys[0]', 'sibling decoy must be unmatched');
  const targetMatch = asArray(book?.events).find(({ id }) => id === 'E01')?.match_id;
  if (targetMatch !== 'match_e01_b001') add(errors, 'SG_PRIMARY_MATCH', 'book.events.E01.match_id', 'unexpected primary match');
}

function validateEvidenceReceipts(book, evidenceReceipts, evidenceDir, verifyEvidenceBytes, errors) {
  if (evidenceReceipts?.world_id !== 'sg-demo-1/evidence-v1' || evidenceReceipts?.world_seed !== 'sg-demo-1-evidence-seed-v1') add(errors, 'SG_EVIDENCE_WORLD', 'evidence_receipts', 'world identity mismatch');
  if (evidenceReceipts?.renderer_version !== 'proof0.worldRenderer.v1') add(errors, 'SG_EVIDENCE_RENDERER', 'evidence_receipts.renderer_version', 'unexpected renderer');
  const expectedRows = [...asArray(book?.statements), ...asArray(book?.evidence)].map(({ id, filename, terminal }) => ({ id, file: filename, terminal })).sort(compareId);
  const actualRows = asArray(evidenceReceipts?.artifacts).slice().sort(compareId);
  exactOrder(asArray(evidenceReceipts?.artifacts).map(({ id }) => id), actualRows.map(({ id }) => id), 'evidence_receipts.artifacts', errors);
  unique(actualRows.map(({ id }) => id), 'evidence_receipts.artifacts.id', errors);
  if (expectedRows.length !== 33 || actualRows.length !== expectedRows.length) add(errors, 'SG_EVIDENCE_COUNT', 'evidence_receipts.artifacts', `${actualRows.length} != 33`);
  for (let index = 0; index < Math.min(expectedRows.length, actualRows.length); index += 1) {
    const expected = expectedRows[index];
    const actual = actualRows[index];
    if (actual.id !== expected.id || actual.file !== expected.file || actual.terminal !== 'auto_reconciled' || actual.terminal !== expected.terminal) add(errors, 'SG_EVIDENCE_IDENTITY', `evidence_receipts.artifacts[${index}]`, 'id/file/terminal mismatch');
    if (actual.frozen_date !== '2026-06-08T00:00:00.000Z') add(errors, 'SG_EVIDENCE_FROZEN_DATE', `evidence_receipts.artifacts.${actual.id}.frozen_date`, 'unexpected renderer clock');
    if (!SHA256.test(actual.sha256 ?? '') || !Number.isSafeInteger(actual.byte_length) || actual.byte_length <= 0) add(errors, 'SG_EVIDENCE_RECEIPT', `evidence_receipts.artifacts.${actual.id}`, 'invalid digest or byte length');
    if (verifyEvidenceBytes) {
      let bytes;
      try { bytes = readFileSync(path.join(evidenceDir, actual.file)); } catch { add(errors, 'SG_EVIDENCE_MISSING', `evidence_receipts.artifacts.${actual.id}`, actual.file); continue; }
      if (bytes.length !== actual.byte_length || digest(bytes) !== actual.sha256) add(errors, 'SG_EVIDENCE_BYTE_DRIFT', `evidence_receipts.artifacts.${actual.id}`, actual.file);
    }
  }
}

function validateJournalShape(journal, pathName, errors) {
  exactKeys(journal, ['id', 'date', 'currency', 'lines'], pathName, errors);
  if (!ISO_DAY.test(journal?.date ?? '') || journal?.currency !== 'SGD') add(errors, 'SG_SCHEMA_FORMAT', pathName, 'journal date/currency invalid');
  asArray(journal?.lines).forEach((row, index) => {
    exactKeys(row, ['id', 'account_code', 'debit', 'credit'], `${pathName}.lines[${index}]`, errors);
    moneyFields(row, ['debit', 'credit'], `${pathName}.lines[${index}]`, errors);
  });
}

function validateCommonFormats(row, pathName, errors) {
  if (!ISO_DAY.test(row?.date ?? '')) add(errors, 'SG_SCHEMA_FORMAT', `${pathName}.date`, 'must be YYYY-MM-DD');
  if (!ISO_CURRENCY.test(row?.currency ?? '')) add(errors, 'SG_SCHEMA_FORMAT', `${pathName}.currency`, 'must be ISO 4217');
}

function checkCanonicalText(value, text, pathName, errors) {
  let expected;
  try { expected = `${canonicalJson(value)}\n`; } catch (error) { return add(errors, 'SG_CANONICAL_VALUE', pathName, error.message); }
  if (text !== expected) add(errors, 'SG_CANONICAL_BYTES', pathName, 'must be canonical JSON with one trailing newline');
}

function exactKeys(value, allowed, pathName, errors) {
  if (!isPlainObject(value)) return add(errors, 'SG_SCHEMA_OBJECT', pathName, 'must be an object');
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) add(errors, 'SG_SCHEMA_UNSUPPORTED_FIELD', `${pathName}.${key}`, 'unsupported field');
  for (const key of allowed) if (!Object.hasOwn(value, key)) add(errors, 'SG_SCHEMA_MISSING_FIELD', `${pathName}.${key}`, 'missing field');
}

function moneyFields(value, fields, pathName, errors) {
  for (const field of fields) if (!MONEY.test(value?.[field] ?? '')) add(errors, 'SG_SCHEMA_MONEY', `${pathName}.${field}`, 'must be an exact two-decimal string');
}

function exactOrder(actual, expected, pathName, errors) {
  if (canonicalJson(actual) !== canonicalJson(expected)) add(errors, 'SG_ARRAY_ORDER', pathName, 'array order differs from the canonical fixture');
}

function unique(values, pathName, errors) {
  const set = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value === '') add(errors, 'SG_ID_INVALID', pathName, String(value));
    else if (set.has(value)) add(errors, 'SG_ID_DUPLICATE', pathName, value);
    set.add(value);
  }
  return set;
}

function cents(value) {
  if (!MONEY.test(value ?? '')) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split('.');
  const result = (BigInt(whole) * 100n) + BigInt(fraction);
  return negative ? -result : result;
}

function trialNet(book, code) {
  const row = asArray(book?.trial_balance).find(({ account_code }) => account_code === code);
  return row ? (cents(row.debit) ?? 0n) - (cents(row.credit) ?? 0n) : 0n;
}

function journalNetDebit(journal, code) {
  return asArray(journal?.lines).filter(({ account_code }) => account_code === code).reduce((sum, line) => sum + (cents(line.debit) ?? 0n) - (cents(line.credit) ?? 0n), 0n);
}

function journalNetCredit(journal, code) {
  return -journalNetDebit(journal, code);
}

function sumGst(event) {
  return Object.values(event?.gst ?? {}).reduce((sum, value) => sum + (cents(value) ?? 0n), 0n);
}

function sumTrialSide(rows, side) {
  const total = asArray(rows).reduce((sum, row) => sum + (cents(row?.[side]) ?? 0n), 0n);
  return money(total);
}

function money(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function safeCanonical(value) {
  try { return canonicalJson(value); } catch { return 'null'; }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function add(errors, code, pathName, message) {
  errors.push(Object.freeze({ code, path: pathName, message }));
}

function sequence(prefix, length, pad) {
  return Array.from({ length }, (_, index) => `${prefix}${String(index + 1).padStart(pad, '0')}`);
}

function abs(value) { return value < 0n ? -value : value; }
function count(value) { return Array.isArray(value) ? value.length : 0; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function compareId(left, right) { return String(left.id).localeCompare(String(right.id)); }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
