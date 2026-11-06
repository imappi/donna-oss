// FI-13 slice 13.0A-1 (part b) — the Oy capability surface (D-FI13-12).
//
// "`FINLAND_OY` is the kill switch; capabilities are per-lane flags + a visible
// contract." Two things this module is FOR:
//
//   1. The flag REGISTRY — one config-plane flag key per statutory lane (the
//      flags rail: one key per lane, born on the config plane, NOT a schema
//      array, NOT an env pair). Later lane slices (13.1–13.7) import their key
//      from here and gate their own behaviour on it; this is the single place the
//      key strings live.
//   2. The client-visible CONTRACT — a deterministic projection of "what is
//      actually enabled for THIS client", lane by lane, so "Oy enabled" NEVER
//      silently implies every lane is safe. A lane the master switch or the
//      lane flag has not turned on renders `not_enabled`, explicitly.
//
// `FINLAND_OY` is the MASTER kill switch (dark, envFallback () => false). It gates
// every lane: master off ⇒ every lane is `not_enabled` regardless of its own
// flag. A lane is live ONLY when the master AND its own lane flag both act.
//
// The per-lane POSTURE (what "enabled" MEANS for a lane — supported / pilot /
// review_required) is SERVICE-SCOPE POLICY, re-tuned only by a dated Kari call
// (same discipline as scopeDrift severities and the acceptance envelope). It is
// NOT the flag: the flag says whether the lane is turned on; the posture says how
// Donna behaves in that lane when it is. The example contract in D-FI13-12
// ("Monthly Oy bookkeeping: supported · 6B review pack: pilot · Direct 6B
// submission: not enabled · Dividend processing: accountant review required")
// pins these postures.
//
// Pure module: `buildFinlandOyContract` takes plain booleans (fully testable with
// no config), and `readFinlandOyCapabilities` reads the flags off an already-read
// config snapshot via clientFlagActs (no I/O of its own). The DB caller + route
// that render this to a client wire up with the onboarding surface (13.0A-2) —
// this ships the registry + the contract model, green-now, no fi-oy client yet.

import { clientFlagActs } from '../clientConfig.js';

// The master kill switch. Dark at birth (envFallback () => false); off ⇒ the
// whole Oy capability set is off. Refusing WRONG output is never behind this flag
// (that stays unconditional, D-FI13-2) — this gates only what Donna will DO for
// an Oy, never the entity-safety refusals.
export const FINLAND_OY_FLAG_KEY = 'FINLAND_OY';

// The closed set of lane display states, severity-agnostic (this is a capability
// contract, not an escalation verdict). `not_enabled` is the resting state until
// a flag turns a lane on.
export const OY_CAPABILITY_STATES = Object.freeze(['supported', 'pilot', 'review_required', 'not_enabled']);

// Bilingual labels for each display state.
export const OY_CAPABILITY_STATE_LABELS = Object.freeze({
  supported: { en: 'supported', fi: 'tuettu' },
  pilot: { en: 'pilot', fi: 'pilotti' },
  review_required: { en: 'review required', fi: 'tarkistus vaaditaan' },
  not_enabled: { en: 'not enabled', fi: 'ei käytössä' }
});

// The closed per-lane catalog. `flagKey` is the config-plane key a lane slice
// gates on; `posture` is how Donna behaves when the lane is live (policy). Extend
// only by PR on a dated call — a new lane is a new statutory surface.
export const FINLAND_OY_CAPABILITY_LANES = Object.freeze([
  {
    id: 'bookkeeping',
    flagKey: 'FINLAND_OY_BOOKKEEPING',
    posture: 'supported',
    label_en: 'Monthly Oy bookkeeping',
    label_fi: 'Osakeyhtiön kuukausikirjanpito'
  },
  {
    id: 'opening_balances',
    flagKey: 'FINLAND_OY_OPENING_BALANCES',
    posture: 'supported',
    label_en: 'Opening balances (avaava tase)',
    label_fi: 'Avaava tase'
  },
  {
    id: 'payroll_import',
    flagKey: 'FINLAND_OY_PAYROLL_IMPORT',
    // External payroll only, imported + reconciled; missing evidence blocks close
    // (D-FI13-16). Pilot-grade, not automated payroll.
    posture: 'pilot',
    label_en: 'Owner payroll import',
    label_fi: 'Omistajan palkka-aineiston tuonti'
  },
  {
    id: 'fs_draft',
    flagKey: 'FINLAND_OY_FS_DRAFT',
    posture: 'pilot',
    label_en: 'Financial statements draft (tilinpäätös)',
    label_fi: 'Tilinpäätösluonnos'
  },
  {
    id: 'fs_publication',
    flagKey: 'FINLAND_OY_FS_PUBLICATION',
    // PRH publication rides a human redaction gate (C4) — a human approves before
    // anything is published.
    posture: 'review_required',
    label_en: 'Financial statements publication (PRH)',
    label_fi: 'Tilinpäätöksen rekisteröinti (PRH)'
  },
  {
    id: 'tax_return_6b_pack',
    flagKey: 'FINLAND_OY_6B_PACK',
    // A review pack first — compiler ≠ transport (D-FI13-20). Human review, no
    // submission.
    posture: 'pilot',
    label_en: '6B review pack',
    label_fi: '6B-tarkistuspaketti'
  },
  {
    id: 'tax_return_6b_submission',
    flagKey: 'FINLAND_OY_6B_SUBMISSION',
    // Direct submission is gated behind the D5 checklist — a human/accountant
    // confirms before anything transmits.
    posture: 'review_required',
    label_en: 'Direct 6B submission',
    label_fi: '6B-ilmoituksen suora lähetys'
  },
  {
    id: 'dividend',
    flagKey: 'FINLAND_OY_DIVIDEND',
    // Detect-and-escalate in the pilot (D2 rec B): accountant-confirmed decision,
    // withholding and 7812 treatment before anything books — never automated.
    posture: 'review_required',
    label_en: 'Dividend processing',
    label_fi: 'Osingonjaon käsittely'
  },
  {
    id: 'shareholder_loan',
    flagKey: 'FINLAND_OY_SHAREHOLDER_LOAN',
    // Detect-and-escalate: osakaslaina carries a tax clock and dual-treatment
    // risk — surfaced for review, never silently booked.
    posture: 'review_required',
    label_en: 'Shareholder loan (osakaslaina)',
    label_fi: 'Osakaslaina'
  }
]);

// Every lane flag key, for the flags-rail sweep / a graduation audit.
export const FINLAND_OY_LANE_FLAG_KEYS = Object.freeze(FINLAND_OY_CAPABILITY_LANES.map((l) => l.flagKey));

const stateLabel = (state) => OY_CAPABILITY_STATE_LABELS[state] || OY_CAPABILITY_STATE_LABELS.not_enabled;

// buildFinlandOyContract({ masterActs, laneActs }) → the deterministic contract.
// `masterActs` is the FINLAND_OY master switch; `laneActs` is a map laneId→bool of
// each lane flag acting. A lane is LIVE only when the master AND its own flag act;
// otherwise it renders `not_enabled` (never a silent implied-on). Pure, never
// throws; a missing laneActs entry reads as off.
export const buildFinlandOyContract = ({ masterActs = false, laneActs = {} } = {}) => {
  const master = masterActs === true;
  const lanes = FINLAND_OY_CAPABILITY_LANES.map((lane) => {
    const laneOn = master && laneActs?.[lane.id] === true;
    const state = laneOn ? lane.posture : 'not_enabled';
    const label = stateLabel(state);
    return {
      id: lane.id,
      flag_key: lane.flagKey,
      label_en: lane.label_en,
      label_fi: lane.label_fi,
      enabled: laneOn,
      state,
      state_label_en: label.en,
      state_label_fi: label.fi
    };
  });

  return {
    master_enabled: master,
    // "Oy enabled" is the master switch; it never implies a lane is safe — read
    // each lane's own state. any_lane_enabled is a convenience for the FE header.
    any_lane_enabled: lanes.some((l) => l.enabled),
    lanes,
    provenance: {
      deterministic: true,
      policy: 'Oy capability contract (docs/design-donna-finland-fi13-osakeyhtio.md D-FI13-12); lane postures re-tuned only by a dated Kari call'
    }
  };
};

// readFinlandOyCapabilities({ snapshot, env }) → the contract for a client, read
// off an already-fetched config snapshot (readClientConfigSnapshot) via
// clientFlagActs. The flags rail's canonical reader — every flag here is dark
// (envFallback () => false), so with no DB stage rows the contract is
// all-`not_enabled`, byte-identical for every existing client. No I/O of its own;
// the DB caller passes the snapshot in.
export const readFinlandOyCapabilities = ({ snapshot = null, env = process.env } = {}) => {
  const masterActs = clientFlagActs({ flagKey: FINLAND_OY_FLAG_KEY, snapshot, envFallback: () => false, env });
  const laneActs = {};
  for (const lane of FINLAND_OY_CAPABILITY_LANES) {
    laneActs[lane.id] = clientFlagActs({ flagKey: lane.flagKey, snapshot, envFallback: () => false, env });
  }
  return buildFinlandOyContract({ masterActs, laneActs });
};

// laneById(id) / laneByFlagKey(key) — catalog lookups for a lane's own gate.
const LANES_BY_ID = new Map(FINLAND_OY_CAPABILITY_LANES.map((l) => [l.id, l]));
const LANES_BY_FLAG = new Map(FINLAND_OY_CAPABILITY_LANES.map((l) => [l.flagKey, l]));
export const oyLaneById = (id) => LANES_BY_ID.get(id) || null;
export const oyLaneByFlagKey = (key) => LANES_BY_FLAG.get(key) || null;
