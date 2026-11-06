alter table transaction_review_queue
  add column if not exists review_state text not null default 'suggested'
  check (review_state in ('suggested', 'accepted', 'asked_client', 'waiting', 'resolved', 'synced'));

update transaction_review_queue
set review_state = case
  when payload->>'review_state' in ('suggested', 'accepted', 'asked_client', 'waiting', 'resolved', 'synced')
    then payload->>'review_state'
  when payload->>'xero_sync_status' = 'synced' or payload ? 'xero_synced_at' or payload ? 'synced_at'
    then 'synced'
  when payload->'evidence_request'->>'status' = 'open' or payload->>'transaction_status' = 'needs_client'
    then 'waiting'
  when status in ('closed', 'dismissed')
    then 'resolved'
  when payload->>'ai_suggestion_status' in ('applied', 'alternative_applied', 'reviewer_applied', 'auto_applied')
    then 'accepted'
  else 'suggested'
end
where review_state = 'suggested';

update transaction_review_queue
set payload = payload || jsonb_build_object('review_state', review_state)
where payload->>'review_state' is distinct from review_state;

create index if not exists transaction_review_queue_firm_client_review_state_idx
  on transaction_review_queue(firm_id, client_id, review_state);

