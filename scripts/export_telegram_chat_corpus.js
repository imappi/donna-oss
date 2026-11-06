#!/usr/bin/env node
// Telegram owner-chat corpus extractor — Slice 1 of the chat-quality arc.
//
// READ-ONLY. Pulls real owner<->Donna turns out of `client_chat_messages`
// (migration 056), pairs them user->assistant, and attaches the provenance a
// quality diagnosis needs but a screenshot does not carry:
//
//   * the MODEL ID that produced each reply (the `model` column — CLAUDE.md's
//     "the model id is part of the receipt" rail; never read it off code
//     defaults, a prod env var silently overrides them),
//   * the LANE that handled the turn (message_delivery_ledger's
//     provider_payload->'inbound'->>'anchor' — inboundCore.js tries five
//     handlers in order and the first to claim the turn wins, so a reply that
//     reads "verbally wrong" is often the wrong lane, not a bad answer),
//   * whether the turn went through the SECOND model call (report narration),
//     which fails independently of the chat call,
//   * whether the turn produced NO assistant row at all — the fingerprint of
//     the `general_chat_unavailable` path, which is a transport/config bug and
//     NOT a bad answer. Counting these before labelling is the difference
//     between diagnosing and guessing.
//
// The output is a labelling sheet, not a verdict. Donna's four failure causes
// (model / prompt / context / capability) are indistinguishable from reply text
// alone, so the `cause` field is left blank for a human to fill in.
//
// Usage (needs DATABASE_URL / POSTGRES_URL, same as every other script here):
//   node scripts/export_telegram_chat_corpus.js --firm <firmId>
//   node scripts/export_telegram_chat_corpus.js --client <client-id> --days 30
//   node scripts/export_telegram_chat_corpus.js --out data/evals/corpus/telegram
//
//   --firm     firm id (default: firmDb DEFAULT_FIRM_ID)
//   --client   restrict to one client id (default: every client in the firm)
//   --days     lookback window in days (default 30)
//   --limit    max turns (default 200, max 2000)
//   --all      include non-telegram threads too (default: telegram only)
//   --out      directory for corpus.json + labelling-sheet.md (default: stdout summary only)

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import { queryFirmDb, isFirmDatabaseConfigured, DEFAULT_FIRM_ID } from '../server/donna/firmDb.js';

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
};

// The five lanes inboundCore.js tries, in order. A turn's anchor tells you
// WHICH one claimed it; `general_owner_chat` is the only one that runs the LLM
// answer. Anything else answering a general question is a ROUTING defect, not a
// wording one.
export const LANES = Object.freeze({
  invoice_issuance_intent: 'lane1_invoice_issuance',
  owner_invoice_command: 'lane2_owner_invoice',
  einvoice_inbound: 'lane3_einvoice_media',
  owner_initiated_media: 'lane4_owner_media',
  general_owner_chat: 'lane5_general_chat'
});

// A ledger row with no `anchor` came from the anchored-ask reply path (the main
// body of processAnchoredInboundMessage), which answers a specific evidence
// request rather than chatting.
export const laneForAnchor = (anchor) => {
  if (!anchor) return 'anchored_ask_reply';
  return LANES[anchor] || `unknown:${anchor}`;
};

// Classify what actually happened on the assistant side. This is deliberately
// derived from PERSISTED receipt fields only — never from reply prose.
export const classifyTurn = ({ userRow, assistantRow, ledger }) => {
  if (!assistantRow) {
    // The user row is written BEFORE the model call; the unavailable path
    // returns without persisting an assistant row. So an orphan user turn means
    // the chat call, the report read, or the narration call failed. The reason
    // code is NOT persisted anywhere today (see the Slice 0 report), so this is
    // as far as the DB can take you: correlate with function logs by timestamp.
    return { outcome: 'no_assistant_row', detail: 'general_chat_unavailable or nudged (reason not persisted)' };
  }
  const payload = assistantRow.payload && typeof assistantRow.payload === 'object' ? assistantRow.payload : {};
  if (payload.memory_status === 'blocked') {
    return { outcome: 'memory_short_circuit', detail: 'ownerMemory.shortCircuit fired; no model call was made' };
  }
  if (payload.report_request) {
    // Two model calls happened: the chat call emitted request_report, then
    // generateClientPortalReportNarration produced the text that was actually
    // sent. The `model` column holds the NARRATION call's id. A bad answer here
    // may be either call.
    return { outcome: 'report_narration', detail: 'text produced by the second (narration) model call' };
  }
  if (payload.applied_action) {
    return { outcome: 'action_applied', detail: `applied ${payload.applied_action?.type || 'unknown'}` };
  }
  if (ledger && ledger.action_applied === true) {
    return { outcome: 'action_applied', detail: 'ledger recorded an applied action' };
  }
  return { outcome: 'plain_answer', detail: 'single chat model call, no action, no report' };
};

const truncate = (value, max = 4000) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
};

// Pairs a thread's rows into turns: each user row plus the first assistant (or
// system) row that follows it, before the next user row. A user row with
// nothing following it is an orphan — see classifyTurn.
export const pairThreadTurns = (rows = []) => {
  const turns = [];
  const ordered = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (let i = 0; i < ordered.length; i += 1) {
    const row = ordered[i];
    if (row.role !== 'user') continue;
    let assistantRow = null;
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (ordered[j].role === 'user') break;
      if (ordered[j].role === 'assistant') { assistantRow = ordered[j]; break; }
    }
    turns.push({ userRow: row, assistantRow });
  }
  return turns;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!isFirmDatabaseConfigured()) {
    console.error('Firm database is not configured. Set DATABASE_URL (or POSTGRES_URL) and re-run.');
    process.exit(1);
  }
  const firmId = typeof args.firm === 'string' ? args.firm : DEFAULT_FIRM_ID;
  const clientId = typeof args.client === 'string' ? args.client : null;
  const days = Math.min(Math.max(Number(args.days) || 30, 1), 3650);
  const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 2000);
  const telegramOnly = args.all !== true;

  const params = [firmId, `${days} days`];
  let where = 'cm.firm_id = $1 and cm.created_at >= now() - $2::interval';
  if (clientId) { params.push(clientId); where += ` and cm.client_id = $${params.length}`; }

  // The assistant row carries no channel of its own; the USER row does
  // (payload.channel, written by maybeAnswerGeneralOwnerChat), and the delivery
  // ledger carries one too. Join the ledger by assistant_message_id — the only
  // link between a chat row and the lane that produced it.
  const sql = `
    select
      cm.id, cm.client_id, cm.role, cm.content, cm.payload, cm.model,
      cm.model_version, cm.actor_type, cm.created_at,
      mdl.channel                                     as ledger_channel,
      mdl.message_id                                  as inbound_message_id,
      mdl.provider_payload->'inbound'->>'anchor'      as ledger_anchor,
      mdl.provider_payload->'inbound'->>'action_applied' as ledger_action_applied
    from client_chat_messages cm
    left join message_delivery_ledger mdl
      on mdl.provider_payload->'inbound'->>'assistant_message_id' = cm.id
    where ${where}
    order by cm.client_id, cm.created_at
  `;

  const result = await queryFirmDb(sql, params);
  const rows = result.rows || [];

  const byClient = new Map();
  for (const row of rows) {
    if (!byClient.has(row.client_id)) byClient.set(row.client_id, []);
    byClient.get(row.client_id).push(row);
  }

  const turns = [];
  for (const [client, clientRows] of byClient) {
    for (const { userRow, assistantRow } of pairThreadTurns(clientRows)) {
      const userPayload = userRow.payload && typeof userRow.payload === 'object' ? userRow.payload : {};
      const channel = userPayload.channel || assistantRow?.ledger_channel || null;
      if (telegramOnly && channel !== 'telegram') continue;
      const ledger = assistantRow
        ? { anchor: assistantRow.ledger_anchor, action_applied: assistantRow.ledger_action_applied === 'true' }
        : null;
      const classification = classifyTurn({ userRow, assistantRow, ledger });
      turns.push({
        id: userRow.id,
        client_id: client,
        channel,
        asked_at: userRow.created_at,
        answered_at: assistantRow?.created_at || null,
        prompt: truncate(userRow.content),
        answer: assistantRow ? truncate(assistantRow.content) : null,
        // Provenance — read the model off the DATA, never off code defaults.
        model: assistantRow?.model || null,
        model_version: assistantRow?.model_version || null,
        lane: assistantRow?.ledger_anchor !== undefined && assistantRow?.ledger_anchor !== null
          ? laneForAnchor(assistantRow.ledger_anchor)
          : (assistantRow ? 'no_ledger_row' : 'no_ledger_row'),
        outcome: classification.outcome,
        outcome_detail: classification.detail,
        actions: assistantRow?.payload?.actions || [],
        self_knowledge_version: assistantRow?.payload?.self_knowledge?.self_knowledge_version || null,
        // Filled in by a human. The four causes are indistinguishable from
        // reply text alone, which is why this ships blank.
        label: { verdict: '', cause: '', note: '' }
      });
    }
  }

  const capped = turns.slice(-limit);
  const distribution = capped.reduce((acc, turn) => {
    acc.byOutcome[turn.outcome] = (acc.byOutcome[turn.outcome] || 0) + 1;
    acc.byLane[turn.lane] = (acc.byLane[turn.lane] || 0) + 1;
    acc.byModel[turn.model || '(none)'] = (acc.byModel[turn.model || '(none)'] || 0) + 1;
    return acc;
  }, { byOutcome: {}, byLane: {}, byModel: {} });

  const corpus = {
    suite: 'telegram_chat',
    firm_id: firmId,
    client_id: clientId,
    lookback_days: days,
    telegram_only: telegramOnly,
    total_turns: capped.length,
    distribution,
    turns: capped
  };

  console.log(`turns: ${capped.length}  (firm=${firmId}${clientId ? `, client=${clientId}` : ''}, last ${days}d)`);
  console.log('\nby model id (READ THIS FIRST — a prod env var silently overrides code defaults):');
  for (const [model, count] of Object.entries(distribution.byModel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)}  ${model}`);
  }
  console.log('\nby lane (a wrong lane is a routing defect, not a wording one):');
  for (const [lane, count] of Object.entries(distribution.byLane).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)}  ${lane}`);
  }
  console.log('\nby outcome (no_assistant_row = the unavailable path, NOT a bad answer):');
  for (const [outcome, count] of Object.entries(distribution.byOutcome).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)}  ${outcome}`);
  }

  if (typeof args.out === 'string') {
    const outDir = resolvePath(process.cwd(), args.out);
    mkdirSync(outDir, { recursive: true });
    const jsonPath = joinPath(outDir, 'corpus.json');
    writeFileSync(jsonPath, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');

    const sheet = [
      '# Telegram owner-chat — labelling sheet',
      '',
      `firm: \`${firmId}\`${clientId ? ` · client: \`${clientId}\`` : ''} · last ${days} days · ${capped.length} turns`,
      '',
      'For each turn below, fill in **verdict** (ok / bad) and, when bad, **cause** —',
      'one of:',
      '',
      '- `model` — the reply came from a weaker model than intended',
      '- `prompt` — the model was never told the thing it got wrong',
      '- `context` — the model was told, but the fact was not in the assembled context',
      '- `capability` — the model correctly said it cannot do the thing; the action genuinely does not exist',
      '- `routing` — an earlier lane claimed a turn that belonged to the general chat',
      '- `transport` — no assistant row: the unavailable path fired, not a bad answer',
      '',
      '---',
      ''
    ];
    for (const turn of capped) {
      sheet.push(`## ${turn.id}`);
      sheet.push('');
      sheet.push(`- model: \`${turn.model || '(none)'}\` · lane: \`${turn.lane}\` · outcome: \`${turn.outcome}\``);
      sheet.push(`- ${turn.outcome_detail}`);
      sheet.push('');
      sheet.push('**Owner:**');
      sheet.push('');
      sheet.push('> ' + String(turn.prompt).split('\n').join('\n> '));
      sheet.push('');
      sheet.push('**Donna:**');
      sheet.push('');
      sheet.push(turn.answer ? '> ' + String(turn.answer).split('\n').join('\n> ') : '_(no assistant row persisted)_');
      sheet.push('');
      sheet.push('verdict: `` · cause: `` · note:');
      sheet.push('');
      sheet.push('---');
      sheet.push('');
    }
    const sheetPath = joinPath(outDir, 'labelling-sheet.md');
    writeFileSync(sheetPath, `${sheet.join('\n')}\n`, 'utf8');
    console.log(`\nwrote ${jsonPath}`);
    console.log(`wrote ${sheetPath}`);
  }
};

const isDirectRun = process.argv[1] && process.argv[1].endsWith('export_telegram_chat_corpus.js');
if (isDirectRun) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
