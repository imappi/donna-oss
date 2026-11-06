alter table transaction_review_queue
  drop constraint if exists transaction_review_queue_review_state_check;

alter table transaction_review_queue
  add constraint transaction_review_queue_review_state_check
  check (review_state in ('suggested', 'accepted', 'asked_client', 'waiting', 'resolved', 'synced', 'posted', 'closed', 'held'));
