import { createHash } from 'node:crypto';

export const AE_ARABIC_EVIDENCE_EVAL_VERSION = 'ae.arabic-evidence-eval.v1';
export const AE_ARABIC_EVIDENCE_WORLD_ID = 'ae-arabic-evidence-owner-chat-v1';
export const AE_ARABIC_EVIDENCE_LIVE_RUNS = 3;

const PRESENTATIONS = new Set(['english', 'arabic', 'bilingual']);
const EVIDENCE_KINDS = new Set(['unified_document', 'bank_statement']);
const ARABIC = /\p{Script=Arabic}/u;

const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const atPath = (value, path) => String(path).split('.').reduce((current, key) => current?.[key], value);
const same = (left, right) => canonical(left) === canonical(right);
const rate = (count, total) => total ? count / total : null;

export function validateAeArabicEvidenceWorld(world) {
  const errors = [];
  if (!plain(world)) return Object.freeze({ ok: false, errors: ['world must be an object'] });
  if (world.version !== AE_ARABIC_EVIDENCE_EVAL_VERSION) errors.push(`version must be ${AE_ARABIC_EVIDENCE_EVAL_VERSION}`);
  if (world.world_id !== AE_ARABIC_EVIDENCE_WORLD_ID) errors.push(`world_id must be ${AE_ARABIC_EVIDENCE_WORLD_ID}`);
  if (!plain(world.provenance) || world.provenance.customer_data !== false || !nonEmpty(world.provenance.authority)) {
    errors.push('provenance must state its authority and customer_data=false');
  }
  if (!plain(world.limits) || world.limits.max_provider_calls_per_run !== 16 || world.limits.live_runs !== AE_ARABIC_EVIDENCE_LIVE_RUNS) {
    errors.push('limits must predeclare 16 provider calls per run and 3 live runs');
  }
  const caps = Array.isArray(world.live_provider_caps) ? world.live_provider_caps : [];
  const anthropicCap = caps.find((cap) => cap?.provider === 'anthropic');
  const openAiCap = caps.find((cap) => cap?.provider === 'openai');
  if (caps.length !== 2
      || anthropicCap?.max_calls_per_run !== 14
      || anthropicCap?.max_input_tokens_per_call !== 50_000
      || anthropicCap?.max_output_tokens_per_call !== 8_192
      || openAiCap?.max_calls_per_run !== 2
      || openAiCap?.max_input_tokens_per_call !== 50_000
      || openAiCap?.max_output_tokens_per_call !== 4_096) {
    errors.push('live_provider_caps must pin the predeclared 14/2 call and token ceilings');
  }
  validatePairs(world.evidence_pairs, 'evidence_pairs', errors, ({ pair, item, label }) => {
    if (!EVIDENCE_KINDS.has(pair.kind)) errors.push(`${label}.kind is invalid`);
    if (!nonEmpty(item.recording)) errors.push(`${label}.recording is required`);
    if (!plain(item.artifact) || !nonEmpty(item.artifact.mime_type)) errors.push(`${label}.artifact is required`);
    if (!plain(pair.expected) || !Array.isArray(pair.material_fields) || !pair.material_fields.length) {
      errors.push(`${label} needs expected and material_fields`);
    }
  });
  validatePairs(world.owner_chat_pairs, 'owner_chat_pairs', errors, ({ pair, item, label }) => {
    if (!nonEmpty(item.user_message) || !nonEmpty(item.recording)) errors.push(`${label} needs user_message and recording`);
    if (!plain(pair.context) || !plain(pair.expected)) errors.push(`${label} needs context and expected`);
    if (item.presentation !== 'english' && !ARABIC.test(item.user_message)) errors.push(`${label} must contain Arabic owner input`);
  });
  const evidenceCalls = (world.evidence_pairs || []).reduce((sum, pair) => sum + (pair.cases?.length || 0), 0);
  const chatCalls = (world.owner_chat_pairs || []).reduce((sum, pair) => sum + (pair.cases?.length || 0), 0);
  if (evidenceCalls !== 10 || chatCalls !== 6 || evidenceCalls + chatCalls !== world.limits?.max_provider_calls_per_run) {
    errors.push('the bounded corpus must contain exactly 10 evidence calls and 6 owner-chat calls');
  }
  return Object.freeze({ ok: errors.length === 0, errors });
}

function validatePairs(pairs, name, errors, validateItem) {
  if (!Array.isArray(pairs) || !pairs.length) {
    errors.push(`${name} must be a non-empty array`);
    return;
  }
  const pairIds = new Set();
  for (const [pairIndex, pair] of pairs.entries()) {
    const base = `${name}[${pairIndex}]`;
    if (!nonEmpty(pair?.id) || pairIds.has(pair?.id)) errors.push(`${base}.id is missing or duplicated`);
    pairIds.add(pair?.id);
    if (!Array.isArray(pair?.cases) || pair.cases.length !== 2) {
      errors.push(`${base}.cases must contain one English and one Arabic/bilingual case`);
      continue;
    }
    const presentations = new Set(pair.cases.map((item) => item?.presentation));
    if (!presentations.has('english') || ![...presentations].some((value) => value === 'arabic' || value === 'bilingual')) {
      errors.push(`${base}.cases must pair English with Arabic or bilingual`);
    }
    for (const [caseIndex, item] of pair.cases.entries()) {
      const label = `${base}.cases[${caseIndex}]`;
      if (!nonEmpty(item?.id) || !PRESENTATIONS.has(item?.presentation)) errors.push(`${label}.id/presentation is invalid`);
      validateItem({ pair, item, label });
    }
  }
}

export function evaluateAeEvidenceCase({ pair, item, actual, providerReceipt = null } = {}) {
  const failures = [];
  if (!plain(pair) || !plain(item)) failures.push('case contract is missing');
  if (!plain(actual)) failures.push('extraction did not return an object');
  const structuralFields = Array.isArray(pair?.structural_fields) ? pair.structural_fields : [];
  const materialFields = Array.isArray(pair?.material_fields) ? pair.material_fields : [];
  const structuralMismatches = compareFields(pair?.expected, actual, structuralFields);
  const materialMismatches = compareFields(pair?.expected, actual, materialFields);
  const arithmetic = pair?.kind === 'bank_statement'
    ? statementArithmetic(actual)
    : documentArithmetic(actual);
  if (!arithmetic.ok) failures.push(...arithmetic.errors);
  const schemaValid = failures.length === 0 && structuralMismatches.length === 0;
  const materialError = !schemaValid || !arithmetic.ok || materialMismatches.length > 0;
  const correctionRequired = materialError || structuralMismatches.length > 0;
  return Object.freeze({
    id: item?.id || null,
    pair_id: pair?.id || null,
    presentation: item?.presentation || null,
    schema_valid: schemaValid,
    arithmetic_valid: arithmetic.ok,
    material_error: materialError,
    correction_required: correctionRequired,
    material_mismatches: materialMismatches,
    structural_mismatches: structuralMismatches,
    errors: failures,
    provider_receipt: providerReceipt,
    consequence: {
      first_applicable: false,
      accounting_write: false,
      terminal_state: null,
      reason: 'an extraction evaluation does not create a bookkeeping item'
    },
    receipt_digest: digest({ item: item?.id, actual, providerReceipt })
  });
}

export function evaluateAeOwnerChatCase({ pair, item, actual, providerReceipt = null } = {}) {
  const errors = [];
  const text = typeof actual?.text === 'string' ? actual.text.trim() : '';
  const actions = Array.isArray(actual?.actions) ? actual.actions : [];
  if (!text) errors.push('reply text is empty');
  if (item?.presentation !== 'english' && !ARABIC.test(text)) errors.push('Arabic/bilingual owner input did not receive Arabic reply text');
  const expectedTypes = pair?.expected?.action_types || [];
  const actualTypes = actions.map((action) => action?.type || null);
  if (!same(actualTypes, expectedTypes)) errors.push(`action types: expected ${canonical(expectedTypes)}, received ${canonical(actualTypes)}`);
  if (pair?.expected?.evidence_request_id != null) {
    if (actions[0]?.evidence_request_id !== pair.expected.evidence_request_id) errors.push('answer action did not preserve the scoped evidence request id');
    if (actions[0]?.status !== 'proposed') errors.push('answer action is not confirmation-gated as proposed');
  }
  for (const needle of [...(pair?.expected?.required_text || []), ...(item?.required_text || [])]) {
    if (!text.includes(needle)) errors.push(`reply text is missing ${JSON.stringify(needle)}`);
  }
  for (const needle of [...(pair?.expected?.forbidden_text || []), ...(item?.forbidden_text || [])]) {
    if (text.toLocaleLowerCase('en').includes(String(needle).toLocaleLowerCase('en'))) errors.push(`reply text makes forbidden claim ${JSON.stringify(needle)}`);
  }
  const materialError = errors.length > 0;
  return Object.freeze({
    id: item?.id || null,
    pair_id: pair?.id || null,
    presentation: item?.presentation || null,
    schema_valid: plain(actual) && typeof actual?.text === 'string' && Array.isArray(actual?.actions),
    material_error: materialError,
    correction_required: materialError,
    errors,
    provider_receipt: providerReceipt,
    consequence: actions.length
      ? { first_applicable: true, accounting_write: false, terminal_state: 'on_owner', responsible_actor: 'owner', next_step: 'confirm_or_correct' }
      : { first_applicable: false, accounting_write: false, terminal_state: null, responsible_actor: 'none' },
    receipt_digest: digest({ item: item?.id, actual, providerReceipt })
  });
}

export function compareAeArabicWithEnglish({ world, evidenceResults = [], ownerChatResults = [], runMode = 'replay' } = {}) {
  const validation = validateAeArabicEvidenceWorld(world);
  if (!validation.ok) return Object.freeze({ status: 'INCOMPLETE', errors: validation.errors });
  const results = [...evidenceResults, ...ownerChatResults];
  const expectedIds = [
    ...world.evidence_pairs.flatMap((pair) => pair.cases.map((item) => item.id)),
    ...world.owner_chat_pairs.flatMap((pair) => pair.cases.map((item) => item.id))
  ];
  const missing = expectedIds.filter((id) => !results.some((result) => result?.id === id));
  if (missing.length) return Object.freeze({ status: 'INCOMPLETE', errors: [`missing results: ${missing.join(', ')}`] });
  const groups = {
    english: results.filter((result) => result.presentation === 'english'),
    arabic_bilingual: results.filter((result) => result.presentation !== 'english')
  };
  const metrics = Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, {
    cases: rows.length,
    material_errors: rows.filter((row) => row.material_error).length,
    correction_required: rows.filter((row) => row.correction_required).length,
    material_error_rate: rate(rows.filter((row) => row.material_error).length, rows.length),
    correction_required_rate: rate(rows.filter((row) => row.correction_required).length, rows.length),
    correction_rate: rate(rows.filter((row) => row.correction_required).length, rows.length)
  }]));
  const deltas = {
    material_error_rate: metrics.arabic_bilingual.material_error_rate - metrics.english.material_error_rate,
    correction_required_rate: metrics.arabic_bilingual.correction_required_rate - metrics.english.correction_required_rate,
    correction_rate: metrics.arabic_bilingual.correction_rate - metrics.english.correction_rate
  };
  const qualityPass = results.every((row) => !row.material_error)
    && deltas.material_error_rate <= 0
    && deltas.correction_required_rate <= 0;
  const replayOnly = runMode !== 'live';
  return Object.freeze({
    status: qualityPass ? 'PASS' : 'FAIL',
    // This pure comparator has no budget or provider-call authority. The runner may
    // promote a passing live comparison only after it has a counted capture receipt.
    promotion_status: 'INCOMPLETE',
    evidence_class: replayOnly ? 'synthetic_recorded_replay' : 'measured_live_provider',
    language_quality_claim_allowed: false,
    metrics,
    deltas,
    thresholds: { max_material_error_rate_delta: 0, max_correction_required_rate_delta: 0, max_correction_rate_delta: 0, max_errors_per_case: 0 },
    cases: results,
    errors: [],
    receipt_digest: digest({ runMode, metrics, deltas, cases: results.map((row) => row.receipt_digest) })
  });
}

function compareFields(expected, actual, paths) {
  return paths.flatMap((path) => same(atPath(expected, path), atPath(actual, path))
    ? []
    : [{ path, expected: atPath(expected, path), actual: atPath(actual, path) }]);
}

function documentArithmetic(actual) {
  if (actual?.kind !== 'completed_header') return { ok: false, errors: ['unified extraction did not complete'] };
  const header = actual.header || {};
  const components = ['subtotal_amount', 'tax_amount', 'shipping_amount', 'discount_amount', 'rounding_amount'];
  if (![header.total_amount, ...components.map((key) => header[key])].every((value) => value == null || Number.isFinite(Number(value)))) {
    return { ok: false, errors: ['document monetary fields are not numeric'] };
  }
  if (header.subtotal_amount == null || header.tax_amount == null || header.total_amount == null) return { ok: true, errors: [] };
  const calculated = Number(header.subtotal_amount) + Number(header.tax_amount)
    + Number(header.shipping_amount || 0) - Number(header.discount_amount || 0) + Number(header.rounding_amount || 0);
  return Math.abs(calculated - Number(header.total_amount)) <= 0.01
    ? { ok: true, errors: [] }
    : { ok: false, errors: [`document total equation failed: ${calculated} != ${header.total_amount}`] };
}

function statementArithmetic(actual) {
  if (!Array.isArray(actual?.transactions) || !plain(actual?.statement_summary)) {
    return { ok: false, errors: ['statement extraction shape is incomplete'] };
  }
  const summary = actual.statement_summary;
  const opening = Number(summary.opening_balance);
  const closing = Number(summary.closing_balance);
  const deposits = Number(summary.total_deposits);
  const payouts = Number(summary.total_payouts);
  if (![opening, closing, deposits, payouts].every(Number.isFinite)) return { ok: false, errors: ['statement totals are not numeric'] };
  const rowsIn = actual.transactions.reduce((sum, row) => sum + Number(row.money_in || 0), 0);
  const rowsOut = actual.transactions.reduce((sum, row) => sum + Number(row.money_out || 0), 0);
  const errors = [];
  if (Math.abs(opening + deposits - payouts - closing) > 0.01) errors.push('statement opening/deposit/payout/closing equation failed');
  if (Math.abs(rowsIn - deposits) > 0.01 || Math.abs(rowsOut - payouts) > 0.01) errors.push('statement rows do not reconcile to printed totals');
  return { ok: errors.length === 0, errors };
}
