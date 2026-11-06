# Donna Desktop — v0 dev shell

> **Packaging (M0b, bundled PG):** the packaged-app pipeline lives in
> `desktop/electron-builder.yml` + `scripts/desktop-stage-pg.mjs` (stage the
> Postgres payload) + `scripts/desktop-sign-pg.mjs` (afterSign payload
> signing) + `scripts/desktop-verify-bundle.mjs` (acceptance checks). The
> runbook, signing prerequisites, and the M0b exit drills are in
> `docs/session-handoff-2026-08-07-m0b-bundled-pg-packaging.md`. Everything
> below this box is the UNPACKAGED dev-shell lane, which stays as-is.
> **Internal-test DMG (unsigned, 2026-09-11):** the one-paste chain is
> `bash scripts/desktop-build-internal-test.sh` (build UI → stage PG → package
> unsigned → verify → `scripts/desktop-release-receipt.mjs`); runbook, install
> steps and tester notes in `docs/desktop-fi-internal-test-2026-09-11.md`.
> The packaged app mirrors its console to `<data dir>/logs/desktop.log`.

The thin Electron shell over the existing runtime, per
`docs/design-donna-desktop-technical-plan.md` (§1 process architecture).
Main supervises PG + the runtime utility process; the built SPA is served
from `donna://app`; every `/api/*` fetch is proxied by main to the runtime's
private Unix socket with the access token attached main-side — the renderer
never holds a credential.

This is the **dev shell** (first window on a dev Mac), not the M0b packaged
appliance: no signing, notarization, bundled PG, auto-update, backups
surface, or menu-bar residency yet. Those land per the plan's ladder.

## Run it (macOS, Apple Silicon)

One-time setup:

```bash
brew install postgresql@16          # binaries only; the app manages its own instance
npm install                          # repo root
npm run build                        # builds the SPA into dist/
cd desktop && npm install            # Electron (dev dependency of this folder only)
```

**No Homebrew?** You only need the PG 16 binaries, not a running server.
Install [Postgres.app](https://postgresapp.com) (drag to `/Applications`) and
the shell finds it — `/Applications/Postgres.app/Contents/Versions/16/bin` is
an autodetected candidate. You never have to launch Postgres.app or start its
server; Donna runs its own instance on its own private socket and data dir.
Any other install works too via `PG_BIN=/path/to/pg16/bin`. The major is
pinned at 16 for this product generation, and a `PG_BIN` pointing at another
major refuses at startup rather than creating a cluster the rest of the
generation can't open.

Launch:

```bash
cd desktop && npm start
```

First launch runs `initdb` and all migrations (takes a minute); later
launches are fast. Data lives under `~/Library/Application Support/Donna`
(override with `DONNA_DESKTOP_DATA_DIR`). Postgres listens on a private
Unix socket only — no TCP.

To exercise extraction/close (the outstanding M0a exit — a sample close with
a BYO key), set your provider key in the launch environment. The load-bearing
extraction pipeline uses the OpenAI key:

```bash
cd desktop && DONNA_ACCESS_TOKEN=devtoken OPENAI_API_KEY=sk-… npm start
```

No runtime flags needed: the appliance posture applies the runtime-ON env
defaults at boot (`server/donna/desktop/hostRuntimeDefaults.js` — matcher
wave, the order-agnostic re-match sweep, auto-match promotion, extractor
wave, loops ceiling; see `docs/design-donna-desktop-runtime-on.md`). Any
single behavior can still be killed on the launch line (`FLAG=false` wins —
the map never overwrites a set var).

To seed the demo book first: from the repo root,
`DONNA_DESKTOP_DATA_DIR="$HOME/Library/Application Support/Donna" node scripts/desktop-boot.mjs --seed`
once, Ctrl-C it, then `npm start` here (both use the same data dir and PG
instance; don't run them simultaneously — single-instance discipline).

## What you should see

A window on `donna://app/firms` that goes straight to the workspace — no
sign-in form (the desktop shell IS the session; the proxy injects
credentials). Scheduled work (parse drain, sweeps) runs via the local
scheduler. UI iteration sessions can point at this window; the SPA is the
same `src/` build the web serves.

## Troubleshooting

- **"Postgres 16 binaries not found"** — `brew install postgresql@16`, or
  install Postgres.app (no Homebrew needed, autodetected), or set `PG_BIN` to
  any PG 16 bin dir.
- **"PG_BIN points at Postgres N"** — that install is a different major than
  the pinned 16. Point `PG_BIN` at a 16 bin dir; don't unset the pin.
- **Blank window / 404s** — `npm run build` at the repo root first; the
  shell serves `dist/`, it does not run the Vite dev server.
- **"Donna runtime is not reachable"** in the UI — the runtime utility
  process crashed and is restarting (watch the terminal); persistent
  failures usually mean a migration error, visible in the launch logs.
- Logs: PG under `<data dir>/runtime/pg.log`; runtime + main log to the
  terminal that ran `npm start`.
