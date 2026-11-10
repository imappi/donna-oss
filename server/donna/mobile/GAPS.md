# Mobile contract ⇄ Donna: gaps and proposals

Where the pinned contract (`contract/mobile-api.yaml`, from
`imappi/donna-mobile-oss` at the commit in `contract/SOURCE.json`) asks for
something Donna does not persist or cannot do yet. The adapter does not invent
these fields; it returns the contract's own absent value and the gap is listed
here. Contract changes are proposals for the mobile repository; Donna-side
changes are proposals for this one. Nothing here is worked around in code.

## Fields served with the contract's absent value

| Contract field | What the adapter returns | Why | Proposal |
| --- | --- | --- | --- |
| `QueueCard.blocks_close` | `false` | No per-ask close-blocking verdict is persisted: the `client_evidence` close check stores a count, not ask ids. The field is a required boolean, so it cannot be null. | Donna: persist the blocking ask ids on the `client_evidence` close check payload. Contract: allow `null` ("no verdict"). |
| `PeriodStatus.blockers[].card_ids` | `null` | Same: no persisted check → ask link. | As above. |
| `PeriodStatus.completion` | `null` | The persisted period payload carries journal/line counts, not settled-vs-total lines. | Donna: persist settled/total on the checks run summary. |
| `BooksStatus.headline` | `null` | No persisted plain-language headline. | Donna: write it with the checks run. |
| `AskPayload.choices` | `null` | Donna's ask pipeline has no choice shape (DESIGN-NOTES smell 1). | Donna: draft choices at ask-mint time. |
| `ApprovalPayload.batch_key` | `null` | No persisted batch grain for held actions. | — |
| `Entity.business_profile` | `null` until the owner first states a fact | Served from `client_business_profiles` (migration 168), written only by `PUT …/onboarding/profile`. A confirmation with every fact empty declares nothing. | — |
| `QueueCard.counterparty` (asks) | `null` | The ask's persisted `request_payload` carries a descriptor, amount, currency and date, not a counterparty. | Donna: persist the counterparty at ask-mint time. |
| `MobileSettings.financial_year.*` | `null` when the book has no `fiscal_years` rows | Read only from persisted `fiscal_years` (via `GET /clients/:id/fiscal-periods`). A self-provisioned book has none until the fiscal-period intake or the close records one; the calendar projection is not persisted data. `first` is shown only when the earliest persisted year starts on the recorded incorporation date. | Donna: record the first tilikausi at birth when the incorporation date is known. |
| `MobileSettings.vat_period` (UK) | `quarter` when `profile.gb.vat_stagger` is recorded, else `null` | An HMRC stagger (1/2/3) is a quarterly stagger; monthly and annual UK filers have no home in the profile. | Donna: a UK filing-frequency fact. |
| `MobileSettings.notification_delivery` | `not_configured` | No push sender exists; the switches are stored (migration 167) and nothing reads them to send. | — |
| `Entity.currency` / `country` | Client profile currency → firm currency → `EUR`; client jurisdiction → firm jurisdiction → `ZZ` | Both are required strings; a client with neither persisted has no true value. | Contract: allow `null`. |

## Behaviour the contract wants that Donna does not offer to an owner

- **Retry a failed parse.** `POST /documents/retry-parse` is firm-member-only
  (async-parsing plan). The adapter passes the refusal through as
  `403 RETRY_NOT_AVAILABLE_TO_OWNER`; the contract lists only 200/409. Either
  Donna decides owners may retry (a policy change in the route, not here), or
  the contract adds the 403 and the app offers "upload again".
- **The owner's note.** Stored on a `reject` (the decline's reason) and on a
  `veto_flag` ("this was wrong"), trimmed, as `metadata.note` on the decision's
  own audit row (`outbound_action.cancelled` / `outbound_action.marked_wrong`),
  written by the writer in the decision's transaction and attributed to the
  owner; that row is the receipt. The web portal's owner can send the same
  `note` to the same firm routes. A note on `approve` or `answer` is not
  stored: the contract describes the note as a reject reason or veto context,
  an approval writer takes none (`decideOwnerAction` refuses one, `400
  OWNER_NOTE_NOT_ACCEPTED`), and an answer's words are `answer.text`. The
  receipt does not echo the note (the contract's `ApplyReceipt` has no field
  for it). A repeat decision writes nothing, so a note sent with a repeat is
  not stored.
- **`idempotency_key`.** Accepted and ignored, by design: no key store. The
  writers are idempotent by state — a repeat of an applied decision matches
  zero rows and answers `applied:false, already:<state>` (the contract's
  promise for an offline replay) with no second audit row. What the key would
  add, and this server does not do: telling a replay of decision A from a
  different decision B sent with a fresh key after A landed (both answer
  `already`), and returning the first receipt on a replay (a replay gets
  none). Two different decisions racing are settled by the writers' state
  guards, not by the key.
- **Receivable-case escalations and blocked invoices/recurrences.** Their owner
  verbs are pause / dispute / "don't send", not approve / reject, so they are
  not served as approval cards. The four-verb decision enum cannot express
  them. Proposal: a typed verb per case, or leave them on the web.
- **Background records (`purpose: prior_records`).** Donna has no store that
  keeps a file out of the parse/posting pipeline; registering one would parse
  and possibly post it. The adapter answers `501 NOT_IMPLEMENTED`.
- **Finnish cloud-pilot intake.** That intake verifies the registered file's
  `mime_type` and `size` against the upload intent it signed. The contract's
  register item carries neither; the adapter reads both back from that signed
  intent (`readCloudUploadIntentFileFacts`, cloudEvidenceIntake.js: the newest
  intent for exactly this quarantine key, written by the server from the
  values it checked at signing, and only when it is this owner's) and passes
  them to the existing register route. The writer's check against the same
  row and its size + SHA-256 verification of the stored bytes are unchanged; a
  phone value is never used (the contract sends none). A book outside the
  pilot has no intent row and registers as before. Not proven end to end on
  PostgreSQL 16: signing on a pilot book needs pilot processing enabled, which
  needs the PostgreSQL 17 host certificate (`mobilePilotUploadPgLifecycle.test.js`
  follows a register past the intent check to that gate).
- **Channel attribution.** The owner writers behind the phone's decisions
  record `metadata.channel: 'mobile'` on their audit rows:
  `outbound_action.approved`, `outbound_action.cancelled` (decline),
  `outbound_action.marked_wrong` and `evidence_request.reply` /
  `evidence_request.resolve`. The adapter sets it on its in-process request
  (`req.donnaChannel`); an HTTP request cannot, so web rows carry none.
  Attribution only. Not carried: a topic-turn answer writes no audit row; the
  Settings VAT period and business-register changes go through
  `updateClientProfileInDb`, whose `client.profile.update` row is not changed
  here; document registration and the parse audit rows. The adapter's own
  writers (owner name and business profile, notification switches, device
  registrations, deletion requests) already record `terminal`/`channel`
  `mobile`.
- **The ask answer receipt.** `answer_evidence_request` is registered
  `emitsApplyReceipt: 'none'` (DESIGN-NOTES smell 2). The reply writer does
  write its `evidence_request.reply` audit row in the same transaction; the
  adapter's receipt is that row. No ApplyReceipt object exists for it.
- **Settings refusals.** `POST /settings` lists only 200/400/401/404, but a
  VAT-period declaration can be refused `409`: `VAT_PERIOD_IN_USE` (an ALV
  return is pending or filed on another cadence — the draft writer's uniqueness
  is per period key, not per date range, so a cadence change could let a new
  return overlap a filed one), `VAT_PERIOD_FROM_HMRC_STAGGER` (UK: the period
  is the HMRC stagger in filing details, not declarable from the phone),
  `VAT_PERIOD_NOT_SUPPORTED` (no other market), and the profile writer's own
  `FI_PROFILE_PILOT_PREPARED` lock, passed through. Contract proposal: add the
  409 to `updateSettings`.
- **Settings receipt attribution.** The VAT-period receipt is the profile
  writer's `client.profile.update` row: `actor_id` is the owner's principal,
  but that writer records `actor_type: 'system'`. The notification writer
  records `actor_type: 'owner'`.
- **Draft asks.** The web portal lists `draft` asks as open questions too
  (`openEvidenceStatuses` in `donna-client-portal.jsx`); the mobile queue shows
  only sent (`open`) asks, as the contract mapping says. One of the two is
  wrong; worth a decision.

## Device registrations for notifications

`POST` / `DELETE /notifications/registrations` store and remove registrations
(`mobilePushRegistrations.js`, migration 170). Nothing sends yet.

- **No sender.** Donna has no push sender; a registration is stored, never
  used. The module header states the rule a sender must apply (usable only
  while the owner still has a current assignment to the entity the
  notification is about) and that tokens are pruned on Expo's
  `DeviceNotRegistered` receipt.
- **A firm joined later is not covered until the app registers again.** One
  registration has one row per owner principal the identity held when it
  registered, and the app skips re-registering an unchanged token
  (`pushRegistration.ts`). Proposal (app): re-register on sign-in even when
  the token is unchanged — the server answers the same id and writes nothing
  when nothing changed.
- **A lapsing assignment window has no writer to hook.** Access removal and
  client deletion end the rows in their own transaction; an assignment whose
  `ends_at` simply passes leaves the row until that token registers again.
  The sender rule above makes such a row unusable.
- **Errors the contract does not declare.** `registerForPush` lists only
  `201` and `unregisterFromPush` only `204`; the adapter also answers `400
  REGISTRATION_INVALID` (malformed token, platform or locale), `401`, `403`
  and `404 NOT_FOUND` (not your registration) in the `ApiError` envelope.
  Contract proposal: declare them.
- **The token is stored as sent.** A sender needs it, so it is not hashed in
  the row; it is kept out of logs, error bodies and audit metadata (receipts
  carry a 12-hex sha256 prefix). The table is server-side only (RLS block).

- **Renaming the business from the app.** `PUT …/onboarding/profile` refuses
  a `business_name` that differs from `Entity.display_name` (`400
  BUSINESS_NAME_CHANGE_NOT_AVAILABLE`; nothing in the request is saved). The
  only home for the name is `clients.company_name` (mirrored from
  `profile.companyName`), and that column is also the seller name on issued
  invoices (`finland/invoiceIssuance.js`, `ownerInvoiceSellerContext.js`), the
  close-archive heading, the client identity anchor in extraction and coding
  prompts and the owner-adoption digest. Donna has no separate trading-name
  home. Decision needed: a trading-name field read by display only, with
  statutory output reading the registered legal name, or an explicit rule that
  the owner's name for the business is the invoice name.
- **Undeclared statuses on the profile save.** A staff identity is `403
  MOBILE_OWNER_ONLY`, as on every route; a save still contended after three
  attempts is `409 PROFILE_SAVE_CONTENDED`. The operation lists only
  400/401/404.
- **Owner name across firms.** `owner_name` is written to the acting owner's
  collaborator row in the entity's firm; each firm keeps its own row and its
  own name (the adapter never copies a name into another firm's records). The
  contract has one principal name, so `/me` (and sign-in) shows the name on
  the row the owner most recently declared a name on (`owner.name.declared`),
  in whichever firm; with no declaration yet, the first firm's (by firm id).
  An owner with two different names sees the one they saved last in the app;
  each firm still addresses them by the name on its own row. `principal.id`
  stays the first firm's principal. Proposal (contract): a name per entity, if
  the app should show the one each firm holds.

- **Account deletion is recorded, not carried out, and the firm is not told.**
  The contract says the backend "carries it out without any further human
  gatekeeping". `POST /me/deletion-request` records one request per owner
  identity (`owner_deletion_requests`, migration 171, status `recorded`) with
  an audit row per firm, and deletes nothing: what is deleted, when, by whom
  and under which retention period per market is an undecided policy, and the
  books are also the accounting firm's records (the only deletion writer,
  `deleteClientInDb`, is firm-side and removes a whole client). No existing
  primitive puts the request in front of the firm's owner without bending it
  (a seat ask needs an artifact or standing-subject anchor and would read as
  an open bookkeeping question in convergence, the firm feed and close;
  `mention_notifications` accepts only transaction/document artifacts), so
  the server's message says the firm was NOT told and asks the owner to
  contact them. Proposal (Donna): decide the policy, then a firm-side
  hand-off and the writer that carries it out. Proposal (contract): describe
  the request as recorded-and-handled-by-the-firm until then.

## Endpoints answering `501 NOT_IMPLEMENTED`

Chat (list, send, apply), artifact conversations, mileage, activity, onboarding
voice/text drafts, business register lookup, reviews. Each has no
existing Donna reader or writer to route to, or (chat) one whose action
vocabulary does not match the contract's (`answer_evidence_request` /
`record_mileage` vs `answer_card` / `approve_card` / `record_mileage`, with
apply addressed by message + index rather than action id). Serving chat
messages without their proposals would hide them, so the whole chat unit
waits. Mileage exists only as a chat-proposal verb. The reviews endpoint could
answer `source: not_configured`, but that would claim a configured-ness
decision Donna never made; it answers 501 like the rest.

## Business register (`business-setup`)

GET and POST are served (`mobileBusinessSetup.js`); every change is one
`profile_patch` through the firm route `POST /clients/:id/profile` and its
writer `updateClientProfileInDb`, whose `client.profile.update` audit row is the
receipt. Homes: `profile.businessId` (the Y-tunnus the invoice seller contexts
read), `profile.legalName` (the legal name; `company_name` is written only when
empty), `profile.business_register` (legal form, form code, registered address,
source, who confirmed and when), `profile.business_setup` (stage, deferred).
`entity_type` is never written: it is the statutory axis the Finnish tax
modules branch on.

| Contract field / behaviour | What the adapter does | Why | Proposal |
| --- | --- | --- | --- |
| `POST …/business-setup/lookup` | `501 NOT_IMPLEMENTED` | The PRH open-data response shape could not be confirmed: the official API description (avoindata.prh.fi) and the open-data portal (avoindata.suomi.fi) are unreachable from the build sandbox, and Donna does not write a provider's shape from memory (the same reason `finland/prepaymentRegister.js` ships no live adapter). | Donna: confirm the v3 `companies` shape from the official description or a live response, then add the transport (injected, with a timeout), its host in `providerEndpoints.js`, and an entity-scoped 15-minute candidate store. |
| `confirm_registry` | `409 REGISTRY_CANDIDATE_EXPIRED` for every candidate id | No lookup issues candidates, so none is ever current; this is the contract's own answer for one that is not. | Follows the lookup. |
| `BusinessIdentity.registered_address` (manual) | `''` | `confirm_manual` carries no address. | Contract: allow `null`, or add an address to `confirm_manual`. |
| `BusinessSetup.identity` | `null` unless the owner confirmed it on this surface | A Business ID recorded another way (the firm, the invoice chat) has no source the contract can name (`prh_ytj` or `owner`). It still counts as associated: a different ID is `409 BUSINESS_ID_LOCKED`, the same ID may be confirmed. | Contract: a `firm` source, or an `associated_business_id` field. |
| `legal_form` vs the book's legal form | Stored as said, beside `entity_type`, never reconciled | Changing `entity_type` changes tax and filing behaviour; this surface must not. | Donna: surface a mismatch to the firm as a review item. |
| `prior_record_ids` | `[]` | Background records are not supported by this server (`purpose: prior_records` answers 501). | Follows background records. |
| `next_step` | identify_business → business_stage → first_receipt → done; never `prior_records` | Sending the owner to a step this server cannot store would fail. | Follows background records. |
| `suggestion_available` | `true` once the entity has any document | The contract's reference timing; Donna can say it from `documents`. | — |
| `capabilities` | The contract's fixed values | Each enum has one value; they are not verdicts about this book. | Contract: real verdicts if the app should rely on them. |
| `confirm_manual` outside Finland | `400 BUSINESS_REGISTER_FINLAND_ONLY` | The Business ID format and register are Finnish; the contract lists no country refusal for this POST. | Contract: name the refusal. |

## Contract file quirks

YAML flow mappings with an unquoted comma inside a description parse the
comma as a second key: `QueueCard.amount` (`Signed, major units.`) and
`Document.document_type` (`Backend classification, display only.`) each gain a
stray `"major units." / "display only.": null` key. Proposal: quote those
descriptions. The conformance validator ignores null-valued stray keys.
