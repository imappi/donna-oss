-- 130 — Entity readiness retries are budgeted per failure EPISODE, not per
-- entity lifetime.
--
-- Before this migration, entity_readiness_sagas.attempt_count only ever grew:
-- reaching 'ready' kept the count, and migration 127's dependency invalidator
-- marks a saga 'exhausted' whenever attempt_count >= max_attempts. Three
-- routine, legitimate dependency changes over an entity's life (an authority
-- grant minted, a capability staged, a verdict-named ledger account created)
-- therefore permanently exhausted a healthy entity, with no retry route and no
-- heal-pool eligibility — the two-terminal-states violation observed live on
-- 2026-08-31 (Honeybee: ready → verdict-minted account → invalidated →
-- exhausted; Desert Rose: never-ready birth-scope loop → exhausted).
--
-- The code now writes attempt_count = 0 whenever a saga reaches 'ready'
-- (closing the episode) and provisionEntityReadiness accepts a receipted
-- reopen of an exhausted saga. This migration rewinds the counter for rows
-- that reached 'ready' under the old cumulative accounting, so their next
-- invalidation opens a fresh bounded episode instead of landing straight in
-- 'exhausted'. Failed/exhausted rows are deliberately NOT rewritten here:
-- their exit is the explicit, receipted reopen action, never a silent
-- migration-time reset.

-- attempt_count 0 is the new "episode closed" resting value, so the birth
-- constraint (126: attempt_count > 0, written when the counter was a lifetime
-- total that started at 1) relaxes to >= 0.
alter table entity_readiness_sagas
  drop constraint if exists entity_readiness_sagas_attempt_count_check;
alter table entity_readiness_sagas
  add constraint entity_readiness_sagas_attempt_count_check check (attempt_count >= 0);

update entity_readiness_sagas
   set attempt_count = 0,
       updated_at = now()
 where state = 'ready'
   and attempt_count <> 0;
