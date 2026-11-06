// Donna Loops — the event registry: the single inventory of every QUEUE event the
// loop layer produces or consumes, plus the explicit PARKED-event contract.
//
// WHY THIS EXISTS. The dispatcher (loopOutboxDispatcher.js) deliberately leaves an
// event type it does not understand 'pending' rather than falsely marking it
// 'dispatched' — honest, but SILENT: a producer can enqueue a type that has no
// consumer (proposal_rerun.requested does exactly this) and the row parks forever
// with no owner, no monitor, no activation condition. This module makes that state
// EXPLICIT and ENFORCEABLE. Every queue event is registered here as either:
//   - consumed — a dispatcher handler (outbox) or a LoopDefinition trigger / an
//                inbox-worker special-case (inbox) actually drains it; or
//   - parked   — intentionally produced WITHOUT a consumer yet, carrying its
//                { owner, monitoring, activation } so a parked intent is a named,
//                watched, retireable decision — never a silent orphan.
//
// loopEventRegistry.test.js turns this into a STATIC invariant: every event type
// produced anywhere in the loop source (an enqueueOutbox / insertLoopEvent call)
// must be registered, and every registered, produced event must be consumed-or-
// parked. A new producer that forgets to wire (or park) a consumer fails the test,
// not prod — the guard the audit asked for (the proposal_rerun.requested class).
//
// CLAUDE.md "Keep"-layer: pure data + selectors. No LLM, no DB, no behavior change —
// a test oracle and living documentation, not a runtime gate. (A later phase MAY
// have the dispatcher read parkedEventTypes() to emit a backlog metric; that is
// deliberately NOT wired here.)
//
// CHANNELS:
//   outbox  — enqueued into loop_event_outbox; drained by the dispatcher (its
//             handlers are loopOutboxDispatcher.DISPATCH_HANDLED_EVENT_TYPES).
//   inbox   — inserted into loop_event_inbox; drained by the inbox worker (a worker
//             special-case OR a LoopDefinition wake, loopGoalRegistry triggerMatchers).
// NB case-events (appendCaseEvent -> bookkeeping_case_events) are an APPEND-ONLY
// AUDIT stream, not a queue: they route to no consumer and are intentionally OUT of
// this registry. A name like 'document.parse_completed' is BOTH a case-event (audit)
// and an inbox TRIGGER a LoopDefinition subscribes to — only the latter, queue-
// channel meaning is registered here.

export const LOOP_EVENT_CHANNELS = Object.freeze({ OUTBOX: 'outbox', INBOX: 'inbox' });

export const LOOP_EVENT_REGISTRY = Object.freeze({
  // ── outbox (drained by the dispatcher) ─────────────────────────────────────
  'case.resolved': {
    channel: 'outbox',
    description: 'A case met its goal (engine wake) or had its last blocker cleared (evidence resume) — fan re-evaluation to its downstream dependents (§6.2 cascade).',
    producedBy: ['loopRunEngine.runLoopWake', 'evidenceReplyResume.resumeFromClientReply'],
    consumer: { via: 'dispatcher', handler: 'handleCascade' }
  },
  'goal.regressed': {
    channel: 'outbox',
    description: '"Met once" is not "met forever": an invalidated verdict (match rejected, document corrected) may reopen a resolved case (§13.10).',
    producedBy: ['loopsShadowProducers.onReconciliationMatchRejected', 'loopsShadowProducers.onDocumentCorrected'],
    consumer: { via: 'dispatcher', handler: 'handleRegression' }
  },
  'proposal_rerun.requested': {
    channel: 'outbox',
    description: 'A client reply cleared a coding/evidence blocker; the proposal that reply feeds should be regenerated upstream.',
    producedBy: ['evidenceReplyResume.resumeFromClientReply'],
    parked: {
      owner: 'Loops — the upstream re-evaluation slice (the proposal / reconciliation re-run consumer).',
      monitoring: "select count(*) from loop_event_outbox where event_type = 'proposal_rerun.requested' and status = 'pending' — a growing backlog means the consumer is still missing.",
      activation: 'Wire a consumer that regenerates the proposal (and/or requests a fresh reconciliation evaluation) after the answer lands; until then the row records intent only (INV-8: non-dispatched). See the reconciliation fresh-evaluation slice.'
    }
  },
  'reconciliation.evaluation_requested': {
    channel: 'outbox',
    description: 'PR 1 (Trap-2): an upstream answer cleared a blocker on a still-unmatched bank line — ask for a FRESH strong-model re-match so the gap can actually close (not re-project the stale verdict). Emitted by the reconciliation wake (engine), inside the wake txn (INV-8); drained by the PR 1b consumer (NOT the dispatcher).',
    producedBy: ['loopRunEngine.runLoopWake'],
    // PR 1b: consumed by a DEDICATED outbox worker, not the dispatcher. The dispatcher
    // intentionally leaves this type 'pending' (DISPATCH_HANDLED_EVENT_TYPES excludes
    // it); reconciliationEvalConsumer claims + drains it, runs the scoped re-match
    // OUTSIDE any txn (INV-11), and honors firm/case suspension before spending tokens.
    consumer: { via: 'outbox_worker', worker: 'reconciliationEvalConsumer.js' }
  },
  'reconciliation.evaluation_completed': {
    channel: 'inbox',
    description: 'PR 1 (Trap-2): the fresh strong-model re-match persisted a new verdict — re-wake the reconciliation case to read it (INV-12). Produced by the PR 1b consumer; the reconciliation loop subscribes to it. NOT a cascade trigger, so the re-wake reads the fresh verdict and never re-requests.',
    producedBy: ['reconciliationEvalConsumer.runReconciliationEvalRequest'],
    consumer: { via: 'loop_wake', loops: ['reconciliation_gap_resolution'] }
  },
  'ask_draft.requested': {
    channel: 'outbox',
    description: 'Autonomous-loop demo (Slice 3): a reconciliation run completed for a client, so its open questions may have changed — request a FRESH strong-LLM (re)draft of the client ask-batch instead of waiting for a firm operator to click "draft". Enqueued on the post-reconcile seam, gated to canary+ and coalesced to one in-flight request per client; drained by the dedicated consumer (NOT the dispatcher), which runs the draft OUTSIDE any txn (INV-11) and re-gates per firm. The twin-aging clock (design 2026-07-06 §1) enqueues the SAME event from its daily sweep when aged ambiguous twins exist — same gate, same coalesce.',
    producedBy: [
      'loopsShadowProducers.onReconcileCompleteRequestAskDraft',
      'reconciliationTwinAging.sweepTwinAgingAskDraftRequests'
    ],
    // Consumed by a DEDICATED outbox worker, not the dispatcher (which leaves this type
    // 'pending', DISPATCH_HANDLED_EVENT_TYPES excludes it) — mirrors the PR-1b
    // reconciliation.evaluation_requested consumer.
    consumer: { via: 'outbox_worker', worker: 'askAutoDraftConsumer.js' }
  },

  'agent_answer.requested': {
    channel: 'outbox',
    description: 'Universal mentions slice 4: an @agent ASK was minted (audience agent — Donna-owed work, never a resting state), so request the runtime answer. Enqueued at mint (route → producer, canary+ proposal_creation, coalesced per ask); drained by the dedicated consumer (NOT the dispatcher), which re-gates per firm, authorizes at the compiled verb under the D7 composition (min of instructing seat and agent class), runs the strong-model answer OUTSIDE any txn (INV-11), then resolves the ask + posts the agent’s answer as an attributed comment — or ESCALATES back to the instructing seat (a dead-lettered request escalates too: the bound converts the agent ask to a human notification, never a parked hang).',
    producedBy: ['loopsShadowProducers.onAgentAskCreatedRequestAnswer'],
    consumer: { via: 'outbox_worker', worker: 'agentAskAnswerConsumer.js' }
  },

  // ── inbox (drained by the inbox worker) ────────────────────────────────────
  'client_reply.received': {
    channel: 'inbox',
    description: 'A client answered an evidence request — resume the parked evidence case (record the reply as evidence, clear the answer blocker).',
    producedBy: ['loopsShadowProducers.onClientReplyReceived'],
    consumer: { via: 'inbox_worker_special_case', handler: 'resumeFromClientReply' }
  },
  'dependency.resolved': {
    channel: 'inbox',
    description: 'An upstream case this case depends on resolved (the §6.2 cascade) — re-evaluate this case’s goal.',
    producedBy: ['loopOutboxDispatcher.handleCascade'],
    consumer: { via: 'loop_wake', loops: ['reconciliation_gap_resolution', 'coding_ask_batch_resolution'] }
  },
  'manual.resume': {
    channel: 'inbox',
    description: 'A reopened (regressed) or manually-resumed case — re-evaluate its goal.',
    producedBy: ['loopOutboxDispatcher.handleRegression'],
    consumer: { via: 'loop_wake', loops: ['reconciliation_gap_resolution', 'coding_ask_batch_resolution'] }
  },

  // ── S5 role events (specialist-roles doc §5; roles/roleEvents.js) ──────────
  // Typed role↔owner handoffs on the work-attribution shape (responsible_role ·
  // current_actor · next_commitment — INV-S8), receipted as audit_events rows
  // in the same transaction. The Team narration renders the RECEIPTS; these
  // queue rows exist so a future role-lane LoopDefinition can wake on handoffs.
  // NEVER a message: the closed event shape is machine-checked (roleEvents
  // validateRoleEvent) — cross-role awareness is persisted state + typed
  // events; no LLM-to-LLM channel exists (INV-S5).
  'role.handed_to_owner': {
    channel: 'inbox',
    description: 'Work in a hired role\'s lane came to rest ON THE OWNER: a send minted at (or moved to) hold_for_approval, or an exhausted dunning cadence escalated for the owner\'s call.',
    producedBy: ['roles/roleEvents.recordOutboundRoleTransition'],
    parked: {
      owner: 'The bench (specialist-roles S5+) — a role-lane LoopDefinition subscribes when that role grows its own loop.',
      monitoring: "select count(*) from loop_event_inbox where event_type like 'role.%' and status = 'pending' — the drain marks these 'ignored' (unhandled_event_type) while parked; a growing PENDING backlog with LOOPS_SHADOW on means the drain stopped, not that a consumer is missing.",
      activation: 'Add the type to a role LoopDefinition\'s triggerMatchers (the inbox worker then wakes that loop on handoffs). The Team narration reads the audit receipts either way and never drains this queue.'
    }
  },
  'role.resumed_from_owner': {
    channel: 'inbox',
    description: 'A held item left the owner\'s queue back into its role\'s lane: the owner approved (the send resumes) or declined, or Donna withdrew it (anchor settled). Carries the typed outcome.',
    producedBy: ['roles/roleEvents.recordOutboundRoleTransition'],
    parked: {
      owner: 'The bench (specialist-roles S5+) — a role-lane LoopDefinition subscribes when that role grows its own loop.',
      monitoring: "select count(*) from loop_event_inbox where event_type like 'role.%' and status = 'pending' — the drain marks these 'ignored' (unhandled_event_type) while parked; a growing PENDING backlog with LOOPS_SHADOW on means the drain stopped, not that a consumer is missing.",
      activation: 'Add the type to a role LoopDefinition\'s triggerMatchers (the inbox worker then wakes that loop on handoffs). The Team narration reads the audit receipts either way and never drains this queue.'
    }
  },

  // ── inbox triggers a LoopDefinition SUBSCRIBES to, but nothing PRODUCES as a
  //    queue event yet (consumer awaiting producer — harmless: the loop simply
  //    never fires on them today). Listed for a complete inventory + so the test
  //    asserts they are genuinely UNPRODUCED (not silently half-wired). The
  //    reconciliation matcher / parse path / sweep signal today via post-commit
  //    producer hooks + case-events, not by inserting these inbox rows. ──────────
  'reconciliation.run_completed': {
    channel: 'inbox',
    description: 'A reconciliation run finished for a target — re-evaluate the gap (7.1 forward hook).',
    producedBy: [],
    consumer: { via: 'loop_wake', loops: ['reconciliation_gap_resolution'] },
    subscribedNotYetProduced: true
  },
  'reconciliation.match_confirmed': {
    channel: 'inbox',
    description: 'A reconciliation match settled — re-evaluate / close the gap (7.0 close hook).',
    producedBy: [],
    consumer: { via: 'loop_wake', loops: ['reconciliation_gap_resolution'] },
    subscribedNotYetProduced: true
  },
  'document.parse_completed': {
    channel: 'inbox',
    description: 'An obligation may have just become evaluable now that its document parsed.',
    producedBy: [],
    consumer: { via: 'loop_wake', loops: ['reconciliation_gap_resolution'] },
    subscribedNotYetProduced: true
  },
  'schedule.recon_sweep': {
    channel: 'inbox',
    description: 'The reconciliation backfill scan, modeled as a scheduled inbox event (7.0 sweep).',
    producedBy: [],
    consumer: { via: 'loop_wake', loops: ['reconciliation_gap_resolution'] },
    subscribedNotYetProduced: true
  }
});

// ── selectors (pure) ─────────────────────────────────────────────────────────

export const registeredEventTypes = () => Object.keys(LOOP_EVENT_REGISTRY);

// An event is PRODUCED if some call site enqueues it (producedBy non-empty). The
// subscribedNotYetProduced entries are consumer subscriptions with no producer yet.
export const isProduced = (type) => (LOOP_EVENT_REGISTRY[type]?.producedBy?.length || 0) > 0;

export const isParked = (type) => Boolean(LOOP_EVENT_REGISTRY[type]?.parked);

export const parkedEventTypes = () => registeredEventTypes().filter(isParked);

export const eventTypesForChannel = (channel) =>
  registeredEventTypes().filter((t) => LOOP_EVENT_REGISTRY[t].channel === channel);
