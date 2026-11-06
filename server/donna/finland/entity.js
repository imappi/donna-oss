// FI-13 — Finnish legal-form (entity type) resolver + KEEP-layer refusal guards.
// Pure DATA + pure compute. This module is the CANONICAL bridge from the
// persisted `profile.entity_type` (the free-form, FE-wired, jurisdiction-
// prefixed vocabulary in src/lib/clientAxes.js) to the internal
// toiminimi/oy axis the Finland statutory modules branch on. Design:
// docs/design-donna-finland-fi13-osakeyhtio.md (D-FI13-1).
//
// WHY a server-side resolver separate from src/lib/clientAxes.js: the Finland
// statutory writers read `clients.profile` directly and must NOT depend on a
// front-end module. This is a self-contained reader over the same stored form.
//
// STAGING NOTE (slice 13.0a): the resolver is written for the full three-way
// (oy / toiminimi / unknown), but the guard exported here refuses ONLY an
// EXPLICIT `fi-oy` — a missing/unknown legal form still resolves to toiminimi
// at the call sites, so this slice is byte-identical for every existing client
// (no `fi-oy` row exists yet). The fail-CLOSED-on-unknown posture (D-FI13-1
// point 3) lands WITH the backfill migration + StatutoryBlocker store in the
// next slice, once existing Finnish clients carry an explicit `fi-toiminimi`;
// turning it on before the backfill would break every live toiminimi book.

// The supported Finnish legal-form vocabulary. `fi-oy` is the private limited
// company (yksityinen osakeyhtiö); `fi-toiminimi` the sole trader
// (elinkeinonharjoittaja / yksityinen elinkeinonharjoittaja). Mirrors
// ENTITY_TYPES_BY_JURISDICTION.fi in src/lib/clientAxes.js — keep the two in
// sync. Julkinen Oy / osuuskunta / ky / ay are deliberately absent (they
// refuse via the same D-FI13-2 pattern until designed).
export const FI_ENTITY_TYPES = Object.freeze(['fi-toiminimi', 'fi-oy']);

// The config-plane rollout gate for the fail-closed-on-unknown posture (born on
// the config plane per the flags rail — NOT an env pair). OFF by default
// (envFallback () => false), so the flip ships DARK: byte-identical to today's
// permissive "unknown → toiminimi" behaviour until a client_capability_config
// row turns it on. This is the gate that decouples "flip merged" from "flip
// live", so the code can land before the backfill (migration 077) is confirmed
// applied in prod without risking a live toiminimi book — enable it only AFTER
// 077's receipt is confirmed. NOTE: this gates the UNKNOWN-form posture only; the
// fi-oy refusal below is unconditional and never flag-off-able (D-FI13-2).
export const FINLAND_ENTITY_FAIL_CLOSED_FLAG_KEY = 'FINLAND_ENTITY_FAIL_CLOSED';

// The internal axis the statutory modules speak. `openingBalanceIntake.js` and
// `tilikausi.js` already branch on 'toiminimi' vs 'oy'/'general'; this is the
// single place that decides it from the persisted legal form.
const FI_ENTITY_TO_AXIS = Object.freeze({
  'fi-toiminimi': 'toiminimi',
  'fi-oy': 'oy'
});

// Read the raw stored legal form off a client row/shape. Accepts either the
// top-level `entity_type` column or `profile.entity_type` (the validated
// profile key), lowercased/trimmed — the same read shape as
// clientAxes.readEntityType, kept independent so the server has no FE import.
const readRawEntityType = (client = {}) => {
  const fromTop = client?.entity_type;
  const fromNested = client?.profile?.entity_type;
  const value = typeof fromTop === 'string'
    ? fromTop
    : typeof fromNested === 'string' ? fromNested : null;
  if (!value) return null;
  return value.trim().toLowerCase() || null;
};

// finlandEntityType(client) → 'toiminimi' | 'oy' | null.
// Returns null for anything that is NOT a recognised Finnish legal form —
// including a missing value, or a non-Finnish form like 'gb-ltd'. A null
// result means "this is not a Finnish statutory entity we recognise"; the
// CALLER decides what to do with that (a Finland-only surface treats it as
// toiminimi during 13.0a staging; the fail-closed posture arrives later).
export const finlandEntityType = (client = {}) => {
  const raw = readRawEntityType(client);
  if (!raw) return null;
  return FI_ENTITY_TO_AXIS[raw] || null;
};

// isFinlandOsakeyhtio(client) — true only for an explicit `fi-oy` legal form.
export const isFinlandOsakeyhtio = (client = {}) => finlandEntityType(client) === 'oy';

// isFinlandLegalFormConversion(stored, incoming) — true when BOTH the stored and
// the incoming legal form are recognised Finnish forms AND they differ (a real
// toiminimi↔oy conversion). Deliberately narrow: a null / non-Finnish incoming
// (an omitted entity_type on a re-provision, a foreign form) is NOT a
// "conversion" and never trips the guard — so a routine re-provision that does
// not restate the legal form is untouched. Pure; used to GATE the (cheap but
// non-free) posted-entries probe at the call site before asserting.
export const isFinlandLegalFormConversion = (storedEntityType, incomingEntityType) => {
  const stored = finlandEntityType({ entity_type: storedEntityType });
  const incoming = finlandEntityType({ entity_type: incomingEntityType });
  const isFi = (axis) => axis === 'toiminimi' || axis === 'oy';
  return isFi(stored) && isFi(incoming) && stored !== incoming;
};

// assertFinlandLegalFormNotMutatedAfterPosting({ storedEntityType,
// incomingEntityType, hasPostedEntries, code }) — the immutable-after-posting +
// no-in-place-conversion guard (D-FI13-1 point 4). A Finnish legal-form change
// (e.g. toiminimi → osakeyhtiö) is a NEW legal entity with a new Y-tunnus — it
// must be modelled as a new client + a cutover workflow, NEVER an entity_type
// edit on the posted book. Throws a typed bilingual 409 pointing at that workflow
// when a recognised-form conversion is attempted on a client that already has
// posted entries. A pre-books correction (no posted entries) is allowed, and a
// non-conversion (same form, or a null/non-Finnish incoming) is a no-op.
export const assertFinlandLegalFormNotMutatedAfterPosting = ({
  storedEntityType,
  incomingEntityType,
  hasPostedEntries,
  code
} = {}) => {
  if (!isFinlandLegalFormConversion(storedEntityType, incomingEntityType)) return;
  if (!hasPostedEntries) return;
  const error = new Error(
    `This client's Finnish legal form (${storedEntityType}) cannot be changed in ` +
    `place after entries have been posted. A change of legal form ` +
    `(e.g. toiminimi → osakeyhtiö) is a new legal entity with a new Y-tunnus — ` +
    `model it as a new client plus a cutover, not an entity_type edit.`
  );
  error.statusCode = 409;
  error.code = code || 'FINLAND_ENTITY_TYPE_IMMUTABLE';
  error.fi = `Asiakkaan yritysmuotoa (${storedEntityType}) ei voi muuttaa ` +
    `jälkikäteen, kun kirjauksia on jo tehty. Yritysmuodon muutos ` +
    `(esim. toiminimi → osakeyhtiö) on uusi oikeushenkilö ja uusi Y-tunnus — ` +
    `mallinna se uutena asiakkaana ja cutover-siirtona, ei muokkauksena.`;
  error.storedEntityType = storedEntityType;
  error.incomingEntityType = incomingEntityType;
  throw error;
};

// assertFinlandToiminimiOnly({ client, code, surface, surfaceFi,
// failClosedOnUnknown, unknownCode }) — the reusable KEEP-layer fail-safe (C1).
//
// Two refusals, ordered by severity:
//  1. `oy` — ALWAYS throws (unconditional, never flag-off-able, D-FI13-2): the
//     surface is built for the elinkeinonharjoittaja and would otherwise emit a
//     legally wrong artifact (e.g. the form-5 annual return for an Oy that files
//     6B). This is the 13.0a guard, unchanged.
//  2. `unknown` — throws ONLY when `failClosedOnUnknown` is true (the config-
//     gated 13.0b flip): the client's legal form is not a recognised Finnish
//     form, so the surface cannot safely produce a statutory artifact. With the
//     flip OFF (the default), an unknown form passes through as it does today
//     (the caller treats null as toiminimi during staging) — byte-identical.
//
// Refusals carry fi + en copy per D-FI13-2 and stamp `error.entityType`
// ('oy' | 'unknown') so a caller can mint the right StatutoryBlocker. Returns
// the resolved axis ('toiminimi', or null when unknown and the flip is off) on
// the non-refusing path.
export const assertFinlandToiminimiOnly = ({
  client,
  code,
  surface = 'This Finnish statutory surface',
  surfaceFi = 'Tämä toiminto',
  failClosedOnUnknown = false,
  unknownCode
} = {}) => {
  const axis = finlandEntityType(client);
  if (axis === 'oy') {
    const error = new Error(
      `${surface} is built for the elinkeinonharjoittaja (toiminimi) and is not yet ` +
      `supported for a Finnish osakeyhtiö (Oy). An Oy files veroilmoitus 6B with a ` +
      `separate tilinpäätös — that lane is not built yet.`
    );
    error.statusCode = 409;
    error.code = code || 'FINLAND_ENTITY_UNSUPPORTED';
    error.fi = `${surfaceFi} ei ole vielä tuettu osakeyhtiölle — se on tehty ` +
      `elinkeinonharjoittajalle (toiminimi). Osakeyhtiö antaa veroilmoituksen 6B ` +
      `ja erillisen tilinpäätöksen.`;
    error.entityType = 'oy';
    throw error;
  }
  if (axis === null && failClosedOnUnknown) {
    const error = new Error(
      `${surface} cannot resolve the client's Finnish legal form ` +
      `(elinkeinonharjoittaja / osakeyhtiö) and will not produce a statutory ` +
      `artifact without it. Set the client's legal form before continuing.`
    );
    error.statusCode = 409;
    error.code = unknownCode || 'FINLAND_ENTITY_TYPE_UNKNOWN';
    error.fi = `${surfaceFi} ei voi määrittää asiakkaan yritysmuotoa ` +
      `(elinkeinonharjoittaja / osakeyhtiö) eikä tuota lakisääteistä asiakirjaa ` +
      `ilman sitä. Aseta asiakkaan yritysmuoto ennen jatkamista.`;
    error.entityType = 'unknown';
    throw error;
  }
  return axis;
};
