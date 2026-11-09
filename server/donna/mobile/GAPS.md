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
| `Entity.business_profile` | `null` | No canonical business-profile aggregate (DESIGN-NOTES smell 9). | Donna: a profile aggregate and its single writer. |
| `QueueCard.counterparty` (asks) | `null` | The ask's persisted `request_payload` carries a descriptor, amount, currency and date, not a counterparty. | Donna: persist the counterparty at ask-mint time. |
| `Entity.currency` / `country` | Client profile currency → firm currency → `EUR`; client jurisdiction → firm jurisdiction → `ZZ` | Both are required strings; a client with neither persisted has no true value. | Contract: allow `null`. |

## Behaviour the contract wants that Donna does not offer to an owner

- **Retry a failed parse.** `POST /documents/retry-parse` is firm-member-only
  (async-parsing plan). The adapter passes the refusal through as
  `403 RETRY_NOT_AVAILABLE_TO_OWNER`; the contract lists only 200/409. Either
  Donna decides owners may retry (a policy change in the route, not here), or
  the contract adds the 403 and the app offers "upload again".
- **Reject with a note.** `decideOwnerAction` takes no note; `Decision.note` on
  a reject is accepted and not persisted. Same for `veto_flag` context.
- **`idempotency_key`.** Not persisted. Decisions are idempotent by state (a
  repeat answers `applied:false, already:<state>`), which is what the contract
  promises, but two different decisions racing are settled by the writers, not
  by the key.
- **Receivable-case escalations and blocked invoices/recurrences.** Their owner
  verbs are pause / dispute / "don't send", not approve / reject, so they are
  not served as approval cards. The four-verb decision enum cannot express
  them. Proposal: a typed verb per case, or leave them on the web.
- **Background records (`purpose: prior_records`).** Donna has no store that
  keeps a file out of the parse/posting pipeline; registering one would parse
  and possibly post it. The adapter answers `501 NOT_IMPLEMENTED`.
- **Finnish cloud-pilot intake.** That intake verifies the registered file's
  `mime_type` and `size` against its signed intent. The contract's register
  body carries neither, so a mobile register on a pilot book is refused by the
  existing writer. Contract proposal: add `mime_type` and `size` to the
  register item (the app already has both from the intent).
- **Terminal attribution.** Receipts say `actor.terminal: mobile` because the
  request came through this surface, but the writers' audit rows record the
  principal, not the terminal. Donna proposal: an optional channel/terminal
  field on the owner writers' audit metadata.
- **The ask answer receipt.** `answer_evidence_request` is registered
  `emitsApplyReceipt: 'none'` (DESIGN-NOTES smell 2). The reply writer does
  write its `evidence_request.reply` audit row in the same transaction; the
  adapter's receipt is that row. No ApplyReceipt object exists for it.
- **Draft asks.** The web portal lists `draft` asks as open questions too
  (`openEvidenceStatuses` in `donna-client-portal.jsx`); the mobile queue shows
  only sent (`open`) asks, as the contract mapping says. One of the two is
  wrong; worth a decision.

## Endpoints answering `501 NOT_IMPLEMENTED`

Chat (list, send, apply), artifact conversations, mileage, activity, onboarding
voice/text drafts and profile confirmation, business setup and lookup,
settings, reviews, account deletion request, push registration. Each has no
existing Donna reader or writer to route to, or (chat) one whose action
vocabulary does not match the contract's (`answer_evidence_request` /
`record_mileage` vs `answer_card` / `approve_card` / `record_mileage`, with
apply addressed by message + index rather than action id). Serving chat
messages without their proposals would hide them, so the whole chat unit
waits. Mileage exists only as a chat-proposal verb. The reviews endpoint could
answer `source: not_configured`, but that would claim a configured-ness
decision Donna never made; it answers 501 like the rest.

## Contract file quirks

YAML flow mappings with an unquoted comma inside a description parse the
comma as a second key: `QueueCard.amount` (`Signed, major units.`) and
`Document.document_type` (`Backend classification, display only.`) each gain a
stray `"major units." / "display only.": null` key. Proposal: quote those
descriptions. The conformance validator ignores null-valued stray keys.
