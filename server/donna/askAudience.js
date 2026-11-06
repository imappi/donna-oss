// Donna — ask audience law (migration 122; design-donna-universal-mentions §5).
//
// ONE question primitive, three audiences. This module is the pure shape law
// every writer validates against before a non-client ask can exist:
//   'client' — the owner; addressee is NULL (delivery resolves the client's
//              channel bindings, exactly as before 122);
//   'seat'   — a customer-side human principal (firm_member/firm_collaborator);
//   'agent'  — a hired bench occupant / the runtime operator (ai_occupant).
//
// The convergence law that rides the audience (reconcileConvergenceState.js,
// kept lock-step by test):
//   client ask open -> on_owner (reason open_owner_ask) — terminal 2;
//   seat ask open   -> on_owner (reason open_seat_ask)  — terminal 2, counted
//                      colleague_asks, NEVER in prompts_per_100;
//   agent ask open  -> hanging  (reason agent_ask_unanswered) — an ask on an
//                      agent is NEVER a resting state: Donna owes the answer.
//
// Pure leaf: no DB, no LLM, no imports.

export const ASK_AUDIENCES = Object.freeze(['client', 'seat', 'agent']);

export const SEAT_ADDRESSEE_PRINCIPAL_TYPES = Object.freeze(['firm_member', 'firm_collaborator']);
export const AGENT_ADDRESSEE_PRINCIPAL_TYPE = 'ai_occupant';

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

// The audience of a persisted ask row. Every row minted before migration 122
// carries no column value in old snapshots/payloads — absence IS 'client'.
export const askAudienceOf = (row = {}) => {
  const a = norm(row?.audience);
  return ASK_AUDIENCES.includes(a) ? a : 'client';
};

// Fail-closed normalization for WRITERS: absent -> 'client' (every existing
// caller keeps minting owner asks untouched); an unknown string -> null, the
// caller refuses. Never silently downgrade a colleague/agent ask to a client
// ask — that would put an internal question on the owner's channels.
export const normalizeAskAudience = (value) => {
  if (value == null || String(value).trim() === '') return 'client';
  const a = norm(value);
  return ASK_AUDIENCES.includes(a) ? a : null;
};

// The addressee shape law (mirrors the 122 CHECK, refused app-side first so
// the error is typed instead of a constraint violation).
export const validateAskAddressee = ({
  audience,
  addresseePrincipalType = null,
  addresseePrincipalId = null
} = {}) => {
  const a = normalizeAskAudience(audience);
  if (!a) return { ok: false, reason: 'unknown_audience' };
  const type = norm(addresseePrincipalType);
  const id = String(addresseePrincipalId ?? '').trim();
  if (a === 'client') {
    return (!type && !id)
      ? { ok: true, audience: a, addresseePrincipalType: null, addresseePrincipalId: null }
      : { ok: false, reason: 'client_ask_forbids_addressee' };
  }
  if (!type || !id) return { ok: false, reason: `${a}_ask_requires_addressee` };
  if (a === 'seat' && !SEAT_ADDRESSEE_PRINCIPAL_TYPES.includes(type)) {
    return { ok: false, reason: 'seat_addressee_principal_type_invalid' };
  }
  if (a === 'agent' && type !== AGENT_ADDRESSEE_PRINCIPAL_TYPE) {
    return { ok: false, reason: 'agent_addressee_principal_type_invalid' };
  }
  return { ok: true, audience: a, addresseePrincipalType: type, addresseePrincipalId: id };
};

// One pass over raw ask rows -> per-audience buckets. Tolerates raw DB rows
// or mapped payloads (both carry `audience` after 122; neither did before,
// which buckets 'client' — correct for every pre-122 row).
export const partitionAskRowsByAudience = (rows = []) => {
  const out = { client: [], seat: [], agent: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    out[askAudienceOf(row)].push(row);
  }
  return out;
};
