-- Donna — BizOS Slice 2c-iii (Slice A): the IMMUTABLE REPLAY-EVIDENCE store
-- (design-donna-bizos-slice-2c-iii-replay-producer.md §16, DECIDED Kari 2026-07-13).
--
-- The 2c-ii metadata stamp (client_chat_messages.payload->memory_retrieval_shadow)
-- is deliberately TEXT-FREE and lives on a MUTABLE owner message. A faithful
-- point-in-time replay for a CUSTOMER canary needs historically-sufficient evidence
-- the stamp cannot hold: canonical legacy + v2 fact TEXT (the legacy stamp is
-- hash-only and firm_facts has no history; v2 rows can change), the full replay
-- envelope (principal + role/entitlement snapshot, audience, purpose, subjects,
-- config digest, version manifest), per-row AUTHORIZATION receipts (the decision the
-- service ALREADY made at shadow time — never a re-resolution), and immutable
-- session / turn / answer linkage.
--
-- RESTRICTED, APPEND-ONLY: it holds sensitive customer content at rest, INTERNAL
-- ONLY — never in any owner-facing or collaborator projection, never egressed. A
-- correction is a NEW row, never an update (insert-once by the deterministic
-- evidence_id; the primary key is the idempotency guard). RLS on.
--
-- Written post-response by the 2c-ii shadow sidecar (memoryRetrievalShadow.js),
-- gated by the SAME MEMORY_RETRIEVAL_V2 OBSERVE flag — so it accumulates ONLY while
-- a client is staged shadow/canary, exactly like the stamp. The producer that
-- consumes this store to emit a customer-canary artifact is a later slice; the
-- customer artifact waits for enough real, exactly-replayable rows to accumulate.
--
-- Plain columns (the firm_facts / memories / 086 pattern) — tenant FK cascades from
-- firms; NO clients FK (per-client death is the explicit purge, never a silent
-- cascade).

create table if not exists memory_replay_evidence (
  -- Deterministic (turn + purpose + config + version manifest) — insert-once.
  evidence_id             text primary key,
  firm_id                 text not null references firms(id) on delete cascade,
  client_id               text not null,
  -- Session resolved + STORED at capture (decision b): a stored id, never a
  -- replay-time gap heuristic. The producer counts distinct session_id.
  session_id              text,
  -- Immutable answer linkage (the reviewer's requirement): the owner turn and the
  -- assistant answer it produced. The answer TEXT is not duplicated here — it lives
  -- on the immutable assistant client_chat_messages row; a content-hash on the
  -- evidence body detects it changing.
  source_turn_message_id  text not null,
  answer_message_id       text,
  as_of                   timestamptz,
  -- The recorded rendered fingerprint the producer reproduces for the exact-replay
  -- (§14 determinism) check.
  bundle_fingerprint      text,
  -- Self-verifying: a manifest digest over the full evidence body.
  record_hash             text not null,
  -- The historically-sufficient evidence body (memret.replay.evidence.v1): envelope,
  -- version manifest, config digest, canonical legacy + v2 evidence, and per-row
  -- authorization receipts. Sensitive → restricted.
  evidence                jsonb not null,
  created_at              timestamptz not null default now()
);

-- Producer scan: all evidence for a tuple in as_of order (contiguous window,
-- session/day counting, exact-replay reproduction).
create index if not exists memory_replay_evidence_scan_idx
  on memory_replay_evidence (firm_id, client_id, as_of);

-- Session resolution reads the most recent prior row for the tuple.
create index if not exists memory_replay_evidence_session_idx
  on memory_replay_evidence (firm_id, client_id, as_of desc);

alter table memory_replay_evidence enable row level security;
