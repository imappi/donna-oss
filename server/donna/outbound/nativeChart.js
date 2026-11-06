// Inactive authored reference data, not a seeding/coding/registration policy.
// No pack loader or policy registry import: chart readers also enter through
// the statutory composition root. The role registry's transitive imports are
// covered by the cold-import proof, not assumed to be a data-only leaf.
import { isAccountRole } from '../accountRoles.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const key = value => text(value) && /^[a-z][a-z0-9_]*$/.test(value);
const accountTypes = new Set([
  'asset', 'intangible_asset', 'tangible_asset', 'investment', 'inventory',
  'receivable', 'cash', 'bank', 'equity', 'liability', 'revenue', 'expense'
]);

export const validateNativeChart = chart => {
  const errors = [];
  const fail = message => errors.push(`chart_of_accounts.native_chart.${message}`);
  const fields = (value, required, optional, at) => {
    if (!object(value)) { fail(`${at} must be an object`); return false; }
    for (const name of required) if (!Object.hasOwn(value, name)) fail(`${at}.${name} required`);
    for (const name of Object.keys(value)) {
      if (![...required, ...optional].includes(name)) fail(`${at}.${name} unsupported`);
    }
    return true;
  };
  const map = (value, at) => {
    if (!object(value) || !Object.keys(value).length) { fail(`${at} must be a nonempty object`); return []; }
    for (const name of Object.keys(value)) if (!key(name)) fail(`${at} has invalid key '${name}'`);
    return Object.entries(value);
  };
  if (!fields(chart, ['id', 'version', 'usage', 'provenance', 'reporting_groups', 'account_sets', 'code_sets', 'group_sets'], ['selections'], 'definition')) {
    return { ok: false, errors };
  }
  if (!key(chart.id)) fail('id must be an identifier');
  if (!Number.isSafeInteger(chart.version) || chart.version < 1) fail('version must be a positive integer');
  // This is descriptive provenance, never a rollout switch. No consumer of
  // this declaration seeds a book, changes a coding menu or grants authority.
  if (chart.usage !== 'reference_only') fail('usage must be reference_only');
  if (fields(chart.provenance, ['kind', 'source_revision', 'review_status'], [], 'provenance')) {
    if (chart.provenance.kind !== 'authored_product_data') fail('provenance.kind must be authored_product_data');
    if (!text(chart.provenance.source_revision) || !/^[a-f0-9]{40}$/.test(chart.provenance.source_revision)) fail('provenance.source_revision must be a commit SHA');
    if (chart.provenance.review_status !== 'unreviewed') fail('provenance.review_status must be unreviewed');
  }
  const groups = new Set();
  for (const [name, group] of map(chart.reporting_groups, 'reporting_groups')) {
    groups.add(name);
    if (!fields(group, ['statement', 'name_en'], ['side'], `reporting_groups.${name}`)) continue;
    if (!text(group.name_en)) fail(`reporting_groups.${name}.name_en must be nonempty trimmed text`);
    if (!['balance_sheet', 'income_statement'].includes(group.statement)) fail(`reporting_groups.${name}.statement invalid`);
    if (group.statement === 'balance_sheet' && !['assets', 'equity', 'liabilities'].includes(group.side)) fail(`reporting_groups.${name}.side required`);
    if (group.statement === 'income_statement' && Object.hasOwn(group, 'side')) fail(`reporting_groups.${name}.side unsupported for income_statement`);
  }
  const codes = new Set();
  const names = new Set();
  if (!object(chart.account_sets) || !Object.hasOwn(chart.account_sets, 'base')) fail('account_sets.base required');
  for (const [set, rows] of map(chart.account_sets, 'account_sets')) {
    if (!Array.isArray(rows) || !rows.length) { fail(`account_sets.${set} must be a nonempty array`); continue; }
    for (const [index, row] of rows.entries()) {
      const at = `account_sets.${set}[${index}]`;
      if (!fields(row, ['code', 'name_en', 'account_type', 'normal_balance', 'statutory_group', 'canonical_role'], [], at)) continue;
      if (!text(row.code) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.code)) fail(`${at}.code invalid`);
      else if (codes.has(row.code)) fail(`${at}.code duplicate '${row.code}'`);
      else codes.add(row.code);
      if (!text(row.name_en)) fail(`${at}.name_en must be nonempty trimmed text`);
      else {
        const name = row.name_en.toLowerCase();
        if (names.has(name)) fail(`${at}.name_en duplicate '${row.name_en}'`);
        names.add(name);
      }
      if (!accountTypes.has(row.account_type)) fail(`${at}.account_type invalid`);
      if (!['debit', 'credit'].includes(row.normal_balance)) fail(`${at}.normal_balance invalid`);
      if (!groups.has(row.statutory_group)) fail(`${at}.statutory_group unknown`);
      if (row.canonical_role !== null && (!text(row.canonical_role) || !isAccountRole(row.canonical_role))) fail(`${at}.canonical_role must be null or a canonical role`);
    }
  }
  for (const [field, inventory] of [['code_sets', codes], ['group_sets', groups]]) {
    for (const [name, values] of map(chart[field], field)) {
      if (!Array.isArray(values) || !values.length) { fail(`${field}.${name} must be a nonempty array`); continue; }
      const seen = new Set();
      for (const value of values) {
        if (!inventory.has(value)) fail(`${field}.${name} unknown reference '${value}'`);
        if (seen.has(value)) fail(`${field}.${name} duplicate reference '${value}'`);
        seen.add(value);
      }
    }
  }
  if (Object.hasOwn(chart, 'selections')) {
    for (const [name, selection] of map(chart.selections, 'selections')) {
      const at = `selections.${name}`;
      if (!fields(selection, ['version', 'status', 'jurisdiction', 'legal_form', 'account_sets', 'role_annotations', 'reserved_uses', 'unresolved_choice'], [], at)) continue;
      if (!Number.isSafeInteger(selection.version) || selection.version < 1) fail(`${at}.version invalid`);
      if (selection.status !== 'provisional') fail(`${at}.status must be provisional`);
      if (!text(selection.jurisdiction) || !/^[a-z]{2}$/.test(selection.jurisdiction)) fail(`${at}.jurisdiction invalid`);
      if (!text(selection.legal_form) || !selection.legal_form.startsWith(`${selection.jurisdiction}-`) || !/^[a-z]{2}-[a-z][a-z0-9-]*$/.test(selection.legal_form)) fail(`${at}.legal_form invalid`);
      const selectedCodes = new Set();
      const selectedSets = new Set();
      if (!Array.isArray(selection.account_sets) || !selection.account_sets.length) fail(`${at}.account_sets must be nonempty`);
      else for (const set of selection.account_sets) {
        if (!text(set) || !object(chart.account_sets) || !Object.hasOwn(chart.account_sets, set) || !Array.isArray(chart.account_sets[set])) {
          fail(`${at}.account_sets unknown reference '${set}'`);
          continue;
        }
        if (selectedSets.has(set)) fail(`${at}.account_sets duplicate '${set}'`);
        selectedSets.add(set);
        for (const row of chart.account_sets[set]) if (object(row)) selectedCodes.add(row.code);
      }
      // Annotations belong to this candidate, not the compatibility reference.
      if (!object(selection.role_annotations)) fail(`${at}.role_annotations must be an object`);
      else for (const [code, role] of Object.entries(selection.role_annotations)) {
        if (!selectedCodes.has(code)) fail(`${at}.role_annotations unknown selected code '${code}'`);
        if (role !== null && (!text(role) || !isAccountRole(role))) fail(`${at}.role_annotations.${code} invalid role`);
      }
      const reservedCodes = new Set();
      if (!object(selection.reserved_uses)) fail(`${at}.reserved_uses must be an object`);
      else for (const [use, references] of Object.entries(selection.reserved_uses)) {
        if (!key(use)) fail(`${at}.reserved_uses invalid use '${use}'`);
        if (!Array.isArray(references) || !references.length) { fail(`${at}.reserved_uses.${use} must be nonempty`); continue; }
        for (const code of references) {
          if (!selectedCodes.has(code)) fail(`${at}.reserved_uses.${use} unknown selected code '${code}'`);
          if (reservedCodes.has(code)) fail(`${at}.reserved_uses duplicate '${code}'`);
          reservedCodes.add(code);
        }
      }
      const choice = selection.unresolved_choice;
      if (fields(choice, ['id', 'label', 'posting'], [], `${at}.unresolved_choice`)) {
        if (choice.id !== 'unresolved') fail(`${at}.unresolved_choice.id must be unresolved`);
        if (!text(choice.label)) fail(`${at}.unresolved_choice.label invalid`);
        if (choice.posting !== false) fail(`${at}.unresolved_choice.posting must be false`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
};

// Pure validated read of an optional declaration; no file IO or policy choice.
export const nativeChartForPack = pack => {
  if (!object(pack?.chart_of_accounts) || !Object.hasOwn(pack.chart_of_accounts, 'native_chart')) return null;
  const chart = pack.chart_of_accounts.native_chart;
  const result = validateNativeChart(chart);
  if (!result.ok) throw new TypeError(`Invalid native chart: ${result.errors.join('; ')}`);
  return structuredClone(chart);
};

// Pure candidate read only. This does not select a client's birth contract or
// certify an empty book. No date/registration value can grant control use here.
export const selectNativeChartForPack = (pack, { selectionId, jurisdiction, legalForm } = {}) => {
  const chart = nativeChartForPack(pack);
  if (!chart || !text(selectionId) || !Object.hasOwn(chart.selections || {}, selectionId)) throw new TypeError('Native chart selection unavailable');
  const selection = chart.selections[selectionId];
  if (jurisdiction !== pack.pack?.id || jurisdiction !== selection.jurisdiction || legalForm !== selection.legal_form) {
    throw new TypeError('Native chart selection identity unsupported');
  }
  const reserved = new Map(Object.entries(selection.reserved_uses).flatMap(([use, codes]) => codes.map(code => [code, use])));
  const accounts = selection.account_sets.flatMap(set => chart.account_sets[set]).map(row => ({
    ...row,
    canonical_role: Object.hasOwn(selection.role_annotations, row.code) ? selection.role_annotations[row.code] : row.canonical_role,
    reserved_use: reserved.get(row.code) ?? null
  }));
  return {
    native_chart_id: chart.id,
    native_chart_version: chart.version,
    usage: chart.usage,
    provenance: chart.provenance,
    selection_id: selectionId,
    selection_version: selection.version,
    status: selection.status,
    jurisdiction: selection.jurisdiction,
    legal_form: selection.legal_form,
    accounts,
    reporting_groups: chart.reporting_groups,
    reserved_uses: selection.reserved_uses,
    ordinary_account_codes: accounts.filter(row => row.reserved_use === null).map(row => row.code),
    unresolved_choice: selection.unresolved_choice
  };
};
