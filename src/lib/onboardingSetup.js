// The portal's "finish setting up" sequence — pure derivation only.
//
// The onboarding cards (entity-type capture, fiscal-period, GB filing details,
// channel connect) each gate themselves on PERSISTED state (row-17: the show
// conditions live with the cards and are pinned at the lib/route level). This
// module adds no new gating — it only composes the cards that are ALREADY due
// into a sequenced wizard: one step at a time, in dependency order (the legal
// form decides whether a fiscal year is even asked), with a visible
// step-x-of-n and a per-step "Later".
//
// Skips are deliberately session-local and unpersisted: a skipped step is not
// a decision, so nothing is written anywhere — the steps simply return on the
// next visit. With zero or one step due there is nothing to sequence and the
// portal renders the plain card (mode 'stack').

// A channel is a SETUP step only while it acts and no chat is bound yet. A
// bound channel is a settings surface (disconnect lives on its own card), and
// a non-acting channel has nothing for the owner to do.
export const channelConnectPending = (state) => Boolean(state?.channel_acts) && !state?.binding;

export const SETUP_STEP_TITLES = {
  jurisdiction: 'Where your business is registered',
  entity_type: 'About your business',
  fiscal_period: 'Your financial year',
  gb_filing: 'UK filing details',
  channel_connect: 'Chat with Donna'
};

// due: which cards' own show conditions are true right now (booleans, computed
// by the caller from persisted state). skipped: ids the owner set aside this
// session. Returns { steps, active, activeIndex, mode, parked }.
export const deriveSetupWizard = ({ due = {}, skipped } = {}) => {
  const skippedIds = skipped instanceof Set ? skipped : new Set(skipped || []);
  const steps = ['jurisdiction', 'entity_type', 'fiscal_period', 'gb_filing', 'channel_connect']
    .filter((id) => Boolean(due[id]))
    .map((id) => ({ id, title: SETUP_STEP_TITLES[id] }));
  const active = steps.find((step) => !skippedIds.has(step.id)) || null;
  return {
    steps,
    active,
    activeIndex: active ? steps.indexOf(active) : -1,
    mode: steps.length >= 2 ? 'wizard' : 'stack',
    // parked: every due step was set aside — the wizard collapses to a single
    // resume row instead of vanishing (skipping must never make work
    // unreachable).
    parked: steps.length > 0 && !active
  };
};

// Snapshot display fields retain their historical precedence. Setup uses the
// explicit persisted identity so conflicting column/profile homes stay visible.
export const persistedClientIdentity = (client = {}) => {
  const identity = client.persisted_identity;
  if (!identity) return client;
  return {
    ...client,
    jurisdiction: identity.jurisdiction,
    entity_type: identity.entity_type,
    profile: {
      ...(client.profile || {}),
      jurisdiction: identity.profile_jurisdiction,
      entity_type: identity.profile_entity_type,
      entityType: identity.profile_entityType
    }
  };
};

export const entityTypeIdentityConflict = (client = {}) => {
  const identity = persistedClientIdentity(client);
  const normalized = (value) => typeof value === 'string' ? value.trim().toLowerCase() : null;
  const column = normalized(identity.entity_type);
  const profile = normalized(identity.profile?.entityType || identity.profile?.entity_type);
  return Boolean(column && profile && column !== profile);
};

// Confirm missing or contradictory persisted facts; a detector hint is not consent.
// A supported-looking country must never be substituted for an unsupported one.
export const jurisdictionCaptureState = (client = {}) => {
  client = persistedClientIdentity(client);
  const canonical = (value) => {
    const key = String(value || '').trim().toLowerCase();
    return key === 'uk' ? 'gb' : /^[a-z]{2}$/.test(key) ? key : null;
  };
  const column = canonical(client.jurisdiction);
  const profileRaw = client.profile?.jurisdiction;
  const profile = canonical(profileRaw);
  const entityCountries = [client.entity_type, client.profile?.entityType, client.profile?.entity_type]
    .filter((value) => typeof value === 'string' && /^[a-z]{2}-/i.test(value.trim()))
    .map((value) => canonical(value.trim().slice(0, 2)));
  const conflict = Boolean(column && ((profileRaw != null && profileRaw !== '' && column !== profile)
    || entityCountries.some((country) => country !== column)));
  return { show: conflict || !column, conflict };
};
