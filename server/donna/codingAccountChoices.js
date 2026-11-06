// One native identity/menu contract. Database callers supply verified birth
// lineage; model-facing projections contain call-local handles, never row ids.
import { nativeBirthAccounts, nativeBirthDefinition, nativeChartDigest, nativeRegistrationPolicyForLineage } from './nativeChartLineage.js';

export const UNRESOLVED_CODING_CHOICE = 'unresolved';
export const codingChoiceFailure = reason => {
  throw Object.assign(new Error(`Native coding choice refused: ${reason}`), {
    code: 'NATIVE_CODING_CHOICE_INVALID', statusCode: 409, details: { reason }
  });
};
export const nativeCodingContext = (lineage, profile = {}, registrationEvidence = null) => {
  if (!lineage) return null;
  const { metadata } = lineage.receipt;
  return {
    contract_id: metadata.birth_contract, client_life: lineage.client_life,
    receipt_id: lineage.receipt.id, receipt_digest: metadata.receipt_digest,
    selection_digest: metadata.selection_digest, menu_contract_version: metadata.menu_contract_version,
    birth_registration_digest: metadata.registration_digest,
    registration_observation: { revision: 'profile.gst_registration.observation.v1', record: profile.gst_registration ?? null },
    registration_evidence: registrationEvidence
  };
};

export const nativeAccountChoices = (context, { businessDate = null } = {}) => {
  if (!context) return null;
  const definition = nativeBirthDefinition(context.contract_id);
  if (context.selection_digest !== definition.selection_digest
    || context.menu_contract_version !== definition.menu_contract_version
    || !context.client_life?.firm_id || !context.client_life?.client_id
    || !context.receipt_id || !context.receipt_digest
    || context.registration_observation?.revision !== 'profile.gst_registration.observation.v1') {
    codingChoiceFailure('menu_contract_invalid');
  }
  const registration = nativeRegistrationPolicyForLineage({ definition });
  const registrationEligibility = registration.resolveOnDate({
    evidence: context.registration_evidence || { registration: context.registration_observation.record }, onDate: businessDate
  });
  const accounts = nativeBirthAccounts({ contractId: context.contract_id,
    firmId: context.client_life.firm_id, clientId: context.client_life.client_id })
    .filter(account => account.reserved_use === null)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((account, index) => ({ kind: 'account', handle: `account_${index + 1}`, ...account }));
  const choices = [...accounts, { kind: 'unresolved', handle: UNRESOLVED_CODING_CHOICE, name: definition.selection.unresolved_choice.label }];
  return { context, choices, registrationEligibility, aliases: definition.coding_aliases, digest: nativeChartDigest({ context, choices }) };
};

export const accountChoicePrompt = menu => menu?.choices.map(({ kind, handle, code, name, account_type, normal_balance }) =>
  ({ kind, handle, ...(kind === 'account' ? { code, name, account_type, normal_balance } : { name, posting: false }) }));

export const resolveNativeAccountChoice = (menu, input = {}, { allowUnresolved = false, allowAlias = false } = {}) => {
  const present = value => value != null && value !== '';
  const ids = [input.account_id, input.id, input.xero_account_id].filter(present);
  const codes = [input.account_code, input.code, input.xero_account_code].filter(present);
  const names = [input.proposed_account, input.account_name, input.name, input.category, input.xero_account_name].filter(present);
  const labels = [input.label, input.account_label].filter(present);
  const [id] = ids, [code] = codes, [name] = names;
  const handle = input.handle;
  const aliases = allowAlias ? menu.aliases || {} : {};
  const choice = menu.choices.find(row => handle != null ? row.handle === handle
    : id != null ? row.id === id : code != null ? row.code === code
      : aliases[name] ? row.code === aliases[name] : name != null ? row.name === name
        : labels.length && [row.name, `${row.code} · ${row.name}`].includes(labels[0]));
  if (!choice) codingChoiceFailure('account_not_eligible');
  if (choice.kind === 'unresolved' && (!allowUnresolved || ids.length || codes.length)) {
    codingChoiceFailure('unresolved_is_not_an_account');
  }
  if (ids.some(value => value !== choice.id) || codes.some(value => value !== choice.code)
    || names.some(value => value !== choice.name && !(Object.hasOwn(aliases, value) && aliases[value] === choice.code))
    || labels.some(value => ![choice.name, `${choice.code} · ${choice.name}`].includes(value))) {
    codingChoiceFailure('account_identity_mismatch');
  }
  return choice;
};

export const nativeChoiceReceipt = (menu, choice) => ({ version: 1, kind: choice.kind,
  menu_digest: menu.digest, context: menu.context,
  ...(choice.kind === 'account' ? { account_id: choice.id, account_code: choice.code, account_name: choice.name } : {}) });

export const decodeNativeCodingChoice = (menu, suggestion) => {
  if (!menu) return suggestion;
  if (suggestion.missing_account_name || suggestion.missing_account?.name) codingChoiceFailure('unsupported_account_capability');
  const choice = resolveNativeAccountChoice(menu, { handle: suggestion.proposed_account }, { allowUnresolved: true });
  if (choice.kind === 'unresolved' && (suggestion.posting_requirement !== 'owner_fact'
    || !String(suggestion.ask_client_question || '').trim())) codingChoiceFailure('unresolved_requires_missing_fact');
  const decode = (item, allowUnresolved = false) => {
    const resolved = resolveNativeAccountChoice(menu, { handle: item.account }, { allowUnresolved });
    return { ...item, account: resolved.name, native_choice: nativeChoiceReceipt(menu, resolved) };
  };
  return { ...suggestion, proposed_account: choice.name,
    ...(choice.kind === 'account' ? { account_id: choice.id, account_code: choice.code, account_name: choice.name } : {}),
    native_choice: nativeChoiceReceipt(menu, choice),
    document_allocations: (suggestion.document_allocations || []).map(item => decode(item)),
    alternatives: (suggestion.alternatives || []).map(item => decode(item, true)),
    ...(choice.kind === 'unresolved' ? { evidence_required: true, remember_candidate: false, auto_explain_limit: 0 } : {}) };
};

export const assertNativeCodingChoice = (menu, suggestion, { applying = false } = {}) => {
  if (!menu) return;
  const receipt = suggestion.native_choice;
  if (!receipt || receipt.version !== 1 || receipt.menu_digest !== menu.digest
    || nativeChartDigest(receipt.context) !== nativeChartDigest(menu.context)) codingChoiceFailure('choice_receipt_stale');
  const choice = resolveNativeAccountChoice(menu, receipt.kind === 'unresolved'
    ? { handle: UNRESOLVED_CODING_CHOICE } : receipt, { allowUnresolved: !applying });
  if (choice.kind !== receipt.kind) codingChoiceFailure('choice_kind_mismatch');
  if (choice.kind === 'unresolved') resolveNativeAccountChoice(menu, suggestion, { allowUnresolved: true });
  if (choice.kind === 'account' && resolveNativeAccountChoice(menu, suggestion, { allowAlias: true }).id !== choice.id) codingChoiceFailure('account_identity_mismatch');
  if (choice.kind === 'unresolved' && (suggestion.posting_requirement !== 'owner_fact'
    || !suggestion.evidence_required || !String(suggestion.ask_client_question || '').trim())) codingChoiceFailure('unresolved_requires_missing_fact');
  for (const allocation of suggestion.document_allocations || []) {
    assertNativeCodingChoice(menu, { ...allocation.native_choice, native_choice: allocation.native_choice,
      proposed_account: allocation.account }, { applying: true });
  }
};

// Authority receipts stay server-side. Historical account references in source
// context use the same call-local map; reserved historical rows carry a code,
// never become selectable accounts and never expose an opaque row id.
export const nativeCodingPromptProjection = (value, menu) => {
  if (!menu) return value;
  const accounts = nativeBirthAccounts({ contractId: menu.context.contract_id,
    firmId: menu.context.client_life.firm_id, clientId: menu.context.client_life.client_id });
  const handles = new Map(accounts.map(row => [row.id,
    menu.choices.find(choice => choice.id === row.id)?.handle || `reserved_code_${row.code}`]));
  const authorityFields = new Set(['native_choice', 'native_source', 'native_source_by_transaction', 'native_coding_sources', 'native_chart',
    'gst_registration_revision', 'source_document_id']);
  const project = item => {
    if (typeof item === 'string') return handles.get(item) || item;
    if (Array.isArray(item)) return item.map(project);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !authorityFields.has(key)).map(([key, child]) =>
      [key === 'account_id' ? 'account_handle' : key, key === 'account_id' ? handles.get(child) || null : project(child)]));
  };
  const projected = project(value);
  const eligibility = menu.registrationEligibility;
  if (!eligibility || !projected || Array.isArray(projected) || typeof projected !== 'object') return projected;
  const projectEligibility = result => {
    const { source_document_id, ...facts } = result.registration || {};
    return { ...result, registration: result.registration ? facts : null,
      source_document_recorded: Boolean(source_document_id),
      instruction: 'Registration evidence is limited to the recorded interval. Unknown or outside-interval is not No GST, exempt or zero-rated. This projection grants no GST posting authority.' };
  };
  const transactions = value.transactions || value.feed_rows || (value.transaction ? [value.transaction] : []);
  return { ...projected, native_registration: projectEligibility(eligibility),
    ...(transactions.length ? { native_registration_by_transaction: Object.fromEntries(transactions.filter(row => row.id)
      .map(row => [row.id, projectEligibility(nativeAccountChoices(menu.context,
        { businessDate: row.date ?? row.transaction_date ?? null }).registrationEligibility)])) } : {}) };
};
