# Donna MCPB extension — Claude Desktop shim

The one-click Claude Desktop extension for the Donna MCP surface
(`docs/design-donna-mcp-surface.md`). Read-only by construction; every
decision is Donna's (`server/donna/mcp/`), this bundle only translates.

## Layout

- `manifest.json` — MCPB manifest (`manifest_version` 0.3, validated
  against `@anthropic-ai/mcpb` 2.1.2 on 2026-08-21; re-verify against
  https://github.com/modelcontextprotocol/mcpb at submission time — the
  schema moves). The `privacy_policies` array (HTTPS URLs; mandatory for
  directory submission) is NOT filled in yet: the app already serves a
  `/privacy` route, but no public production domain is committed — when
  Kari names it, add
  `"privacy_policies": ["https://<domain>/privacy"]` here.
- `icon.png` — 1024×1024 copy of the app icon (`desktop/build/icon.png`).
  Valid, but Claude Desktop recommends 512×512 — swap in a resized copy
  when design assets exist.
- `server/index.mjs` — stdio entry point Claude Desktop launches.
- `server/shimCore.mjs` — the translation logic (tested:
  `server/shimCore.test.js`). Zero dependencies; the bundle ships no
  node_modules.
- `server/demoFixtures.mjs` — the bundled sample company (tested:
  `server/demoFixtures.test.js`). Content, not logic — see "Demo mode".

## How it connects

Donna Desktop writes `<userData>/runtime/mcp-endpoint.json` (0600) at boot
with the runtime socket path + per-boot token, and removes it on quit
(`desktop/lib/mcpEndpointFile.mjs`). The shim probes the platform userData
locations (override: `DONNA_MCP_ENDPOINT_FILE` or
`DONNA_DESKTOP_DATA_DIR`), re-reading per call so a Donna restart (new
token) needs no shim restart. Donna not running ⇒ tools still list (static
mirror) and calls return a friendly error.

Nothing is exposed by installing this: every entity must be individually
exposed inside Donna (`MCP_ENTITY_EXPOSE`, per-entity, off by default —
Settings → Claude access, or `scripts/enable_mcp_entity_expose.js`), and
every call is receipted in Donna's audit trail.

## Demo mode

When NO endpoint file exists (Donna not installed or not running), tool
calls answer from `server/demoFixtures.mjs` — "Harbor Lane Coffee Ltd
(demo)", a sample company whose responses mirror the real result shapes, so
a directory browser can install the extension and ask "what's blocking the
close?" before connecting anything (design doc §8 item 2; Kari's 2026-08-20
call). Honesty rules, pinned by tests: every demo response carries
`demo: true` plus a notice naming the data as fake and Donna as not
running; demo never mixes with a live Donna (an existing endpoint always
forwards, and a live endpoint that refuses the connection is an error, not
demo). The fixtures are the one sanctioned content exception to the
thin-shim rule — they carry no accounting/policy/authz logic.

## Dev loop (no packing needed)

Point Claude Desktop straight at the entry point via a manual MCP server
entry (`command: node`, `args: [<repo>/desktop/mcpb/server/index.mjs]`)
while Donna Desktop runs.

## Packing (one-click install bundle)

From the repo root:

```
npm run mcpb:validate   # manifest schema check
npm run mcpb:pack       # → dist/donna-books.mcpb (dist/ is gitignored)
```

Both pin `@anthropic-ai/mcpb@2.1.2` — bump the pin deliberately and
re-validate, don't float it. The pack honors `.mcpbignore` (all
`*.test.js` stay out; the pack output lists what was ignored — check it).
Install the produced `.mcpb` by opening it with Claude Desktop.

**Deliberately UNSIGNED:** as of 2026-08-21, `mcpb sign` produces a bundle
Claude Desktop rejects ("Invalid comment length" — the signature is
appended without declaring it in the ZIP EOCD comment field; upstream
https://github.com/modelcontextprotocol/mcpb/issues/278). Signing is not
required for local install. Revisit at submission time: check the issue,
and whether the directory mandates signing.

## Directory submission — still open (on Kari)

- `privacy_policies` URL (see Layout above) + a privacy section in this
  README covering collection/use/storage/sharing/retention/contact.
- Team/Enterprise org for the desktop-extension submission form.
- Naming collision check ("Donna" vs "Donna Bookkeeper").
- Pre-registered S1/S2 success + K-mcp kill numbers. The SHAPES are
  recorded (design doc §10.2: S1 ≥N sourced demo installs/60d; S2 ≥1
  paying seat/90d; K-mcp-1 unstaged-mutation path → pull, fix, re-review;
  K-mcp-2 zero sourced installs/90d → stop channel spend) — Kari fills N
  and ratifies as a dated call.
- License identifier (manifest `license` field) — legal call, not made
  here.
- A real install test on a Mac (this container cannot run Claude Desktop).

Calendar note (design doc §10.1): after the form, expect a multi-week
silent review — budget the calendar, not just the code. The directory is
distribution hygiene; the channel plan is the AEO cluster (§10.2).
