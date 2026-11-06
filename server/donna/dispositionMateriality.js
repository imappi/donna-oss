// F1 (2026-07 loop/recon review) — the deterministic Keep-layer immateriality
// ceiling for the DISPOSITION auto paths.
//
// The disposition producers (bankLineDispositionLlm.js, documentDispositionLlm.js)
// let ONE strong-model call settle a line/document via 'auto_explain' — but until
// this module, the only materiality gate on that terminalizing path was the
// model's OWN label ("materiality": "immaterial"). CLAUDE.md's Keep layer
// promises "materiality thresholds" as a deterministic invariant; this is it:
// above the ceiling, an auto_explain is downgraded to the chase lane REGARDLESS
// of the model's label. The model keeps its judgment below the ceiling; above
// it, the answer is an owner ask — never a silent settle (Kari, 2026-07-06:
// 500, matching Gate E's materiality ceiling).
//
// Deliberately NOT applied to the owner-reply leg: the ask WAS the material
// escalation and the owner's answer resolves it ("cash" settles a 5,000
// receipt when the owner says so). Only the UNPROMPTED sweep paths are bound.
//
// This is a Keep-layer guard, not intelligence-substitution: it does not
// re-judge the model below the ceiling, it refuses to let a mislabeled
// material item terminalize without the owner ever hearing about it.
//
// RT-11b (2026-09-02) — the ceiling FOLLOWS THE PACK, exactly like Gate E's
// (reconciliationLlmCore.getAutoMatchPolicy): every authored pack declares
// `reconciliation.disposition_ceiling` in its HOME currency (declared, never
// omitted — the validator requires it), the client's jurisdiction resolves it,
// and the DISPOSITION_MATERIALITY_CEILING env value is the ONLY override (a
// tuning/kill knob, env-legitimate per the config-plane rail). No jurisdiction
// / no pack / no env ⇒ NaN, the F1 UNSET marker: the comparator FAILS CLOSED on
// it (an amount can never be proved immaterial against a ceiling nobody
// declared), never ∞. The USD code default (500) and its approximate FX table
// left with this change: the number is the pack's, in the pack's currency,
// and the compare is the same currency-blind arithmetic Gate E applies to the
// bank line's own amount — the receipt names the ceiling's currency so a
// cross-currency compare is readable, not hidden behind a stale rate table.

// Imported as a module, not through the capability registry (the K1 rail's
// direct-import posture): packs.js is pack data, the reader is pure.
import { dispositionCeilingForJurisdiction } from './outbound/packs.js';

const envCeiling = () => {
  const raw = Number(process?.env?.DISPOSITION_MATERIALITY_CEILING);
  return Number.isFinite(raw) && raw > 0 ? raw : NaN;
};

// The receipt-grade resolution: { ceiling, source, currency }.
//   ceiling  — a positive number, or NaN (the unset marker).
//   source   — 'env' | 'pack:<id>' | 'unset' (WHY this number was the line).
//   currency — the pack's home currency when the pack supplied it, else null.
export const getDispositionMaterialityPolicy = ({ jurisdiction = null } = {}) => {
  const fromEnv = envCeiling();
  if (Number.isFinite(fromEnv)) return { ceiling: fromEnv, source: 'env', currency: null };
  const pack = dispositionCeilingForJurisdiction(jurisdiction);
  if (pack) return { ceiling: pack.ceiling, source: `pack:${pack.pack_id}`, currency: pack.currency };
  return { ceiling: NaN, source: 'unset', currency: null };
};

// The number-only reader the producers thread into their parsers.
export const getDispositionMaterialityCeiling = ({ jurisdiction = null } = {}) =>
  getDispositionMaterialityPolicy({ jurisdiction }).ceiling;

// True when `amount` deterministically exceeds the ceiling. Non-finite or
// missing AMOUNTS return false — the confidence floor / needs_human defaults
// already own the malformed-input lanes; this guard only ever FIRES on a real
// number it can compare (it must never invent a downgrade from a parse gap).
// The CEILING has two non-finite meanings, kept apart on purpose:
//   null — no ceiling was handed in: the guard is not armed (the parsers'
//          opt-out — the owner-reply leg, a unit test without a ceiling);
//   NaN  — the resolver's UNSET marker (no pack, no env): FAIL CLOSED. Any
//          real amount exceeds a ceiling nobody declared (F1: unset is never
//          ∞). Infinity is treated the same way — it is not a declared ceiling.
export const exceedsMaterialityCeiling = (amount, ceiling = getDispositionMaterialityCeiling()) => {
  // null / undefined / '' are MISSING, not zero (Number(null) is 0): the
  // guard must never fire on an amount that was not there.
  const n = amount == null || amount === '' ? NaN : Number(amount);
  if (!Number.isFinite(n)) return false;
  if (ceiling === null) return false;
  if (!Number.isFinite(ceiling)) return true;
  return n > ceiling;
};
