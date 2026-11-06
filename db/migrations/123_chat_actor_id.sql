-- 123 — actor_id on the chat stores (universal mentions slice 3;
-- docs/design-donna-universal-mentions.md §6).
--
-- A human COMMENT on an artifact is first-class deliberation and needs to say
-- WHO spoke. None of the four sibling chat tables carries per-row actor
-- identity today — a role='user' row records actor_type='firm' and nothing
-- else; identity exists only at apply-time in audit_events.actor_id.
-- Attribution is a COLUMN, not payload metadata (the pod-safety #1 posture;
-- mirrors bookkeeping_case_events.actor_id and audit_events.actor_id). The
-- value is the same principal identity the apply spine already resolves
-- (chatApplySpine.chatApplyActorId); NULL on every pre-123 row and on
-- machine rows, which the timeline's actor labeling already renders honestly
-- ("identity not recorded").

alter table document_chat_messages
  add column if not exists actor_id text;
alter table transaction_chat_messages
  add column if not exists actor_id text;
alter table client_chat_messages
  add column if not exists actor_id text;
alter table firm_chat_messages
  add column if not exists actor_id text;
