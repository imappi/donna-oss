-- Async document parsing — batch_id (PR 4 of 4).
--
-- See docs/async-parsing-plan.md → "PR 4 — Polish". PR 2's /register
-- spec accepted batch_id as an optional UUID but the PR 2 diff never
-- actually persisted it on the documents row. PR 4 needs it to roll
-- up activity-feed entries: "Alice uploaded 23 documents · 18 ready,
-- 2 parsing, 3 failed."
--
-- batch_id is text (not uuid) because the FE accepts a fallback shape
-- when crypto.randomUUID isn't available (see startTrayBatch in
-- src/lib/uploadTray.js). The DB doesn't care about the shape — it's
-- a grouping key, not a key into another table.

alter table documents
  add column if not exists batch_id text;

-- Activity-feed lookup: most recent N batches per firm.
create index if not exists documents_firm_batch_id_idx
  on documents (firm_id, batch_id, created_at desc)
  where batch_id is not null;
