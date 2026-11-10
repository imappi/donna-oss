# Donna

Donna is an AI bookkeeping engine. She reads receipts, invoices and bank
statements, codes each line in the local VAT rules, reconciles bank lines
against documents, and asks the business owner only the questions only they
can answer.

This is a source release of a working codebase, not a supported product.
There is no hosted service, no support and no warranty.

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
PostgreSQL in a folder under your home directory, documents stored on
disk, background jobs in the same process, and a sign-in key you choose.
It is the headless form of the desktop appliance (`scripts/desktop-boot.mjs`).
The demo company is synthetic: Kampaamo Kultalanka Oy, a Finnish
hairdresser, from the test pack in `data/evals/fixtures/fi-kultalanka-2025-02`.

### What you need

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

Reading and booking need keys, set in `.env`. One Anthropic key is
enough for every model task; an OpenAI key is optional.

| Provider | Variable | What it does |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Every model task: routes and reads documents, including the bank statement; codes bank lines; drafts asks; reconciliation triage; bank-line disposition; chat; what Donna remembers. Claude (`claude-opus-5-5` unless a task names another model) |
| OpenAI (optional) | `OPENAI_API_KEY` | The same tasks on OpenAI, used only when no Anthropic key is set |
| Typesafe | `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | First-line decisions on matching, disposition and coding. Without it, bank lines stay "Stalled" |

Each document task has its own model knob: `OPENAI_VISION_MODEL` (bank
statements), `DOCUMENT_ROUTER_MODEL`, `BILL_EXTRACTOR_MODEL`,
`INVOICE_EXTRACTOR_MODEL`, `CONTRACT_EXTRACTOR_MODEL`,
`PAYOUT_EXTRACTOR_MODEL`, `GENERIC_DOC_MODEL`, `RECEIPT_CLASSIFIER_MODEL` and
`CLIENT_INTAKE_MODEL`. A model id in one pins that task to its provider: a
`gpt-*` id sends it to OpenAI even when an Anthropic key is set, and with
only an Anthropic key the document waits for `OPENAI_API_KEY`. The wait
names the knob that caused it. Leave them unset to read on Claude. The
document tasks do not read `OPENAI_MODEL`, and the receipt reader and parser
repair have no knob.

A local book creates every company with the Typesafe lane switched on
(`JEV_RECONCILIATION`). If you have an Anthropic key but no Typesafe key,
add this line to `.env`:

```bash
CLIENT_CONFIG_FORCE_DISABLE=JEV_RECONCILIATION
```

It is the existing kill switch (`forceDisabled` in
`server/donna/clientConfig.js`). It can only switch a capability off. With
it, the bank lines are coded by the Claude coder and the disposition step
instead of staying "Stalled".

When a key is set, the contents of the documents you upload and of the
books are sent to that provider. At start the runtime prints a
`model lanes:` line marking OpenAI and Anthropic `LIT` or `DARK`; the
Typesafe lane is not on it.

### Run on a local model

You can have one company decided by a model you run yourself, on a server
that speaks the OpenAI-compatible chat/completions protocol (llama.cpp's
`llama-server`, Ollama, vLLM and others). It is an explicit opt-in for one
named company at a time, and never the default.

**The model is unqualified.** Donna has not measured it. Every decision it
makes carries `policy_basis: self_hosted_unqualified` and the model id your
server answered with. The `model lanes:` banner, Host Certificate A's
`model_routes` detail and the AI settings screen all say that an
unqualified model decides. It never counts as a qualified model and never
counts as evidence for promoting one. Setting the variables below changes
nothing on its own: only the seat command does.

What does not change is everything after the model answers. The same
instructions, the same schema check after parsing, the same arithmetic,
materiality ceilings, authority grants, evidence rules, period locks and
posting writers apply. Low confidence still stays a proposal. Today a local
model gets exactly the unattended authority a qualified model has on these
lanes, no more and no less. Read "What it may do on its own" below before
you seat one on a real book.

**Which lanes it covers.** Four lanes, all text only:
- `transaction_coding`: coding bank lines, single and batch.
- `reconciliation_reasoning`: matching documents to bank lines (supplier
  bill, sales invoice, receipt, payment confirmation, payout, payment-account
  statement), document disposition, the settlement entry, and owner-reply
  redisposition.
- `bank_line_disposition`: bare bank lines.
- `ask_drafting`: the question put to the owner.

Every other lane stays where it is. It runs on your cloud provider if you
have a key for it, or it is dark if you don't. The command prints the full
list. Reading documents (PDF and images), routing them, PDF statements and
interpreting the owner's reply all stay on a cloud provider. So do chat, the
QA reviewer, merchant lookup and the marketing drafters. Without a cloud key
they don't run. CSV statements need no model. The coder also fetches a
merchant's own website when a bank line names one. That is not a model call,
but it does leave the machine.

**How.**

1. Start your server and note the model id it serves (`GET /v1/models`).
2. Point Donna at it in `.env`:

   ```bash
   OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:8080/v1
   # OPENAI_COMPATIBLE_API_KEY=...   only if your server checks one
   ```

   A server on this machine's loopback address (`localhost`, `127.0.0.1`,
   `::1`) needs no key, and no `Authorization` header is sent to it. Any other
   host needs `OPENAI_COMPATIBLE_API_KEY`. If your server doesn't check
   keys, any value works.
3. Seat it for one company. This is a dry run by default: it prints the plan
   and what your server serves, and writes nothing.

   ```bash
   node scripts/seat_local_model.js --firm <firm id> --client <company id> \
     --member <your firm member id> --model <id your server serves> \
     --all --reason "own llama-server on this laptop"
   # then the same with --apply
   ```

   `--lanes transaction_coding,ask_drafting` seats only some lanes. The
   command refuses in these cases:
   - the server does not list that model id;
   - the id is a qualified id, or names a cloud model family (`claude-*`,
     `gpt-*`);
   - a lane cannot take a local model;
   - there is no named company, no active member, or no reason.

   Each seat is written through the policy writer with an audit receipt.
4. Undo it with the same command and `--clear --apply`. That closes only the
   company's self-hosted seats, each with its own receipt.

If the company has the Typesafe lane on (`JEV_RECONCILIATION`, the local-book
default), Typesafe decides bank-line and document disposition first, and those
steps do not use the seat. The plan says so. Switch it off with
`CLIENT_CONFIG_FORCE_DISABLE=JEV_RECONCILIATION` if you want the seat to
decide them.

**Failure modes to expect.** A small local model fails more often than a
cloud one. Each failure is a typed failure, the same ones the cloud paths
use. Donna never switches to another model:
- an answer cut off at the server's length limit is `PROVIDER_OUTPUT_LIMIT`;
- prose instead of JSON, or JSON that breaks the lane's schema, is
  `PROVIDER_INVALID_OUTPUT`;
- an HTTP error is typed by its status;
- no answer within the deadline (`PROVIDER_REQUEST_TIMEOUT_MS`, default 90
  s; CPU inference is slow) is a timeout;
- a server that answers as another model than the seat names is
  `POLICY_MODEL_MISMATCH`.

What follows from a failure depends on the lane:
- the coder records nothing as a verdict and retries later;
- matching and disposition persist no verdict, and the next sweep retries;
- the asker drafts nothing;
- an unreadable disposition falls to a person.

A server whose context window is smaller than the prompt answers with an
error, and the lane records it the same way. Ask the server for a large
context. Nothing else is called instead: no other model, no reverse shadow,
no challenger.

**What it may do on its own.** These are the existing gates, unchanged. They
apply to a local model exactly as to a qualified one:
- **Coding.** The batch coder applies a medium or high confidence coding
  within its amount limits. On a Donna-ledger company it posts that coding.
  The coding auto-post sweep (`CODING_AUTO_POST`) posts the cases its rules
  allow.
- **Bank-line disposition.** It can mark an immaterial line under the
  materiality ceiling as explained. It drafts an owner question otherwise.
- **Matching.** It can auto-match only where the auto-match policy is on,
  confidence is at least 0.9 and under the ceiling. Above the ceiling it
  needs a delegated-authority grant.
- **Asks.** Drafted asks are drafts. Sending them needs a person, or the
  firm's own auto-send setting.

**Measure it before you trust it with books.** Run the Finnish fixture month
with your model seated, and compare the score with the default model's:

```bash
TZ=UTC DONNA_PG_TEST_URL=... OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:8080/v1 \
  node scripts/fi_month_two_stage_run.js --work=/tmp/local-month \
  --facts=scripts/fixtures/fi_kultalanka_month_facts.json --seat-local-model=<id>
```

`--seat-local-model` seats your model on the run's company before any source
is uploaded. The run's network guard passes loopback only, besides the cloud
providers. The lanes that stay on a cloud provider use your keys as usual.
The run scores the book with `scripts/fi_kultalanka_eval.js`, line by line
against the answer key. Run it once without the option for the default
model's score. A score from that run is your own measurement. It does not
qualify the model.

### Steps

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
npm run demo:fi
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
With an Anthropic key, the February 2025 bank lines (36) appear within a
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

- **`initdb: cannot be run as root`**: run as a normal user.
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
- **Every bank line is "Stalled" although Anthropic is lit**:
  the runtime log shows `Configure the first-line provider model for this
  host`. Set `TYPESAFE_API_KEY` and `TYPESAFE_MODEL`, or switch that lane
  off with `CLIENT_CONFIG_FORCE_DISABLE=JEV_RECONCILIATION` in `.env`
  (see "What needs a model provider key"), then restart the runtime.
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

## Contributing

Pull requests are welcome. Sign off each commit (`git commit -s`) to confirm
you wrote the change and can submit it under the Apache 2.0 licence (the
[Developer Certificate of Origin](https://developercertificate.org/)).
