// Statutory-obligation BINDING registry + the jurisdiction-neutral sweep
// (country-pack contract gap 3; kernel-audit G12's core).
//
// THE PROBLEM THIS CLOSES. A pack could express data and adapters but not a
// statutory duty that generates work on its own clock. So Finland's duties
// became hardcoded modules plus a country-named cron — `vercel.json` literally
// scheduled `?task=finland_watches`. With Finland and the UK committed as
// parallel first-class markets (Kari, 2026-07-27), the convenient next move
// was a `uk_watches` sibling: a second fork of the same motion, which is the
// country corner this parallel build exists to prevent. So the leg lands
// first, and the cron becomes `statutory_watches` — no country in its name.
//
// THE SHAPE is the referenceSchemes.js template, applied one level up from a
// leaf: the engine is BINDING-keyed, WHICH obligations apply is pack data
// (packs/<cc> obligations.items[]), and a new market's duty is pack data plus
// one binding here — never an engine edit. The names live in packs.js
// (KNOWN_OBLIGATION_BINDINGS) so the manifest can refuse an unknown one at
// LOAD; the implementations live here; a test pins the two lists equal in both
// directions.
//
// WHAT THIS IS NOT: a generic due-scan (an explicit anti-goal). Core never
// computes whether an obligation is due, never reads domain state, and owns no
// schedule of its own. Each bound implementation keeps its own due-ness, its
// own thresholds, its own asks and its own idempotency — byte-identically to
// what the FI cron ran before this module existed. Core owns exactly three
// things: enumeration, provenance, and dispatch.
//
// Keep-layer posture: deterministic enumeration + dispatch + receipts. No LLM.

import { loadOutboundPack, discoverOutboundPacks, statutoryObligationsForPack, obligationSurveyForPack } from './packs.js';

// Country binding composition is explicit; the sweep owns enumeration, dispatch
// and receipts only. It never selects handlers by a country-name branch.
import { STATUTORY_OBLIGATION_BINDINGS } from '../statutoryObligationRegistry.js';
export { STATUTORY_OBLIGATION_BINDINGS };

// ── Cadences ────────────────────────────────────────────────────────────────
//
// The sweep has two ticks: 'daily' (04:15 — every runnable duty) and 'hourly'
// (only the bindings that declared `hourly: true`). A cadence is dispatch
// metadata on the BINDING, not on the pack: which duties exist stays pack
// data; how often core re-checks an already-bound duty is core's own clock.
// Anything else is refused so a typo cannot silently run nothing.
export const STATUTORY_SWEEP_CADENCES = Object.freeze(['daily', 'hourly']);

const assertCadence = (cadence) => {
  if (!STATUTORY_SWEEP_CADENCES.includes(cadence)) {
    throw new Error(`Unknown statutory sweep cadence '${cadence}' (expected ${STATUTORY_SWEEP_CADENCES.join(' | ')}).`);
  }
  return cadence;
};

// ── The plan (pure; no I/O, no DB, no clock) ────────────────────────────────
//
// Enumerate every pack's obligations and sort them into three buckets that are
// each visible in the sweep summary:
//
//   runnable  — status 'bound' with a resolvable binding; core dispatches it.
//   unbuilt   — status 'declared_unbuilt'; the market REQUIRES it and core
//               cannot serve it yet. Reported on EVERY run, never silently
//               skipped: an undischarged statutory duty that nobody can see is
//               exactly the failure the honest declaration exists to prevent.
//   unsurveyed— pack-level; nobody has enumerated this market's duties at all.
//               Distinct from "surveyed, and there are none".
//
// A 'bound' obligation whose binding is missing from the registry cannot reach
// here — packs.js refuses it at load — but the planner still refuses it rather
// than trusting that, because a caller may hand in a manifest object directly.
export const planStatutoryObligationSweep = ({
  packIds = null,
  packsRoot = undefined,
  bindings = STATUTORY_OBLIGATION_BINDINGS,
  loadPack = null,
  cadence = 'daily'
} = {}) => {
  assertCadence(cadence);
  const loadOpts = packsRoot === undefined ? {} : { packsRoot };
  const load = loadPack || ((id) => loadOutboundPack(id, loadOpts));
  const discovery = packIds ? { packIds, unloadable: [] } : discoverOutboundPacks(loadOpts);
  const ids = discovery.packIds;

  const runnable = [];
  const unbuilt = [];
  const unsurveyed = [];
  const unloadable = [...discovery.unloadable];

  for (const packId of [...ids].sort()) {
    let pack;
    try {
      pack = load(packId);
    } catch (error) {
      // One malformed pack must not silence every other market's duties.
      unloadable.push({ packId, error: error?.message || String(error) });
      continue;
    }
    const survey = obligationSurveyForPack(pack);
    if (survey.survey !== 'surveyed') {
      unsurveyed.push({ packId, survey: survey.survey });
    }
    for (const obligation of statutoryObligationsForPack(pack)) {
      const entry = {
        packId,
        obligationId: obligation.id,
        name: obligation.name,
        authority: obligation.authority,
        source: obligation.source,
        asOf: obligation.asOf,
        binding: obligation.binding
      };
      if (obligation.status !== 'bound') { unbuilt.push(entry); continue; }
      if (!bindings[obligation.binding]) {
        unbuilt.push({ ...entry, unresolvedBinding: true });
        continue;
      }
      // On the hourly tick a daily-only binding is neither runnable nor
      // unbuilt — it is simply not this tick's work; the daily tick still
      // reports it. Only the daily plan is the honest full inventory.
      if (cadence === 'hourly' && bindings[obligation.binding].hourly !== true) continue;
      runnable.push(entry);
    }
  }

  return { cadence, runnable, unbuilt, unsurveyed, unloadable };
};

// ── The sweep (the cron's whole body) ───────────────────────────────────────
//
// Dispatch every runnable obligation, one receipt each. A throwing
// implementation is recorded and the sweep continues — one market's failing
// duty must not stop another market's. Every plan bucket rides out in the
// summary, so an unbuilt duty and an unsurveyed market are as visible in the
// cron's output as a duty that ran.
export const runStatutoryObligationSweep = async ({
  packIds = null,
  packsRoot = undefined,
  bindings = STATUTORY_OBLIGATION_BINDINGS,
  loadPack = null,
  cadence = 'daily'
} = {}) => {
  const plan = planStatutoryObligationSweep({ packIds, packsRoot, bindings, loadPack, cadence });
  const receipts = [];
  let ran = 0;
  let errors = 0;

  for (const entry of plan.runnable) {
    try {
      const summary = await bindings[entry.binding].run();
      ran += 1;
      receipts.push({ ...entry, outcome: 'ran', summary });
    } catch (error) {
      errors += 1;
      receipts.push({ ...entry, outcome: 'error', error: error?.message || String(error) });
    }
  }

  return {
    cadence: plan.cadence,
    dispatched: plan.runnable.length,
    ran,
    errors,
    obligations: receipts,
    unbuilt: plan.unbuilt,
    unsurveyed: plan.unsurveyed,
    unloadable: plan.unloadable
  };
};
