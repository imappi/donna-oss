# Donna

Donna is an AI bookkeeping engine. She reads receipts, invoices and bank
statements, codes each line in the local VAT rules, reconciles bank lines
against documents, and asks the business owner only the questions only they
can answer.

## Status

- **Finland** is the most complete market: ALV coding, the Finnish chart of
  accounts, ALV return drafts and reconciliation.
- **The UK** has VAT coding, the nine-box return draft and Xero writeback,
  with less of it switched on.
- **Singapore, the US and the UAE** are partial.
- Many capabilities sit behind per-client flags and are off by default.
- Comments and tests refer to design records under `docs/`. Those are
  internal and not part of this release.

## How it is built

Three rules shape most of the code:

1. **Every item ends in one of two states.** Either Donna settles it, or a
   named person is asked about it. Nothing rests in between. A single
   projection (`server/donna/reconcileConvergenceState.js`) decides which,
   and a test holds it to that.
2. **A strong model does the judgement; deterministic checks guard the
   ledger.** The model reads documents, codes lines and proposes matches.
   Every change goes through accounting-aware writers that check
   double-entry balance, period locks, tax-code compatibility, duplicates
   and materiality. Low confidence stays a proposal, never a posting.
3. **Every change leaves a receipt:** who or what made it, why, on what
   evidence, and which check it passed.

## Stack

Node.js 20, PostgreSQL 16, React with Vite, Supabase for authentication and
file storage, Inngest for background jobs, and Vercel for hosting. Model
calls go to OpenAI, Anthropic and Typesafe.

## Run Donna locally

This runs Donna on one machine with no outside services: its own
PostgreSQL, documents stored on disk, background jobs in the same process,
and a sign-in key you choose. It is the headless form of the desktop
appliance (`scripts/desktop-boot.mjs`). The demo company is synthetic:
Kampaamo Kultalanka Oy, a Finnish hairdresser, from the test pack in
`data/evals/fixtures/fi-kultalanka-2025-02`. There are two ways to start
it: with Docker (one command), or on the host. To see it work first, with
no provider key, start with the zero-key demo.

### The zero-key demo

One command, no provider key, no network call. On the host (what you need
is listed under "What you need on the host"):

```bash
git clone https://github.com/imappi/donna-oss.git
cd donna-oss
npm ci
npm run build
npm run demo:fi
```

Or with Docker, from the same checkout:

```bash
docker compose run --rm --service-ports demo
```

It starts the runtime and the web app on a book of its own (on the host
`~/.donna-demo`; with Docker the database `donna_demo` and the volume
`donna_donna-demo-data`), never the book of the starts below. It creates
the demo firm and company with its ALV registration, uploads the month's
26 documents, runs the scheduler's work to rest, gives the owner's answers
(`scripts/fixtures/fi_kultalanka_month_facts.json`) and runs to rest
again, in under a minute. It ends with a summary read from the stored rows
and keeps the book up:

```text
[demo] replay at rest in 36 s
[demo] journals: posted 19
[demo] bank lines (coding/convergence): … posted/auto_reconciled 19 …
[demo] posted lines by tax code: ALV_25_5_INPUT 4, ALV_25_5_OUTPUT 4, ALV_EU_ACQUISITION 1, …
[demo] sign in at http://127.0.0.1:5173/firms with the access key …
```

Open the address it prints (with Docker, <http://127.0.0.1:5174/firms>),
paste the printed access key, and choose Kampaamo Kultalanka Oy. Every
screen says **Demo: recorded model outputs**. Ctrl-C stops it. To start
again from nothing: `rm -rf ~/.donna-demo` on the host; with Docker,
`docker compose down` then `docker volume rm donna_donna-demo-data` and
drop the `donna_demo` database.

**The model answers are recorded, not live.** They were made once from a
real run of this month and are committed in
`data/demo-replay/fi-kultalanka-2025-02.json`: reading the receipts and
invoices, matching them to bank lines and triaging bank lines by
Anthropic `claude-opus-4-8`; document routing, statement reading, coding
and ask drafting are, in this recording, scripted stand-ins written from
the pack in the OpenAI response format (`gpt-5.4`), marked
`scripted_stand_in` in the file and on screen. Every model call leaves the
process through one seam (`server/donna/providerReplay.js`); the demo
answers it from the recordings, so every parser, schema check, VAT rule
and posting check runs on the recorded answer as on a live one. A request
the recordings do not hold stops with `PROVIDER_REPLAY_UNRECORDED`, naming
the lane, the model and where it differs; it never goes to the network.
Each receipt names the recorded model with `+replayed` after it, and the
runtime's `model lanes:` line says `REPLAY`.

The demo serves only its own company: it refuses to start on a book that
holds any other firm or company, and stops answering if one appears.
To re-record (on the host, with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`
in `.env`, and about 15 USD of model calls): `npm run demo:fi:record`.

The starts below run the same book on live providers, with your own keys
and your own data.

### Start with Docker

You need git and Docker with Compose 2.24 or later: Docker Desktop on
macOS or Windows, Docker Engine on Linux. Node.js and PostgreSQL are not
installed on your machine; PostgreSQL 16 runs in a container of its own.
This start has been run on Linux (x86_64) with Docker Engine. Docker
Desktop on macOS and Windows, and arm64 machines such as Apple-silicon
Macs, have not been run yet; the images it uses are published for both
amd64 and arm64.

```bash
git clone https://github.com/imappi/donna-oss.git
cd donna-oss
cp .env.example .env    # Windows: copy .env.example .env
docker compose up
```

Before `docker compose up`, put a long random string after
`DONNA_ACCESS_TOKEN=` in `.env`: it is your sign-in key (on Linux and
macOS, the `sed` line in step 2 below writes one). Provider keys go in
the same file (see "What needs a model provider key"); the image never
contains a key or a `.env`. Without a `.env`, Donna still starts and
prints a sign-in key in its log (`access token: …`) that changes on every
start.

The first start builds the image and applies every migration, in a few
minutes. It is ready when it prints:

```text
web-1  | [local-web] Donna web app on http://127.0.0.1:5173/firms (API forwarded to 127.0.0.1:8787; listening on 0.0.0.0:5173)
```

Open <http://127.0.0.1:5173/firms> and sign in with the key. The web app
is published on this machine's loopback only; set `DONNA_LOCAL_WEB_PORT`
in `.env` for another port. To load the demo company (step 5 below), in a
second terminal:

```bash
docker compose exec runtime node scripts/load_finnish_demo.mjs
```

It prints the same `[demo]` lines as step 5; add `--all-documents` for the
whole month. Without a `.env`, pass the printed key:
`docker compose exec -e DONNA_ACCESS_TOKEN=<key> runtime node scripts/load_finnish_demo.mjs`.
Steps 6 to 8 then apply as written.

Where the books live, and what keeps them:

- The database is in the Docker volume `donna_donna-db`; uploaded
  documents and backup packages are in `donna_donna-data`.
- Ctrl-C, `docker compose stop` and `docker compose down` stop Donna and
  keep both volumes. `docker compose down --volumes` deletes them, and
  with them the books; nothing else does.
- After `git pull`, `docker compose up` rebuilds the image. If the new
  version brings migrations, the runtime first writes a verified backup
  package into `donna_donna-data`, then applies them, as on the host;
  nothing is deleted.
- After changing `.env`, run `docker compose up` again; it restarts the
  runtime with the new values.
- Logs: `docker compose logs runtime` (and `db`, `web`).

The containers run as an unprivileged user, so the root-user error below
cannot occur. The image is built from your checkout: uncommitted changes
to the runtime's code (for example under `server/` or `db/migrations/`)
are reported by the readiness check as a changed build and pause the
background jobs, as they do on the host.

### What you need on the host

- Linux or macOS. The local database listens on a Unix socket only.
- A normal user account. PostgreSQL refuses to initialise as root.
- Node.js 20.6 or later, with npm. CI uses Node 20.
- The PostgreSQL 16 programs (`initdb`, `pg_ctl`). Donna starts and stops
  its own server; you do not need one running.
  - Ubuntu 24.04: `sudo apt install postgresql-16`. On Debian 12 and older
    Ubuntu, add the PostgreSQL apt repository first.
  - macOS: `brew install postgresql@16`, or Postgres.app.
  - Elsewhere: set `PG_BIN` in `.env` to the folder that holds `pg_ctl`.
- git, openssl, a web browser, and about 500 MB of disk.

### What needs a model provider key

With no key, everything below works up to reading documents: the runtime
starts, you sign in, the demo firm and company are created with their
Finnish chart of accounts, and uploads are stored. No document is read.
The statement row shows as "Stalled" and an uploaded receipt waits.

Reading and booking need keys, set in `.env`:

| Provider | Variable | What it does |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | Routes and reads documents, including the bank statement; coding; drafts asks |
| Anthropic | `ANTHROPIC_API_KEY` | Reads receipts and invoices (preferred over OpenAI when both are set); reconciliation triage; bank-line disposition; chat |
| Typesafe (optional) | `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | With both set, makes the first-line decisions on matching, disposition and coding, and the lanes above take over only when it hands a case on. Without them, the lanes above make those decisions |

Typesafe is optional. A company created on a local book has the first-line
lane switched on (`JEV_RECONCILIATION`), but the lane decides only on a host
where both Typesafe values are set; anywhere else it is dark, and the bank
lines are coded by the OpenAI coder and the Anthropic disposition step. The
first time a company's lines are decided without it, the audit trail records
one `model_lane.first_line_dark` row for that company naming the missing
values.

When a key is set, the contents of the documents you upload and of the
books are sent to that provider. At start the runtime prints a
`model lanes:` line marking OpenAI and Anthropic `LIT` or `DARK`; it ends
with `typesafe LIT` or `typesafe DARK — no TYPESAFE_API_KEY, no
TYPESAFE_MODEL`, naming each value that is missing.

### Steps on the host

**1. Get the code and build the web app.**

```bash
git clone https://github.com/imappi/donna-oss.git
cd donna-oss
npm ci
npm run build
```

`npm run build` ends with `✓ built in …`.

**2. Make your `.env` and choose a sign-in key.**

```bash
cp .env.example .env
sed -i.bak "s/^DONNA_ACCESS_TOKEN=.*/DONNA_ACCESS_TOKEN=$(openssl rand -hex 24)/" .env && rm .env.bak
```

To use model providers, put their keys in `.env` now. You can also add
them later: a document uploaded without a key waits for it (see
Troubleshooting).

**3. Start the runtime.** In a terminal of its own:

```bash
npm run local:runtime
```

The first start creates the database and applies every migration, which
takes under a minute. It is ready when it prints:

```text
[desktop-boot] Donna is up. Ctrl-C to stop.
```

Leave it running. Everything Donna does is logged in this terminal.

**4. Start the web app.** In a second terminal, in the same folder:

```bash
npm run local:web
```

```text
[local-web] Donna web app on http://127.0.0.1:5173/firms (API forwarded to 127.0.0.1:8787)
```

**5. Load the demo company.** In a third terminal:

```bash
npm run demo:fi:load
```

```text
[demo] firm created: firm-demo-tilitoimisto (FI, EUR)
[demo] company created: Kampaamo Kultalanka Oy (3224455-8, fi-oy)
[demo] uploaded: 01 OP Tiliote 02-2025.pdf
```

The script goes through the runtime's own routes, as the web app does: it
creates the firm (Demo Tilitoimisto), creates the company, and uploads the
February 2025 bank statement. The pack's answer key (file 90) is never
uploaded. Add `-- --all-documents` to upload the other 26 documents of the
month too. Running it again changes nothing.

Creating a company on a local book stages its capability flags on the
configuration plane, as for any company created there
(`server/donna/desktop/hostPlaneSeed.js`): `DOCUMENT_EXTRACTORS_ENABLED`,
`DOCUMENT_LINES_ENABLED`, `GENERIC_DOCUMENT_EXTRACTOR_ENABLED`,
`DOCUMENT_ROUTER_ENABLED`, `BANK_STATEMENT_LLM_EXTRACTION`,
`CODING_AUTO_POST`, `JEV_RECONCILIATION`, `LEDGER_AUTO_POST`,
`JURISDICTION_ACCOUNT_PALETTE`, `JURISDICTION_TAX_CODING`,
`FINLAND_ALV_CODING`, `RECONCILIATION_ASK_QUIESCENCE_GATE`,
`ASK_SEND_SETTLE_GATE`, `OPERATOR_CAPABILITY_ENFORCE`, `MODEL_CHALLENGER`,
`DOCUMENT_NO_LINE_DISPOSITION`, `RECONCILIATION_MATERIAL_AUTO_FYI`,
`RECONCILE_AUTO_EXPLAIN_RETRACTS`, `RECONCILE_RETRACTION_AUTOSEND` and
`MEMORY_CANDIDATES` at stage `auto`; `DOCUMENT_SETTLEMENT_LEDGER_ENTRY`
for a Finnish Oy; and, from the readiness check run at creation,
`ENTITY_READINESS_ADMISSION` at `canary`. The demo script stages nothing
itself.

**6. Sign in.** Open <http://127.0.0.1:5173/firms>. The screen asks for an
access key. Paste the value of `DONNA_ACCESS_TOKEN`:

```bash
grep DONNA_ACCESS_TOKEN .env
```

This key is the only sign-in on a local book. Anyone who has it can read
and change every company on it.

**7. Look at the company.** Choose Kampaamo Kultalanka Oy in the sidebar.
With an OpenAI key, the February 2025 bank lines (36) appear within a
minute or two of step 5. Without one, the statement is the only row.

**8. Upload a document.** Open the owner's view of the company at
<http://127.0.0.1:5173/portal/kampaamo-kultalanka-oy>. It opens in
Finnish; to read it in English, choose English in the language list at
the top (Käyttöliittymän kieli). In the upload area, press **Choose
files** (Valitse tiedostot) and pick a receipt from the pack, for example
`data/evals/fixtures/fi-kultalanka-2025-02/sources/47 Kuitti 21.02 - VR lippu.pdf`,
then press **Upload 1 file** (Lähetä 1 tiedosto).

Watch the runtime terminal: a `parse-document` job starts within seconds
and logs what it found. With keys, the receipt is read and appears as a
row of its own on the firm view, beside the bank line of the same amount.
Without keys, the log says `waiting for the model provider; no attempt
spent` and the document waits for its key (see Troubleshooting).

**9. Stop and reset.** Press Ctrl-C in the runtime and web terminals. The
data stays in `~/.donna-desktop` (or `DONNA_DESKTOP_DATA_DIR`) for the next
`npm run local:runtime`. To start again from nothing, stop both and delete
that folder:

```bash
rm -rf ~/.donna-desktop
```

### Troubleshooting

- **`initdb: cannot be run as root`**: run as a normal user, or use the
  Docker start.
- **`port is already allocated` from `docker compose up`**: another program
  has port 5173. Set `DONNA_LOCAL_WEB_PORT` in `.env`.
- **`Postgres 16 binaries not found`**: install them (above), or set
  `PG_BIN` in `.env`. A `PG_BIN` that points at another major version is
  refused.
- **`node: .env: not found`**: run step 2 in the repository folder.
- **`[demo] nothing is listening on 127.0.0.1:8787`**: start the runtime
  (step 3) and wait for `Donna is up`.
- **The web app says `Your books are temporarily unavailable`**: the
  runtime is stopped or still starting. Wait for `Donna is up` in its
  terminal, then press Try again.
- **`EADDRINUSE` on 8787 or 5173**: another program has the port. Set
  `DONNA_DESKTOP_PORT` or `DONNA_LOCAL_WEB_PORT` in `.env`; both commands
  read the same file.
- **Uploads fail with `Evidence storage upload failed with 404`**: the web
  app is being served by `npm run dev`. The Vite dev server does not route
  the local document store. Use `npm run local:web`.
- **A document is "Stalled" with `No OPENAI_API_KEY on this
  installation: not read yet`**: it was uploaded without the key it needs.
  Nothing is lost and no attempt is spent while it waits. Add the key to
  `.env` and restart the runtime (step 3); each waiting document is read
  within five minutes, under the same upload, with no new upload and no
  reset. The owner's view says only that the file is saved and taking
  longer. The same holds when the provider refuses the key (`… refused
  OPENAI_API_KEY`: fix the key), when the account has no credit left (`…
  has no credit left on this account`: add credit; no restart needed), and
  when the provider cannot be reached at all: the row names the cause and
  is read once the provider answers. A book from an earlier release that left
  such a document failed, or a scanned statement with no lines, reads it
  again once on the first start of this release (also one failed on a
  refused key or after four "no credit" or rate-limit answers).
- **A document is "Couldn't parse after 4 attempts"**: that document
  could not be read on any of its four automatic attempts (for example
  four server errors in a row). It shows its own reason and a Retry; the rest of the book
  keeps working, and new uploads are read as usual. Retry reads it again
  under a new run with four fresh attempts. Do not delete the data folder:
  a book an earlier release stopped over such a document (new uploads
  refused, "The work queue needs recovery") accepts work again on the
  first start of this release.
- **Bank lines stay uncoded with Typesafe set**: a Typesafe key and model
  are set, so the first-line lane decides, and its calls fail. Each line
  names the failure (`coding_provider_failure`, provider `typesafe`) and is
  tried again on the coding clock; no other model decides in its place. Fix
  the key or model, or remove both values to leave the lane dark, then
  restart the runtime.
- **Provider calls fail with 401 behind an HTTPS proxy**: Node's `fetch`
  ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (Node 22.21
  or later).
- **Logs**: the runtime terminal, and PostgreSQL's own log in
  `~/.donna-desktop/runtime/pg.log`.

Other ways to run Donna: `desktop/README.md` covers the macOS desktop app.
`npm run dev` with `npm run api` is the hosted setup and expects Supabase
for document storage and Inngest for background jobs.

### Running it for a firm

The steps above are for one person on one machine. Moving to a server
means deciding each of these. Where the code reads each setting is named.

- [ ] **Database.** Locally, Donna runs a private PostgreSQL 16 on a Unix
  socket under the data folder (`server/donna/desktop/pgSupervisor.js`).
  On a server, choose a PostgreSQL 16 and set `DATABASE_URL`
  (`server/donna/db/pool.js`); apply migrations with `npm run db:migrate`
  (`scripts/migrate_firm_db.js`).
- [ ] **Document storage.** Locally, files go to `DONNA_DESKTOP_BLOB_DIR`
  (`server/donna/desktop/localBlobStore.js`). Setting that variable also
  puts the runtime in local-book mode (`isDesktopHostEnv` in
  `server/donna/desktop/hostPlaneSeed.js`), which decides which routes
  exist and which flags new companies get. The hosted alternative is
  Supabase Storage: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
  (`server/donna/evidenceStorage.js`).
- [ ] **Sign-in.** Locally, one shared key, `DONNA_ACCESS_TOKEN`
  (`getDonnaAccessToken` in `server/donna/api.js`), gives full access and
  names no person. Per-person sign-in uses Supabase Auth:
  `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
  `DONNA_AUTH_ALLOWED_EMAILS` on the server (`getSupabaseAuthConfig` in
  `server/donna/api.js`), and `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY` when building the web app
  (`src/lib/supabaseAuth.js`).
- [ ] **Network.** The runtime and `local:web` listen on 127.0.0.1 only.
  `scripts/local_web.mjs` is a quickstart helper, not a public web server;
  reaching Donna from other machines needs your own HTTPS front end.
- [ ] **Background jobs.** Locally, the scheduler runs inside the runtime
  process (`server/donna/desktop/localScheduler.js`, jobs listed in
  `server/donna/desktop/handlerManifest.js`), and stops when it stops.
  The hosted setup uses Inngest (`INNGEST_EVENT_KEY`,
  `INNGEST_SIGNING_KEY`; `server/donna/inngest/`) and Vercel cron
  (`vercel.json`, `CRON_SECRET`).
- [ ] **Backups.** Locally, the runtime writes a backup package before
  applying new migrations and once a day while running
  (`server/donna/desktop/backupPackage.js`; `DONNA_DESKTOP_BACKUP_DIR`,
  `DONNA_DESKTOP_BACKUP_CRON`, `DONNA_DESKTOP_BACKUP_KEEP`), into the same
  data folder. Copying them off the machine, and testing a restore with
  `node scripts/desktop-backup.mjs restore`, is the operator's to set up.
- [ ] **Model providers.** Which providers may receive the firm's
  documents and books, and whose keys are used (`.env.example` lists them).

## Running the tests

The suite mirrors CI (`.github/workflows/ci.yml`). With a PostgreSQL 16
server running locally:

```bash
npm ci
```

```bash
export CI=true DATABASE_URL=postgresql://donna:donna@127.0.0.1:5432/donna_ci DONNA_PG_TEST_URL=postgresql://donna:donna@127.0.0.1:5432/postgres
```

```bash
npm run db:prepare:ci-host && npm run db:migrate && npm run runtime:initialize:ci-host && npm test
```

Without `DONNA_PG_TEST_URL` the database suites are skipped.

## Licence

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). The licence
does not grant rights to the name Donna.

This is a source release of a working codebase, not a supported product.
There is no hosted service, no support and no warranty.

## Contributing

Pull requests are welcome. Sign off each commit (`git commit -s`) to confirm
you wrote the change and can submit it under the Apache 2.0 licence (the
[Developer Certificate of Origin](https://developercertificate.org/)).
