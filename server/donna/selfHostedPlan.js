// Donna — the self-hosted seat's plan: where every lane runs for ONE company
// once some of its lanes are seated on an unqualified self-hosted model.
//
// 2026-11-10 (modelLanes.js SELF_HOSTED_DECISION). Pure (registry + key
// PRESENCE, never a value, never a call). The seat command prints it before
// it writes anything, and the boot banner names the same split, so the person
// who seats a local model reads the COMPLETE list of what still goes to a
// cloud provider for that company — never a quiet substitute. A lane is one
// of:
//   self_hosted   — decided by the seated model over the compatible endpoint
//   cloud:<name>  — stays on the configured cloud provider that will answer
//                   (the lane's own preference order and key presence, the
//                   rule resolveLaneProvider applies)
//   dark          — no provider key for it; it does not run (its own typed
//                   refusal / fail-soft, unchanged)
// with the reason it is not seated (file input, a forced tool call, outbound
// copy, the independent reviewer, the Jev lane, not chosen).
//
// Why a new module: no existing owner answers "where does each lane run for
// this company"; the registry knows lanes, resolveLaneProvider knows one
// lane's provider, the policy store knows rows. This joins them, read-only.

import { MODEL_LANES } from './modelLanes.js';

const KEY_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  typesafe: 'TYPESAFE_API_KEY'
});

// Why a lane cannot take a self-hosted seat (stage-1 lane table, 2026-11-10).
export const NOT_SELF_HOSTABLE_REASON = Object.freeze({
  jev_reconciliation: 'the Typesafe (Jev) lane: its own protocol and flag',
  host_provider_probe: 'operator-only transport probe; sends no company data',
  unified_extraction: 'reads the document file (PDF or image)',
  type_extractors_legacy: 'reads the document file (PDF or image)',
  bank_statement_vision: 'reads the statement file (PDF or image); CSV statements need no model',
  chat_engine: 'forced tool calls; owner-reply interpretation keeps its strong-model guard',
  document_chat: 'not offered in this slice',
  intent_compilation: 'forced tool call',
  knowledge_compose: 'forced tool call',
  memory_extraction: 'not offered in this slice',
  reconciliation_triage: 'not offered in this slice',
  merchant_lookup: 'not offered in this slice',
  louis_qa: 'the independent reviewer must never share a model with the lanes it reviews',
  owner_invoice_command_read: 'not offered in this slice',
  client_intake_draft: 'reads the document file',
  marketing_drafting: 'outbound copy, the most dangerous surface',
  parser_repair: 'reads the document file',
  canonical_role_resolution: 'not offered in this slice',
  document_routing: 'reads the document file (PDF)',
  receipt_classification: 'not offered in this slice'
});

const present = (value) => typeof value === 'string' && value.trim().length > 0;

// Where a lane runs when it is NOT seated: the first of its providers whose
// key is present, else dark.
export const cloudPlacementFor = (lane, env = process.env) => {
  const lit = (lane.providers || []).find((name) => KEY_ENV[name] && present(env?.[KEY_ENV[name]]));
  return lit ? `cloud:${lit}` : 'dark';
};

// `seatedLanes` = the lane ids seated (or to be seated) for the company.
export const buildSelfHostedLanePlan = ({ seatedLanes = [], env = process.env, lanes = MODEL_LANES } = {}) => {
  const seated = new Set(seatedLanes);
  const rows = lanes.map((lane) => {
    if (seated.has(lane.id) && lane.selfHosted) {
      return { lane: lane.id, title: lane.title, where: 'self_hosted', covers: [...lane.selfHosted.covers], reason: null };
    }
    const where = lane.id === 'host_provider_probe' ? 'operator_only' : cloudPlacementFor(lane, env);
    const reason = lane.selfHosted
      ? 'self-hostable, not seated for this company'
      : (NOT_SELF_HOSTABLE_REASON[lane.id] || 'not offered');
    return { lane: lane.id, title: lane.title, where, covers: null, reason };
  });
  const leaves = rows.filter((row) => row.where.startsWith('cloud:'));
  return {
    rows,
    self_hosted: rows.filter((row) => row.where === 'self_hosted').map((row) => row.lane),
    // THE list of what still goes to a cloud provider about this company.
    cloud: leaves.map((row) => ({ lane: row.lane, provider: row.where.slice('cloud:'.length), reason: row.reason })),
    dark: rows.filter((row) => row.where === 'dark').map((row) => ({ lane: row.lane, reason: row.reason }))
  };
};

// One line for the banner: the lanes NOT seated, grouped by where they run.
export const lanePlanSummary = (plan) => {
  const group = new Map();
  for (const row of plan.rows) {
    if (row.where === 'self_hosted' || row.where === 'operator_only') continue;
    if (!group.has(row.where)) group.set(row.where, []);
    group.get(row.where).push(row.lane);
  }
  return [...group.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([where, ids]) => `${where === 'dark' ? 'DARK' : `stays on ${where.slice('cloud:'.length)}`}: ${ids.join(', ')}`)
    .join('; ');
};
