// Donna — universal @mentions: the pure resolution core (build 2 slice 1,
// docs/design-donna-universal-mentions.md §3/D6).
//
// Laws this module carries:
//   - Mentions travel as STRUCTURED REFS minted by the composer typeahead,
//     never as server-parsed free text (D6). This module VALIDATES refs
//     against a per-artifact roster and REFUSES fail-closed; it never guesses
//     who "@david" is from a string.
//   - Eligibility is the artifact's client eligibility, decided by the WIRING
//     caller's queries (assertFirmAccess's predicate for humans;
//     listSpecialistAssignments for agents). This module receives only
//     already-eligible rows and never widens them — an actor absent from the
//     roster does not resolve, whatever the ref claims (entity isolation,
//     defense-in-depth layer 1 of 3).
//   - Agents resolve from the client's HIRED bench (active specialist_role
//     assignments), never a global list: an un-hired persona is as
//     unresolvable as an ineligible seat (D1). The one built-in exception is
//     the runtime operator itself ('donna'), always mentionable — Donna is
//     the runtime, not a hire.
//
// Pure leaf: imports only the pure role registry (persona display names) —
// no DB, no LLM, no config — so it loads in-sandbox under `node --test`,
// same discipline as operatorCapability.js / reconcileConvergenceState.js.

import { AI_PROFILES } from '../roles/roleRegistry.js';
import { normalizeUnicodeSearchKey } from '../../../src/lib/unicodeInputNormalization.js';

// The three flavors of the one grammar (design §1). The composer states the
// flavor explicitly; an unknown flavor is REFUSED, never downgraded — a
// silently-downgraded 'ask' would drop a blocker on the floor.
export const MENTION_FLAVORS = Object.freeze(['mention', 'assign', 'ask']);

export const MENTION_ACTOR_TYPES = Object.freeze(['seat', 'agent']);

// The always-present runtime operator ('@donna'). agent_id namespace note:
// operator id and AI_PROFILES ids share the agent_id field; 'donna' is
// reserved and never a bench profile id (pinned by test).
export const OPERATOR_AGENT_ID = 'donna';
export const OPERATOR_DISPLAY = 'Donna';

const norm = (v) => (v == null ? '' : String(v).trim());
const lower = (v) => norm(v).toLowerCase();

// Seat roster keys are (principal_type, principal_id) — the same identity
// assertFirmAccess resolves. Agent keys are (agent_id, role): migration 117
// pins one occupant per role per client, but one profile MAY occupy two
// roles, so role is part of the key and a role-less agent ref that matches
// two hires is refused as ambiguous rather than guessed.
const seatKey = (principalType, principalId) => `seat:${lower(principalType)}:${norm(principalId)}`;
const agentKey = (agentId, role) => `agent:${lower(agentId)}:${lower(role)}`;

const personaDisplayFor = (aiProfile) => AI_PROFILES[lower(aiProfile)]?.persona || norm(aiProfile);

// Assemble the per-artifact mentionable roster from pre-fetched, ALREADY
// ELIGIBLE rows. humanPrincipals: [{ principal_type, principal_id, display?,
// email? }] — unrestricted firm members plus collaborators whose active
// capability assignment covers the artifact's client (the caller runs that
// query). specialistAssignments: raw rows from listSpecialistAssignments
// (roles/roleRoster.js) — filtered HERE to live hires (status 'active',
// ai_occupant, inside the time window) so a caller passing the honest full
// bench read cannot accidentally make an ended hire mentionable.
export const buildMentionRoster = ({
  humanPrincipals = [],
  specialistAssignments = [],
  now = null
} = {}) => {
  const at = now instanceof Date ? now : new Date();
  const entries = [];
  const seen = new Set();

  for (const p of Array.isArray(humanPrincipals) ? humanPrincipals : []) {
    const principalType = lower(p?.principal_type ?? p?.principalType);
    const principalId = norm(p?.principal_id ?? p?.principalId);
    if (!principalType || !principalId) continue;
    const key = seatKey(principalType, principalId);
    if (seen.has(key)) continue;
    seen.add(key);
    const email = norm(p?.email);
    const display = norm(p?.display) || (email.includes('@') ? email.slice(0, email.indexOf('@')) : email) || principalId;
    // Seat vocabulary (build 1, seats spec §4.5): the ladder role labels the
    // row and the External badge is MANDATORY wherever an external seat
    // appears — both ride the roster entry so every consumer (typeahead,
    // chips, notification payloads) renders them from one source.
    const seatRole = lower(p?.seat_role ?? p?.seatRole) || null;
    const affiliation = lower(p?.affiliation) === 'external' ? 'external' : 'internal';
    entries.push({
      actor_type: 'seat',
      principal_type: principalType,
      principal_id: principalId,
      display,
      email: email || null,
      seat_role: seatRole,
      affiliation,
      key
    });
  }

  // The operator is first among agents so 'don…' typeahead offers Donna
  // before a similarly-named hire.
  const operatorKey = agentKey(OPERATOR_AGENT_ID, 'operator');
  entries.push({
    actor_type: 'agent',
    agent_id: OPERATOR_AGENT_ID,
    role: 'operator',
    display: OPERATOR_DISPLAY,
    key: operatorKey
  });
  seen.add(operatorKey);

  for (const a of Array.isArray(specialistAssignments) ? specialistAssignments : []) {
    if (lower(a?.principal_type) !== 'ai_occupant') continue;
    if (lower(a?.status) !== 'active') continue;
    const startsAt = a?.starts_at ? new Date(a.starts_at) : null;
    const endsAt = a?.ends_at ? new Date(a.ends_at) : null;
    if (startsAt && !(startsAt <= at)) continue;
    if (endsAt && !(endsAt > at)) continue;
    const agentId = lower(a?.ai_profile);
    const role = lower(a?.role);
    if (!agentId || !role) continue;
    const key = agentKey(agentId, role);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      actor_type: 'agent',
      agent_id: agentId,
      role,
      display: personaDisplayFor(agentId),
      key
    });
  }

  return entries;
};

// Typeahead: case-insensitive prefix match on display / persona / email
// local-part, prefix-first then substring, stable roster order within each
// band. Returning several rows for an ambiguous query is the CORRECT
// behavior — ambiguity is resolved by the human picking, never by the server
// guessing (D6).
export const filterMentionRoster = (roster = [], query = '') => {
  const q = normalizeUnicodeSearchKey(query);
  const rows = Array.isArray(roster) ? roster : [];
  if (q == null) return [];
  if (!q) return [...rows];
  const haystacks = (e) => [
    normalizeUnicodeSearchKey(e?.display),
    normalizeUnicodeSearchKey(e?.email),
    normalizeUnicodeSearchKey(e?.email)?.split('@')[0] || ''
  ].filter((value) => value != null);
  const prefix = rows.filter((e) => haystacks(e).some((h) => h && h.startsWith(q)));
  const rest = rows.filter((e) => !prefix.includes(e)
    && haystacks(e).some((h) => h && h.includes(q)));
  return [...prefix, ...rest];
};

export const normalizeMentionFlavor = (value) => {
  const f = lower(value) || 'mention';
  return MENTION_FLAVORS.includes(f) ? f : null;
};

// Validate the composer's structured refs against the artifact's roster.
// FAIL-CLOSED AS A WHOLE: one bad ref refuses the write (ok: false) — a
// message must never land with a half-resolved mention set, because the
// unresolved half could be the ask's addressee. Reasons are machine-readable
// for the API's 4xx body and the tests.
//   ref shapes: { actor_type:'seat', principal_type, principal_id }
//               { actor_type:'agent', agent_id, role? }
// Returns { ok, resolved: [rosterEntry…], refusals: [{ ref, reason }] } with
// resolved deduped in ref order.
export const validateMentionRefs = ({ refs = [], roster = [] } = {}) => {
  const rows = Array.isArray(roster) ? roster : [];
  const byKey = new Map(rows.map((e) => [e.key, e]));
  const agentsById = new Map();
  for (const e of rows) {
    if (e.actor_type !== 'agent') continue;
    if (!agentsById.has(e.agent_id)) agentsById.set(e.agent_id, []);
    agentsById.get(e.agent_id).push(e);
  }

  const resolved = [];
  const resolvedKeys = new Set();
  const refusals = [];

  for (const ref of Array.isArray(refs) ? refs : []) {
    const actorType = lower(ref?.actor_type);
    if (actorType === 'seat') {
      const key = seatKey(ref?.principal_type, ref?.principal_id);
      const entry = byKey.get(key);
      if (!entry) {
        refusals.push({ ref, reason: 'seat_not_eligible' });
        continue;
      }
      if (!resolvedKeys.has(key)) { resolvedKeys.add(key); resolved.push(entry); }
      continue;
    }
    if (actorType === 'agent') {
      const agentId = lower(ref?.agent_id);
      const role = lower(ref?.role);
      if (role) {
        const entry = byKey.get(agentKey(agentId, role));
        if (!entry) {
          refusals.push({ ref, reason: 'agent_not_hired' });
          continue;
        }
        if (!resolvedKeys.has(entry.key)) { resolvedKeys.add(entry.key); resolved.push(entry); }
        continue;
      }
      const candidates = agentsById.get(agentId) || [];
      if (candidates.length === 0) {
        refusals.push({ ref, reason: 'agent_not_hired' });
        continue;
      }
      if (candidates.length > 1) {
        refusals.push({ ref, reason: 'ambiguous_agent' });
        continue;
      }
      const entry = candidates[0];
      if (!resolvedKeys.has(entry.key)) { resolvedKeys.add(entry.key); resolved.push(entry); }
      continue;
    }
    refusals.push({ ref, reason: 'unknown_actor_type' });
  }

  return { ok: refusals.length === 0, resolved, refusals };
};

// Validate one composer submission: flavor + refs together. An 'assign' or
// 'ask' needs EXACTLY ONE addressee (ownership moves to one queue; a blocker
// waits on one named actor); a plain 'mention' takes any number ≥ 1.
export const validateMentionSubmission = ({ flavor, refs = [], roster = [] } = {}) => {
  const f = normalizeMentionFlavor(flavor);
  if (!f) {
    return { ok: false, flavor: null, resolved: [], refusals: [{ ref: null, reason: 'unknown_flavor' }] };
  }
  const { ok, resolved, refusals } = validateMentionRefs({ refs, roster });
  if (!ok) return { ok, flavor: f, resolved, refusals };
  if (resolved.length === 0) {
    return { ok: false, flavor: f, resolved, refusals: [{ ref: null, reason: 'no_addressee' }] };
  }
  if ((f === 'assign' || f === 'ask') && resolved.length !== 1) {
    return { ok: false, flavor: f, resolved, refusals: [{ ref: null, reason: `${f}_requires_single_addressee` }] };
  }
  // Agents have no notification inbox. An FYI mention to one would persist a
  // comment and then do literally nothing — the silent state this boundary is
  // meant to prevent. Agents are actionable only as a single ASK; @Donna's
  // immediate artifact-chat turn uses validateDirectAgentChatRef below.
  if (f !== 'ask' && resolved.some((entry) => entry.actor_type === 'agent')) {
    return { ok: false, flavor: f, resolved, refusals: [{ ref: null, reason: 'agent_requires_ask' }] };
  }
  return { ok: true, flavor: f, resolved, refusals: [] };
};

// Structured addressing for the existing synchronous artifact-chat path.
// This is intentionally Donna-only: hired specialists execute through the
// bounded agent-ASK runtime, while @Donna is the runtime operator already
// backing the ordinary artifact chat. Raw text is never parsed for identity.
export const validateDirectAgentChatRef = ({ ref, roster = [] } = {}) => {
  const submission = validateMentionSubmission({ flavor: 'ask', refs: ref ? [ref] : [], roster });
  if (!submission.ok) return submission;
  const [resolved] = submission.resolved;
  if (resolved?.actor_type !== 'agent' || resolved?.agent_id !== OPERATOR_AGENT_ID) {
    return {
      ok: false,
      flavor: 'ask',
      resolved: submission.resolved,
      refusals: [{ ref, reason: 'direct_chat_requires_donna' }]
    };
  }
  return submission;
};
