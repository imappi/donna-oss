-- Ask-lane dedupe (kernel audit F-19 / M1.2) — make "ONE live draft per client"
-- a DATABASE invariant instead of a prose promise enforced by a racy
-- read-modify-write.
--
-- 029's header already states the contract: "ONE drafted client message per
-- (client, period)". The writer (__draftClientAskBatchWithClient) implements it
-- as, inside one transaction:
--     update client_ask_batches set status = 'superseded' where status = 'draft'
--     insert into client_ask_batches (...) values (<id containing Date.now()>)
-- Under READ COMMITTED two concurrent drafters both see zero live drafts at
-- their UPDATE, both insert, and the Date.now() in the id guarantees the two
-- rows never collide. Result: two live drafts for one client — and the ask lane
-- sends the client a message twice. Nothing in the schema refused it.
--
-- This is the Keep layer: the model decides WHAT to ask; the database refuses to
-- let two of those decisions rest live at once. The loser's transaction rolls
-- back and its outbox row retries — no silent duplicate.
--
-- 'draft' is the only sendable state (029's vocabulary), so the partial index
-- covers exactly the live rows: 'sent', 'superseded' and 'cancelled' are
-- terminal history and may repeat freely.

-- 1. Repair before constraining. Any (firm, client) that already carries more
--    than one live draft keeps its NEWEST and supersedes the rest — the same
--    resolution the writer intends, applied to rows that raced before the index
--    existed. Without this the CREATE UNIQUE INDEX below would fail on a book
--    that has already hit the race.
update client_ask_batches b
   set status = 'superseded',
       updated_at = now()
 where b.status = 'draft'
   and exists (
     select 1
       from client_ask_batches newer
      where newer.firm_id = b.firm_id
        and newer.client_id = b.client_id
        and newer.status = 'draft'
        and (newer.created_at, newer.id) > (b.created_at, b.id)
   );

-- 2. The refusal itself.
create unique index if not exists client_ask_batches_one_live_draft_idx
  on client_ask_batches (firm_id, client_id)
  where status = 'draft';
