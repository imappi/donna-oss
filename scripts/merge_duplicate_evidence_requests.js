// Merge duplicate ACTIVE evidence requests onto one canonical ask, preserving
// every already-issued Ref.
//
// The 2026-07-29 KUILI BARBACOA case: two 'open' asks for one physical receipt,
// Refs LC517QQK (10:02) and LCXS8D4P (11:20), because each upload minted its own
// document id and the old dedupe anchored on that. Migration 108 stops NEW
// duplicates and repairs anchors; this script is the operator-run twin for
// merging rows deliberately, one (firm, client) at a time, with a dry run first.
//
// WHAT IT DOES NOT DO: it never deletes a row and never touches a document. The
// uploads stay immutable artifacts. The losing ask is marked 'resolved' with
// merged_into pointing at the survivor, which is exactly what keeps its Ref
// resolving — __getOpenWhatsAppEvidenceRequestByRefWithClient follows the
// pointer, so an owner replying with the older Ref still lands on the live
// question.
//
// SURVIVOR RULE: the OLDEST active ask on an anchor wins. That is the Ref the
// owner saw first and the one most likely quoted in a reply. (Migration 103 keeps
// the NEWEST for ask BATCHES, because a draft supersedes; an ask is a question
// already put to a human, so the rule inverts here. Deliberate, not an
// inconsistency.)
//
// SAFETY: dry-run by DEFAULT; pass --apply to commit. Scoped to one client
// unless --all-clients is given.
//
// USAGE:
//   node scripts/merge_duplicate_evidence_requests.js --client honeybee-hills-apiary-llc
//   node scripts/merge_duplicate_evidence_requests.js --client <id> --apply
//   node scripts/merge_duplicate_evidence_requests.js --firm donna-production --all-clients

import { withFirmDbClient, DEFAULT_FIRM_ID } from '../server/donna/firmDb.js';
import { ACTIVE_ASK_STATUSES } from '../server/donna/askIdentity.js';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, firmId: null, clientId: null, allClients: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--all-clients') out.allClients = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure: group active asks into (survivor, losers) per anchor. Exported so the
// survivor rule is testable without a database.
export const planMerges = (rows = []) => {
  const groups = new Map();
  for (const row of rows) {
    if (!row?.canonical_anchor) continue;
    if (!ACTIVE_ASK_STATUSES.includes(String(row.status || ''))) continue;
    const key = [row.firm_id, row.client_id, row.canonical_anchor, row.blocker_code || '', row.generation ?? 0].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const plans = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => {
      const at = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return at !== 0 ? at : String(a.id).localeCompare(String(b.id));
    });
    plans.push({ survivor: ordered[0], losers: ordered.slice(1) });
  }
  return plans;
};

const shortRef = (id) => String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase();

const log = (...args) => console.log('[merge-duplicate-asks]', ...args);

const main = async () => {
  const opts = parseArgv();
  const firmId = opts.firmId || DEFAULT_FIRM_ID;
  if (!opts.clientId && !opts.allClients) {
    log('REFUSED: pass --client <id>, or --all-clients to sweep the whole firm.');
    process.exit(1);
    return;
  }
  await withFirmDbClient(async (client) => {
    const params = [firmId];
    let where = 'firm_id = $1';
    if (opts.clientId) { params.push(opts.clientId); where += ` and client_id = $${params.length}`; }
    const res = await client.query(
      `select id, firm_id, client_id, canonical_anchor, blocker_code, generation,
              status, created_at, question
         from client_evidence_requests
        where ${where} and status in ('draft', 'open', 'replied')
        order by created_at asc`,
      params
    );
    const plans = planMerges(res.rows || []);
    if (!plans.length) { log('no duplicate active asks found. Nothing to do.'); return; }

    for (const plan of plans) {
      log(`anchor ${plan.survivor.canonical_anchor} [${plan.survivor.blocker_code}] gen ${plan.survivor.generation ?? 0}`);
      log(`  KEEP  ${shortRef(plan.survivor.id)}  ${plan.survivor.created_at}  ${String(plan.survivor.question).slice(0, 80)}`);
      for (const loser of plan.losers) {
        log(`  MERGE ${shortRef(loser.id)}  ${loser.created_at}  -> ${shortRef(plan.survivor.id)} (Ref stays resolvable)`);
      }
    }
    if (!opts.apply) { log('DRY RUN — no write. Re-run with --apply to commit.'); return; }

    let merged = 0;
    for (const plan of plans) {
      for (const loser of plan.losers) {
        await client.query(
          `update client_evidence_requests
              set status = 'resolved',
                  merged_into = $2,
                  resolved_at = coalesce(resolved_at, now()),
                  resolved_by = coalesce(resolved_by, 'system:ask-identity-merge'),
                  request_payload = request_payload
                    || jsonb_build_object('merged_into', $2::text, 'merge_reason', 'duplicate_active_ask'),
                  updated_at = now()
            where id = $1 and firm_id = $3`,
          [loser.id, plan.survivor.id, firmId]
        );
        merged += 1;
      }
    }
    log(`APPLIED — ${merged} duplicate ask(s) merged. No row deleted, every Ref still resolves.`);
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
