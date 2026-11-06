// Migration numeric prefixes must be unique — because a collision is SILENT.
//
// `scripts/migrate_firm_db.js:15` keys `schema_migrations.version` on the FULL
// FILENAME, so two files sharing a numeric prefix are two distinct versions:
// both apply, in alphabetical order, with no error and nothing in CI to notice.
// This test is the thing that notices.
//
// ── WHY 060 IS GRANDFATHERED RATHER THAN RENUMBERED ─────────────────────────
//
// `060_hmrc_integration.sql` and `060_procountor_api_key.sql` collided in June
// 2026 and BOTH ALREADY APPLIED IN PRODUCTION — `docs/session-handoff-2026-07-08
// -procountor-reference-sync.md` §C records prod's `schema_migrations` carrying
// both. Renumbering one is therefore not a fix, it is a NEW BUG:
//
//   - the runner keys on the filename, so `112_procountor_api_key` would not be
//     found in `schema_migrations` and would RE-APPLY on the next deploy
//     (`scripts/vercel-build.js` runs `npm run db:migrate` automatically);
//   - and it rewrites history — the dated handoff above would then describe a
//     number the migration never had when it ran.
//
// The re-apply happens to be harmless for this one file (`add column if not
// exists` is idempotent), but that is LUCK, not design, and the pattern must not
// be established. `db/migrations/110_knowledge_base_rls.sql`'s own header makes
// the same point from the other direction: an in-place edit to an applied
// migration "would silently do nothing on exactly the databases that need
// fixing." The rule is absolute: **never renumber, rename, or edit an applied
// migration — always add a new one.**
//
// So the historical pair is recorded here as debt, and — following the
// `LEGACY_RLS_DEBT` convention in `server/donna/migrations.test.js` — this list
// may only ever SHRINK. It cannot shrink by renaming a file; it shrinks only if
// a collision turns out never to have been applied anywhere.
//
// ── WHY 122 IS GRANDFATHERED TOO (2026-08-27) ───────────────────────────────
//
// `122_human_seats.sql` (seats build 1, PR #1829) and `122_ask_audience.sql`
// (universal-mentions slice 2, PR #1830) minted the same number in two
// parallel sessions; the mentions branch predates the seats merge, so the
// collision only became visible once #1829 landed on main — and #1830 merged
// ~22 minutes after it anyway. Production auto-migrates on every deploy
// (`scripts/vercel-build.js` runs `npm run db:migrate` when
// VERCEL_ENV=production), and main deployed after both merges, so
// `schema_migrations` carries BOTH filenames. That is the 060 situation
// exactly: renumbering either file now would re-apply it on the next deploy
// (harmless-by-luck here — both 122s are if-not-exists idempotent — but luck
// is not design, per the 060 record above) and would rewrite a number that
// dated docs, commit messages, and both lanes' handoffs already carry.
//
// Process lesson for parallel lanes: the LATER-merging lane renumbers its
// migration to the next free number BEFORE merge — that is the moment the
// rename is still safe, because preview deploys deliberately skip migrations.

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

const MIGRATIONS_URL = new URL('../db/migrations/', import.meta.url);

// Prefix → the colliding files, as they exist in production's schema_migrations.
// MAY ONLY SHRINK, with one narrow exception mirroring how each entry got here:
// a collision that production has ALREADY APPLIED on both sides (renumbering
// would re-apply — the 060 and 122 records above). A collision caught while at
// least one side is still unapplied takes the next free number instead; using
// this list to make such a collision pass is the one use it must never have.
const GRANDFATHERED_COLLISIONS = new Map([
  ['060', ['060_hmrc_integration.sql', '060_procountor_api_key.sql']],
  ['122', ['122_ask_audience.sql', '122_human_seats.sql']]
]);

const numberedMigrations = async () =>
  (await readdir(MIGRATIONS_URL)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();

const prefixesOf = (files) => {
  const byPrefix = new Map();
  for (const file of files) {
    const prefix = file.match(/^(\d+)/)[1];
    const matches = byPrefix.get(prefix) ?? [];
    matches.push(file);
    byPrefix.set(prefix, matches.sort());
  }
  return byPrefix;
};

test('database migration numeric prefixes are unique (except grandfathered, already-applied collisions)', async () => {
  const files = await numberedMigrations();
  // Floor: an empty or unreadable directory must fail rather than pass vacuously.
  assert.ok(files.length >= 100, `expected at least 100 numbered migrations, found ${files.length}`);

  const collisions = [...prefixesOf(files).entries()]
    .filter(([, matches]) => matches.length > 1)
    .filter(([prefix, matches]) => {
      const allowed = GRANDFATHERED_COLLISIONS.get(prefix);
      // A grandfathered prefix is exempt ONLY for exactly the files recorded. A
      // THIRD file landing on 060 is a new collision and still fails.
      return !(allowed && allowed.length === matches.length && allowed.every((f, i) => f === matches[i]));
    });

  assert.deepEqual(
    collisions,
    [],
    `migration prefix collision(s) — take the next free number from \`ls db/migrations/\`, and never renumber an applied migration: ${collisions.map(([prefix, matches]) => `${prefix}: ${matches.join(', ')}`).join('; ')}`
  );
});

test('every grandfathered collision still exists — the debt list cannot go stale', async () => {
  // Mirrors the LEGACY_RLS_DEBT ratchet: a list that silently describes files
  // nobody has any more would let a real collision hide behind a dead entry.
  const files = new Set(await numberedMigrations());
  for (const [prefix, matches] of GRANDFATHERED_COLLISIONS) {
    for (const file of matches) {
      assert.ok(files.has(file),
        `${file} is grandfathered under prefix ${prefix} but is not in db/migrations — remove it from the list in the same commit`);
    }
  }
});
