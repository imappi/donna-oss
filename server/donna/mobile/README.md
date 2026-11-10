# Donna mobile API adapter

The owner-scoped server side of the phone app (`imappi/donna-mobile-oss`).
The app speaks one OpenAPI contract; this directory implements it as a thin
router over Donna's existing reads and writers.

- **Mount:** `/api/donna/mobile/v1` (`server/index.js`, `api/donna-router.js`
  via the `vercel.json` rewrite). Point the app at it:
  `EXPO_PUBLIC_API_URL=https://<host>/api/donna/mobile/v1`.
- **Kill switch:** `DONNA_MOBILE_API=off` answers every request `503
  MOBILE_API_DISABLED`. The environment can only switch this surface off.
- **Who may use it:** a verified identity-provider user who is no firm member
  anywhere and resolves to a non-seat `firm_collaborators` row with role
  `owner` (the snapshot's own owner-surface rule) with at least one current
  `client_assignments` row. Each assigned client is one contract entity. Staff
  are refused at sign-in (only the provider session just minted is revoked;
  their web session is untouched); another client's
  entity is 404. The shared `DONNA_ACCESS_TOKEN` is never accepted.
- **How it acts:** every read and write is the existing firm route, run
  in-process with the caller's verified identity (`mobileDispatch.js`), so it
  carries the same access, entitlement, readiness and capability checks and
  has the same consequences as the web portal. Projections back to the
  contract are pure (`mobileProjection.js`); receipts are the audit rows the
  writer committed in its own transaction.
- **Sign-in:** the identity provider's password grant, server-side
  (`mobileAuth.js`), rate-limited per email and per client address
  (in-process: a floor in front of the provider's own limit). Sign-out ends
  only the phone's session (`logout?scope=local`); the provider's default
  would also sign the owner out of the web portal.
- **CORS:** any origin, no credentials — authentication is a bearer token the
  app attaches itself.

## The contract pin

`contract/mobile-api.yaml` is a byte-identical copy; `contract/SOURCE.json`
records the source commit and hash; `contract/mobile-api.json` is the rendition
the tests read. Refresh with:

```sh
git clone --depth 1 https://github.com/imappi/donna-mobile-oss ../donna-mobile-oss
node scripts/refresh_mobile_contract.mjs ../donna-mobile-oss
node --test server/donna/mobile/mobileApi.test.js
```

A contract change is a reviewed change to this adapter: the coverage test
fails until every operation is routed or listed as `NOT_IMPLEMENTED`.

## Tests

- `mobileApi.test.js` — pin integrity, coverage of all 34 operations, schema
  conformance of every projection, the queue doctrine, refusals without a
  database.
- `mobileApiPgLifecycle.test.js` — PostgreSQL 16 + the real runtime (appliance
  harness): sign-in, capture to parsed (with concurrent identical registers
  collapsing), Donna's question answered through the portal's reply route,
  approval and FYI through the outbound owner writers, status from persisted
  close verdicts, sign-out, kill switch, and the staff / foreign-entity /
  expired-token / admin-token refusals; every response validated against the
  contract.
- `mobileSettings.test.js` / `mobileSettingsPgLifecycle.test.js` — the
  Settings resource (`mobileSettings.js`, `mobileSettingsDb.js`): VAT period
  through the client-profile writer with its history guard, persisted fiscal
  years, the owner's notification switches (migration 167) and phone number,
  and the refusals.

- `mobileBusinessSetup.test.js` / `mobileBusinessSetupPgLifecycle.test.js` —
  the business register: parsing, projection and patches; then on PostgreSQL
  the manual confirm, stage and defer through the firm profile route, and the
  no-token / staff / foreign-entity / stale-candidate / replaced-ID (including
  a race) / non-Finnish / lookup refusals.

- `mobilePushRegistrations.test.js` / `mobilePushRegistrationsPgLifecycle.test.js`
  — device registrations (migration 170): validation, idempotency, a token
  moving to another owner, removal, the not-yours 404, and registrations
  ending with the owner's access (removal, client delete, collaborator row).

`GAPS.md` lists what the contract asks for that Donna cannot say yet.
