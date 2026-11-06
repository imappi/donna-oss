-- PR 3 of docs/invoice-receipt-parsing-plan.md. The `transaction_review_queue`
-- table grows a `document_line` item_type, and the shared review-item DTO
-- canonicalises status vocabulary on `open | resolved | cancelled`. Until
-- now callers wrote `closed | dismissed`. Migrate existing rows in place;
-- the helper in server/donna/reviewItem.js still accepts the legacy values
-- on input so a stale DB read or an in-flight HTTP payload doesn't break.
--
-- Idempotent: re-running this migration after the application code has
-- already started writing the new vocabulary is a no-op.

update transaction_review_queue
   set status = 'resolved',
       updated_at = now()
 where status = 'closed';

update transaction_review_queue
   set status = 'cancelled',
       updated_at = now()
 where status = 'dismissed';
