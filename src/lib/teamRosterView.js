// Team roster view-model (S3, specialist-roles doc §5) — pure shaping of the
// server's roster read for TeamPanel. Laws carried here, pinned by tests:
//
//   - INV-S9: a role card never claims past its certification. The claim is
//     the server's S6 ladder (certification_claim: 'preview' | 'autonomous',
//     fail-closed server-side): only exactly 'autonomous' — a signed green
//     RoleCertification manifest — flips the chip; everything else renders
//     the 'Supervised' ceiling. No role holds a signed record today.
//   - INV-S8: the status line has exactly two shapes, rendered from the
//     persisted projection: 'All handled' / 'N waiting on you'. No projection,
//     no line — never freeform.
//   - Hireable law: a role is hireable only when its action_set is non-empty
//     (an empty leash has no autonomous surface to hire) and it is not parked.
//     Inventory & Purchasing stays PARKED until Kari's dated scope-reversal
//     call opens the I-lane; unparking it is a deliberate edit here.
//   - Honest controls: the hire CTA renders only when the bench flag ACTS for
//     the venture. Anything less renders a label, never a dead button.
//   - Team-screen recede (Kari, 2026-08-14): the Team screen is the org chart
//     and hiring only. Grant delegation moved into chat (approve_role_grant /
//     revoke_role_grant; the shape→action map now lives server-side in
//     roleEmployment.GRANT_SHAPE_ACTION_FAMILIES); this module keeps only the
//     read-only renderings (grantSummary, narration, chips, status lines).

export const PARKED_ROLE_IDS = Object.freeze(['inventory_purchasing']);

// Persona names by role id — the FE mirror of the server registry's
// AI_PROFILES (persona lives on the AI occupant, never the role). One home on
// this side: TeamPanel's cards and the feed chat's teammate chips both read
// it, so a rename stays a one-line change here plus one in the registry.
export const ROLE_PERSONA_LABELS = Object.freeze({
  invoicing_collections: 'Clara',
  tax: 'Vera',
  inventory_purchasing: 'Milo'
});

export const rolePersonaLabel = (roleId) => ROLE_PERSONA_LABELS[roleId] || null;

export const isRoleHired = (role) => role?.assignment?.status === 'active';

export const isRoleHireable = (role) =>
  Array.isArray(role?.action_set)
  && role.action_set.length > 0
  && !PARKED_ROLE_IDS.includes(role?.id);

// The card's one status chip. Hired = Supervised — the INV-S9 ceiling —
// unless the server's S6 claim ladder says exactly 'autonomous' (a signed
// green RoleCertification manifest; fail-closed to 'preview' on anything
// less). The chip renders the persisted claim, it never derives one.
export const roleChip = (role) => {
  if (!isRoleHired(role)) return null;
  if (role?.certification_claim === 'autonomous') return { label: 'Autonomous', tone: 'ok' };
  return { label: 'Supervised', tone: 'ok' };
};

export const roleChipMessage = (role) => {
  const chip = roleChip(role);
  if (!chip) return null;
  return {
    ...chip,
    labelId: chip.label === 'Autonomous' ? 'mounted.team.autonomous' : 'mounted.team.supervised'
  };
};

// The card's CTA slot when the role is not hired.
//   act mode + hireable  -> a live Hire control
//   parked               -> the Parked label
//   everything else      -> the Coming soon label
export const roleCta = (role, benchMode) => {
  if (isRoleHired(role)) return null;
  if (PARKED_ROLE_IDS.includes(role?.id)) return { kind: 'label', label: 'Parked' };
  if (benchMode === 'act' && isRoleHireable(role)) return { kind: 'hire', label: 'Hire' };
  return { kind: 'label', label: 'Coming soon' };
};

export const roleCtaMessage = (role, benchMode) => {
  const cta = roleCta(role, benchMode);
  if (!cta) return null;
  const labelId = cta.label === 'Hire'
    ? 'mounted.team.hire'
    : cta.label === 'Parked'
      ? 'mounted.team.parked'
      : 'mounted.team.comingSoon';
  return { ...cta, labelId };
};

// INV-S8: two shapes only, from the persisted projection.
export const roleStatusLine = (role) => {
  if (!isRoleHired(role) || !role?.projection) return null;
  const waiting = Number(role.projection.waiting_on_owner) || 0;
  return waiting === 0 ? 'All handled' : `${waiting} waiting on you`;
};

export const roleStatusMessage = (role) => {
  if (!isRoleHired(role) || !role?.projection) return null;
  const count = Number(role.projection.waiting_on_owner) || 0;
  return count === 0
    ? { id: 'mounted.team.allHandled', values: {} }
    : { id: 'mounted.team.waiting.count', values: { count } };
};

// The hire confirm copy: the envelope plan, stated before the act. Lists only
// the lanes a hire would actually stage (action 'stage'), and states INV-S10
// so the owner knows what a hire does NOT do.
export const hireConfirmCopy = ({ role }) => {
  const persona = role?.profile?.persona || role?.title || 'this role';
  const staged = (role?.envelope?.flags || []).filter((flag) => flag.action === 'stage');
  const lines = staged.length
    ? staged.map((flag) => `${flag.flag_key}: ${flag.from ?? 'off'} to ${flag.to}`)
    : ['No lane changes: every lane is already at its hire posture.'];
  return [
    `Hire ${persona} into ${role?.title}?`,
    '',
    ...lines,
    '',
    'Nothing sends or posts without your approval. You approve any standing authority separately.'
  ].join('\n');
};

export const hireConfirmMessage = ({ role }) => {
  const persona = role?.profile?.persona || role?.title || 'this role';
  const staged = (role?.envelope?.flags || []).filter((flag) => flag.action === 'stage');
  return { persona, role: role?.title || persona, staged };
};

// ── S5 teamwork narration (INV-S5: narration renders events, never a
// mechanism). Input rows are the persisted role-event receipts off the roster
// read (roleEvents readRoleTeamwork). Deterministic templates keyed on the
// closed event vocabulary — an unknown shape renders NOTHING (null), never a
// freeform line. No model call exists anywhere near this path.

const HANDOFF_THING_LABELS = Object.freeze({
  issue_invoice: 'an invoice',
  send_quote: 'a quote',
  send_receivable_reminder: 'a payment reminder'
});

export const narrateTeamworkEvent = (event) => {
  const persona = ROLE_PERSONA_LABELS[event?.responsible_role];
  if (!persona) return null;
  const thing = HANDOFF_THING_LABELS[event?.action_type] || 'a task';
  let line = null;
  if (event?.type === 'role.handed_to_owner') {
    line = event?.next_commitment === 'decide_collection_next_step'
      ? `${persona} finished the reminder cadence and needs your call.`
      : `${persona} prepared ${thing} and is waiting on your approval.`;
  } else if (event?.type === 'role.resumed_from_owner') {
    if (event?.outcome === 'approved') line = `You approved. ${persona} sends it from here.`;
    else if (event?.outcome === 'declined') line = `You declined. ${persona} closed it out.`;
    else if (event?.outcome === 'withdrawn') line = `${persona} withdrew it. Nothing for you to do.`;
  }
  if (!line) return null;
  return { id: event.id, who: persona, line, at: event.at || null };
};

export const narrateTeamworkEventMessage = (event) => {
  const persona = ROLE_PERSONA_LABELS[event?.responsible_role];
  if (!persona) return null;
  if (event?.type === 'role.handed_to_owner') {
    if (event?.next_commitment === 'decide_collection_next_step') {
      return { id: event.id, who: persona, messageId: 'mounted.team.event.collection', values: { persona }, at: event.at || null };
    }
    const thingId = HANDOFF_THING_LABELS[event?.action_type]
      ? `mounted.team.thing.${event.action_type === 'issue_invoice' ? 'invoice' : event.action_type === 'send_quote' ? 'quote' : 'reminder'}`
      : 'mounted.team.thing.task';
    return { id: event.id, who: persona, messageId: 'mounted.team.event.prepared', values: { persona, thingId }, at: event.at || null };
  }
  if (event?.type === 'role.resumed_from_owner' && ['approved', 'declined', 'withdrawn'].includes(event?.outcome)) {
    return { id: event.id, who: persona, messageId: `mounted.team.event.${event.outcome}`, values: { persona }, at: event.at || null };
  }
  return null;
};

// One line per standing grant for the authority list.
export const grantSummary = (grant) => {
  const action = String(grant?.action_type || '').replace(/_/g, ' ');
  const scope = grant?.scope_key ? ` for ${grant.scope_key}` : '';
  const ceiling = grant?.amount_ceiling != null && grant?.currency
    ? ` up to ${grant.amount_ceiling} ${grant.currency}`
    : '';
  const bound = grant?.expires_at
    ? ` until ${String(grant.expires_at).slice(0, 10)}`
    : grant?.review_after
      ? ` review ${String(grant.review_after).slice(0, 10)}`
      : '';
  return `${action}${scope}${ceiling}${bound}`.trim();
};

export const grantSummaryParts = (grant) => ({
  action: String(grant?.action_type || '').replace(/_/g, ' '),
  scopeKey: grant?.scope_key || null,
  amount: grant?.amount_ceiling ?? null,
  currency: grant?.currency || null,
  expiresAt: grant?.expires_at ? String(grant.expires_at).slice(0, 10) : null,
  reviewAfter: grant?.review_after ? String(grant.review_after).slice(0, 10) : null
});
