create table llm_decisions (
  id                    text primary key,
  firm_id               text not null,
  client_id             text not null,
  decision_type         text not null,
  target_type           text not null,
  target_id             text not null,
  model_name            text,
  prompt_version        text,
  deterministic_signals jsonb default '{}'::jsonb,
  confidence            jsonb default '{}'::jsonb,
  lane                  text,
  policy_blockers       text[] default '{}',
  llm_reasoning         text,
  llm_raw_response      jsonb,
  final_state           text,
  human_outcome         text,
  human_outcome_at      timestamptz,
  reversal_metadata     jsonb,
  louis_verdict         jsonb,
  louis_evaluated_at    timestamptz,
  created_at            timestamptz default now(),
  resolved_at           timestamptz
);

create index idx_llm_decisions_firm_client on llm_decisions (firm_id, client_id);
create index idx_llm_decisions_target on llm_decisions (target_type, target_id);
create index idx_llm_decisions_lane on llm_decisions (lane) where human_outcome is null;
create index idx_llm_decisions_pending_louis on llm_decisions (firm_id)
  where louis_verdict is null and lane = 'green';
