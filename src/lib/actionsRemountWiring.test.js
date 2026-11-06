import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BANK_FEED_AMOUNT_STYLE,
  BANK_FEED_DATE_STYLE,
  BANK_FEED_PRIMARY_STYLE,
  BANK_FEED_SECTION_STYLE,
  BANK_FEED_STATUS_STYLE
} from '../components/shared/bank-feed-list-style.js';

const panelSource = readFileSync(new URL('../components/financials/ask-batch-panel.jsx', import.meta.url), 'utf8');
const consoleSource = readFileSync(new URL('../components/FirmOpsConsole.jsx', import.meta.url), 'utf8');
const mockActionsSource = readFileSync(new URL('../components/donna-actions-panel.jsx', import.meta.url), 'utf8');
const feedListSource = readFileSync(new URL('../components/shared/feed-list.jsx', import.meta.url), 'utf8');
const ownerInventorySource = readFileSync(new URL('../components/shared/entity-owner-inventory.js', import.meta.url), 'utf8');
const financialsSource = readFileSync(new URL('../components/financials/donna-financials-panel.jsx', import.meta.url), 'utf8');

test('Actions remounts from the console-owned successful ask snapshot', () => {
  assert.match(consoleSource, /askBatchesByClient/);
  assert.match(consoleSource, /cachedBatches=/);
  assert.match(consoleSource, /onCacheBatches=/);
  assert.match(panelSource, /useState\(\(\) => \(\{\s*clientId,\s*batches: cachedBatches/s);
  assert.match(panelSource, /onCacheBatches\?\.\(clientId, nextBatches\)/);
});

test('leaving the overview fences its old request before remount reloads the cached snapshot', () => {
  // Cancellation is intentional: providerFailureSurface.test.js mounts the
  // actual console through overview → another tab → overview and proves
  // fresh results load while an abandoned request cannot overwrite them.
  assert.match(panelSource, /loadRevisionRef\.current \+= 1/);
  assert.match(panelSource, /if \(revision !== loadRevisionRef\.current\) return/);
  assert.match(panelSource, /setBatchState\(\{ clientId, batches: cachedBatches, providerFailures: null \}\);[\s\S]*?load\(\)/);
});

test('Actions counts actual firm tasks instead of every confirmable Bank Feed line', () => {
  assert.match(feedListSource, /from '.\/entity-owner-inventory\.js'/);
  assert.match(ownerInventorySource, /confirmable:\s*'donna'/);
  assert.match(ownerInventorySource, /draftCoveredTransactionIds/);
  assert.doesNotMatch(panelSource, /entityRows\.confirmable\.length/);
  assert.doesNotMatch(panelSource, /bucketRows\('confirmable'\)/);
  assert.match(panelSource, /key === 'operator_blocker' && isPeriodOwnedDecision\(item\)/);
  assert.match(consoleSource, /periodOwnerDecisions=\{selectedPeriodOwnerDecisions\}/);
});

test('Waiting on client renders each persisted open request instead of an opaque summary', () => {
  assert.match(panelSource, /openClientEvidenceRequests\(evidenceRequests\)/);
  assert.match(panelSource, /const waitingRows = useMemo\(\(\) => \[/);
  assert.match(panelSource, /requestFeedItemById\.get\(request\.id\) \|\| evidenceRequestListItem/);
  assert.match(panelSource, /\{waitingRows\.map\(\(item\) => \(/);
  assert.match(panelSource, /bankFeedPillStyle\('muted'\)\}>Awaiting reply/);
  assert.match(panelSource, /onActivate=\{\(\) => activateRow\(item\)\}/);
  assert.match(panelSource, /onOpen=\{\(\) => activateRow\(item\)\}/);
  assert.match(consoleSource, /onActivateItem=\{handleHomeFeedActivate\}/);
  assert.match(consoleSource, /onArtifact=\{setArtifact\}/);
  assert.doesNotMatch(panelSource, /RecordAnswerCard|Record client's answer|<textarea/);
  assert.doesNotMatch(panelSource, /Client questions|showClientAsks|waitingBatches|Review waiting client asks/);
});

test('the embedded overview omits empty Actions chrome', () => {
  assert.match(consoleSource, /<AskBatchPanel[\s\S]*embedded/);
  assert.match(consoleSource, /<DonnaActionsPanel[\s\S]*embedded/);
  assert.match(panelSource, /!embedded && decisionCount === 0 && waitingCount === 0/);
  assert.match(panelSource, /!embedded && batches !== null && decisionCount === 0 && waitingCount === 0/);
  assert.match(mockActionsSource, /if \(embedded && !hasSent && recentUploadBatches\.length === 0\) return null/);
});

test('Actions inherits Bank Feed typography and stacked-section rhythm exactly', () => {
  assert.equal(BANK_FEED_PRIMARY_STYLE.fontSize, 13);
  assert.equal(BANK_FEED_AMOUNT_STYLE.fontSize, 13.5);
  assert.equal(BANK_FEED_DATE_STYLE.fontSize, 12.5);
  assert.equal(BANK_FEED_STATUS_STYLE.fontSize, 12.5);
  assert.equal(BANK_FEED_PRIMARY_STYLE.lineHeight, 'normal');
  assert.deepEqual(BANK_FEED_SECTION_STYLE, { padding: '0 0 24px' });
  // 2 = Mentions (universal @mentions slice 4) · Waiting on client — the
  // item-level lanes use the SAME stacked-section grammar, which is what
  // this pin exists to force. "Needs your decision" is no longer a section:
  // the draft and the venture-wide decisions are plain rows (Kari,
  // 2026-09-01), wrapped only in the section SPACING div below.
  assert.equal(panelSource.match(/<section style=\{BANK_FEED_SECTION_STYLE\}>/g)?.length, 2);
  assert.equal(panelSource.match(/<div style=\{BANK_FEED_SECTION_STYLE\}>/g)?.length, 1);
  assert.equal(financialsSource.match(/<div style=\{BANK_FEED_SECTION_STYLE\}>/g)?.length, 2);
});

test('the drafted client message has no entity-view row — the Inbox owns its review', () => {
  // Kari, 2026-09-01, second call: the draft row was noise in the entity
  // list — every question in the draft is already a per-item Needs-input
  // row in the month stream, and cross-month/cross-entity review is what
  // the Inbox is for. The entity view renders NO draft row, buttons,
  // headings, or banners for it.
  assert.doesNotMatch(panelSource, /Review client message/);
  assert.doesNotMatch(panelSource, /draftRow|draftCoveredSpan|openDraftArtifact/);
  assert.doesNotMatch(panelSource, /askBatchCoveredSpanLabel|askBatchCountsLabel/);
  assert.doesNotMatch(panelSource, /label="Needs your decision"/);
  assert.doesNotMatch(panelSource, /Send to client/);
  assert.doesNotMatch(panelSource, /Verdicts have moved/);
  // Venture-wide blockers still render as plain rows with the shared pill.
  assert.match(panelSource, /bankFeedPillStyle\('warm'\)\}>Needs input/);
  // The artifact owns message/audit/send, self-loads, and writes what it
  // learns back through onBatchesChanged. Its date language carries the
  // covered ledger months, never the drafted-at wall clock (2026-09-01:
  // auto-refresh makes created_at always "today").
  const artifactSource = readFileSync(new URL('../components/financials/ask-batch-artifact.jsx', import.meta.url), 'utf8');
  assert.match(artifactSource, /sendFirmAskBatch/);
  assert.match(artifactSource, /onBatchesChanged\?\.\(clientId, nextBatches\)/);
  assert.match(artifactSource, /ASK_PIPELINE_LLM_UNAVAILABLE/);
  assert.match(artifactSource, /askBatchCoveredSpanLabel/);
  const artifactPanelSource = readFileSync(new URL('../components/financials/artifact-panel.jsx', import.meta.url), 'utf8');
  assert.match(artifactPanelSource, /visible\.type === 'ask_batch' && visible\.data && \(/);
  // The Inbox's server-minted ask_batch_draft item routes to that SAME
  // artifact — the draft's one review surface, never orphaned (two
  // terminal states: the ask stays on the owner, reachable).
  assert.match(consoleSource, /kind === 'ask_batch_draft'[\s\S]*?type: 'ask_batch'/);
});

test('a stale draft heals itself — Donna refreshes it, once per verdict stamp', () => {
  // The old "Refresh it before sending" banner was a firm-side chore
  // (two-terminal-states: a stale draft resting on a manual click). The
  // panel auto-refreshes; the artifact keeps the honest fallback note.
  assert.match(panelSource, /autoRefreshAttemptsRef/);
  assert.match(panelSource, /staleness\.latestMovementMs/);
  assert.match(panelSource, /draftFirmAskBatch\(\{ clientId \}\)/);
});

test('decision rows share the bank-feed marker edge and trailing pill grammar', () => {
  assert.match(panelSource, /maxWidth: BANK_FEED_LIST_MEASURE/);
  assert.match(feedListSource, /justifySelf: bankFeedLayout \? 'auto' : 'center'/);
  assert.match(feedListSource, /bankFeedPillStyle\(blocks \? 'warm' : 'muted'\)/);
  assert.match(feedListSource, /\.\.\.BANK_FEED_TRAILING_CELL_STYLE,[\s\S]*?justifyContent: 'flex-end'/);
});
