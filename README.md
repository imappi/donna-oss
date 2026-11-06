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
calls go to OpenAI and Anthropic.

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
