// Canonical-role proposer — the strong-model half of chart role resolution.
//
// This module gives one model call the WHOLE chart, jurisdiction and pack. Rows
// with a settled role remain in that call as context, but are not targets. It
// deliberately does not decide whether a proposal is safe: role vocabulary,
// account-class and normal-balance checks, confidence floors and singleton
// contention all belong to `canonicalRoleResolution.js`'s deterministic Keep
// layer. It also does not persist roles or mint owner asks.
//
// The injected-model seam follows the K1-5 compose pattern, while the strong
// default, resolved model receipt and structured JSON boundary follow
// `unifiedExtractor.js`. With no injected model the honest dark result is no
// proposals, not a name-matching fallback.

import { ACCOUNT_ROLES } from './accountRoles.js';
import { POSTING_SINGLETON_ROLES } from './canonicalRoleResolution.js';
import { extractJson } from './extractJson.js';

const DEFAULT_MODEL = 'claude-opus-4-8';

const resolvedModel = ({ model, env }) => {
  const override = String(env?.CANONICAL_ROLE_PROPOSER_MODEL || '').trim();
  return String(model || override || DEFAULT_MODEL).trim();
};

const promptAccount = (account, settled) => ({
  account_id: String(account?.id ?? ''),
  code: account?.code ?? null,
  name: account?.name ?? null,
  account_type: account?.account_type ?? null,
  normal_balance: account?.normal_balance ?? null,
  status: settled ? 'settled_context' : 'target',
  canonical_role: settled ? String(account.canonical_role).trim() : null
});

const roleVocabulary = () => Object.entries(ACCOUNT_ROLES).map(([role, meta]) => ({
  role,
  label: meta.label
}));

export const buildCanonicalRoleProposerPrompt = ({
  accounts = [],
  jurisdiction = null,
  pack = null,
  clientIdentity = null
} = {}) => {
  const chart = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  const rows = chart.map((account) => promptAccount(
    account,
    Boolean(String(account?.canonical_role || '').trim())
  ));

  return `You are assigning canonical accounting roles across one client's complete chart of accounts.

Read the chart as a whole. Account numbers, neighbouring accounts, language and settled roles are evidence about this specific book. Rows marked settled_context are an immutable key: use them as context, but NEVER return a proposal for them. Return proposals only for rows marked target.

Jurisdiction: ${String(jurisdiction || 'unknown')}
Jurisdiction pack and accounting context:
${JSON.stringify(pack ?? null, null, 2)}
Client identity context:
${JSON.stringify(clientIdentity ?? null, null, 2)}

ROLE VOCABULARY (the role key and its human label):
${JSON.stringify(roleVocabulary(), null, 2)}

SINGLETON ROLES:
${JSON.stringify(POSTING_SINGLETON_ROLES, null, 2)}
At most one target account may be proposed for each singleton role. Posting and reconciliation paths require one unambiguous account for these roles, so proposing two creates an owner interruption.

CONFIDENCE CONTRACT:
- confidence is an honest number from 0 to 1.
- Prefer low confidence to a confident guess. A low-confidence result is safely sent to the owner; a confident wrong control-account role can corrupt a tax return.
- Omit an account you cannot place. Do not force it onto the nearest role.
- rationale is one short human-readable clause, or null.

Return ONLY valid JSON with this exact envelope:
{
  "proposals": [
    {
      "account_id": "an id copied exactly from a target row",
      "role": "one role key from the vocabulary",
      "confidence": 0.0,
      "rationale": "one short clause or null"
    }
  ]
}

CHART:
${JSON.stringify(rows, null, 2)}`;
};

const parseModelOutput = (result) => {
  const payload = result?.output ?? result?.content ?? result;
  if (typeof payload === 'string') return extractJson(payload);
  return payload;
};

// A per-entry drop is counted, never silent: the receipt's `proposals_dropped`
// is how a caller can tell "the model proposed nothing for these accounts" from
// "the model proposed something this boundary refused to parse".
const schemaProposals = (value, settledIds) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.proposals)) return null;
  const proposals = [];
  let dropped = 0;
  const drop = () => { dropped += 1; };
  for (const proposal of value.proposals) {
    if (!proposal || typeof proposal !== 'object') { drop(); continue; }
    if (typeof proposal.account_id !== 'string' || !proposal.account_id) { drop(); continue; }
    if (settledIds.has(proposal.account_id)) { drop(); continue; }
    if (typeof proposal.role !== 'string' || !proposal.role.trim()) { drop(); continue; }
    if (typeof proposal.confidence !== 'number') { drop(); continue; }
    if (!Number.isFinite(proposal.confidence)) { drop(); continue; }
    if (proposal.confidence < 0 || proposal.confidence > 1) { drop(); continue; }
    if (proposal.rationale != null && typeof proposal.rationale !== 'string') { drop(); continue; }
    proposals.push({
      account_id: proposal.account_id,
      role: proposal.role.trim(),
      confidence: proposal.confidence,
      rationale: proposal.rationale == null ? null : proposal.rationale.trim().slice(0, 240)
    });
  }
  return { proposals, dropped };
};

export const proposeCanonicalRoles = async ({
  accounts = [],
  jurisdiction = null,
  pack = null,
  clientIdentity = null,
  model = null,
  env = process.env,
  compose = null
} = {}) => {
  const chart = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  const modelRequested = resolvedModel({ model, env });
  const baseReceipt = {
    status: 'not_called',
    reason: 'model_not_injected',
    model_requested: modelRequested,
    model_used: null,
    accounts_considered: chart.length,
    proposals_returned: 0,
    proposals_dropped: 0
  };

  if (typeof compose !== 'function') {
    return { proposals: [], receipt: baseReceipt };
  }

  const prompt = buildCanonicalRoleProposerPrompt({
    accounts: chart,
    jurisdiction,
    pack,
    clientIdentity
  });
  const result = await compose({ model: modelRequested, prompt });
  const modelUsed = String(result?.model || result?.model_id || modelRequested).trim();
  let parsed;
  try {
    parsed = parseModelOutput(result);
  } catch {
    return {
      proposals: [],
      receipt: {
        ...baseReceipt,
        status: 'refused',
        reason: 'invalid_json',
        model_used: modelUsed
      }
    };
  }

  const settledIds = new Set(
    chart
      .filter((account) => String(account?.canonical_role || '').trim())
      .map((account) => String(account.id))
  );
  const validated = schemaProposals(parsed, settledIds);
  if (validated == null) {
    return {
      proposals: [],
      receipt: {
        ...baseReceipt,
        status: 'refused',
        reason: 'invalid_schema',
        model_used: modelUsed
      }
    };
  }

  return {
    proposals: validated.proposals,
    receipt: {
      ...baseReceipt,
      status: 'completed',
      reason: null,
      model_used: modelUsed,
      proposals_returned: validated.proposals.length,
      proposals_dropped: validated.dropped
    }
  };
};

export const __DEFAULT_MODEL = DEFAULT_MODEL;
