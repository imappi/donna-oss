// G0.3 (build-spec PR-7) — the firm chat route DISCIPLINE, pinned at the
// source (the knowledgeRetrievalBoundary.test.js house pattern: direct,
// named assertions over the running tree's text, so a refactor that
// loosens the lane fails a test instead of shipping silently).
//
// What these pins hold, per the plan §5 G0 ground-truth audit:
//   1. SINGLE-ACTION ONLY — the firm surface exposes exactly three routes
//      (GET thread, POST message, apply ONE action by messageId + index);
//      no bulk/batch route is reachable.
//   2. MEMBERS ONLY — every firm route's assertFirmAccess carries
//      requireMember: true, so a client-scoped collaborator is refused at
//      the door (the exclusion that makes the surface safe today).
//   3. THE LATENT HAZARD IS CLOSED — the venture-universe read threads
//      assertFirmAccess's own allowedClientIds verdict into the SQL, so
//      the day a scoped principal IS admitted to firm scope, retrieval
//      cannot leak unassigned ventures.
//   4. ANTI-SELF-LICENSING APPLY — the apply venture comes from the
//      PERSISTED action (never the request body), 422s when absent, and
//      re-runs assertFirmAccess scoped to that venture.
//   5. RATE LIMIT + ANOMALY + SCOPE LOGGING — the message route carries
//      the FIRM_CHAT_RATE_LIMITED check and the firm_chat.rate_limited /
//      firm_chat.retrieval_scope / firm_chat.action_anomaly /
//      firm_chat.apply_anomaly audit emissions.
//
// Behavioral (live-PG) proof of the access checks themselves lives in
// feedChatFirmLeakagePg.test.js; these source pins hold the WIRING.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiSource = readFileSync(resolvePath(__dirname, 'api.js'), 'utf8');

// Every route-matching mention of the firm feed-chat path prefix in api.js.
// A new firm route (bulk apply, alternate verb) must show up here and fail
// the exact-set assertion until these pins are deliberately re-argued.
const routeMatchers = [
  ...apiSource.matchAll(/requestUrl\.pathname\s*(?:===\s*'([^']*feed-chat\/firm[^']*)'|\.match\((\/[^\n]*feed-chat\\\/firm[^\n]*\/)\))/g)
].map((match) => match[1] || match[2]);

// Slice of api.js from one anchor to the next route-matching statement —
// the route's handler block, coarse but stable.
const blockAfter = (anchor) => {
  const start = apiSource.indexOf(anchor);
  assert.ok(start >= 0, `route anchor not found: ${anchor}`);
  const rest = apiSource.slice(start + anchor.length);
  const next = rest.search(/requestUrl\.pathname\s*(===|\.match)/);
  return rest.slice(0, next === -1 ? undefined : next);
};

test('the firm surface exposes exactly three routes; the only apply is single-action (no bulk path)', () => {
  assert.deepEqual(
    routeMatchers.sort(),
    [
      '/^\\/feed-chat\\/firm\\/messages\\/([^/]+)\\/actions\\/(\\d+)\\/apply$/',
      '/feed-chat/firm',
      '/feed-chat/firm/messages'
    ].sort(),
    'firm feed-chat routes changed — re-argue the G0.3 single-action pins before widening this set'
  );
  // The apply matcher is anchored (^…$) and takes ONE numeric action index —
  // there is no array form and no apply-all shape anywhere in the source.
  assert.ok(!/feed-chat\/firm[^\n]*apply-all/.test(apiSource), 'no bulk apply route');
});

test('every firm route requires firm membership (collaborators refused at the door)', () => {
  const getBlock = blockAfter("requestUrl.pathname === '/feed-chat/firm' && req.method === 'GET'");
  const postBlock = blockAfter("requestUrl.pathname === '/feed-chat/firm/messages' && req.method === 'POST'");
  const applyBlock = blockAfter('if (firmFeedChatApplyMatch && req.method');
  for (const [name, block] of [['GET thread', getBlock], ['POST message', postBlock], ['apply', applyBlock]]) {
    assert.match(
      block,
      /assertFirmAccess\(\{[^}]*requireMember:\s*true/,
      `${name} route must pass requireMember: true`
    );
  }
});

test('the venture-universe read threads allowedClientIds (the latent hazard stays closed)', () => {
  const postBlock = blockAfter("requestUrl.pathname === '/feed-chat/firm/messages' && req.method === 'POST'");
  assert.match(
    postBlock,
    /listFirmChatVentureUniverseInDb\(\{[\s\S]*?allowedClientIds:\s*access\.allowedClientIds[\s\S]*?\}\)/,
    'the universe read must scope by assertFirmAccess\'s own allowedClientIds verdict'
  );
  // And no inline unfiltered clients query remains on this route.
  assert.ok(
    !/select id, company_name from clients/.test(postBlock),
    'the raw universe query must live in the firmDb helper, not inline on the route'
  );
});

test('the apply venture comes from the persisted action, 422s when absent, and is re-checked', () => {
  const applyBlock = blockAfter('if (firmFeedChatApplyMatch && req.method');
  assert.match(applyBlock, /rawAction\?\.client_id/, 'venture read from the PERSISTED action');
  assert.ok(!/body\?\.client_id/.test(applyBlock), 'the request body can never name the venture (anti-self-licensing)');
  assert.match(applyBlock, /statusCode = 422/, 'an action with no client_id is refused');
  assert.match(
    applyBlock,
    /assertFirmAccess\(\{[\s\S]*?clientIds:\s*collectClientIds\(applyClientId\)/,
    'the apply re-runs assertFirmAccess scoped to the action\'s own venture'
  );
});

test('rate limit + retrieval-scope + anomaly logging are wired on the firm lane (G0.3)', () => {
  const postBlock = blockAfter("requestUrl.pathname === '/feed-chat/firm/messages' && req.method === 'POST'");
  assert.match(postBlock, /FIRM_CHAT_RATE_LIMITED/, '429 rate-limit refusal');
  assert.match(postBlock, /countRecentFirmChatUserMessagesInDb/, 'DB-count rolling window');
  assert.match(postBlock, /'firm_chat\.rate_limited'/, 'rate-limit trips are audited');
  assert.match(postBlock, /'firm_chat\.retrieval_scope'/, 'every mint audits which ventures it read');
  assert.match(postBlock, /'firm_chat\.action_anomaly'/, 'sanitizer drops are audited');
  const applyBlock = blockAfter('if (firmFeedChatApplyMatch && req.method');
  assert.match(applyBlock, /'firm_chat\.apply_anomaly'/, 'apply scope refusals are audited');
  assert.match(applyBlock, /venture_access_refused/, 'the 403 leakage event is the named anomaly');
});
