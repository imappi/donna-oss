import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(new URL('../components/financials/artifact-panel.jsx', import.meta.url), 'utf8');
const artifactSource = readFileSync(new URL('../components/financials/transaction-artifact.jsx', import.meta.url), 'utf8');
const auditSource = readFileSync(new URL('../components/financials/transaction-audit-timeline.jsx', import.meta.url), 'utf8');
const localeFormattingSource = readFileSync(new URL('../i18n/localeFormatting.js', import.meta.url), 'utf8');
const catalogSource = readFileSync(new URL('../i18n/catalogs/en.js', import.meta.url), 'utf8');
const remainingCatalogSource = readFileSync(new URL('../i18n/catalogs/remainingSurfaces.en.js', import.meta.url), 'utf8');
const consoleSource = readFileSync(new URL('../components/FirmOpsConsole.jsx', import.meta.url), 'utf8');
const dockSource = readFileSync(new URL('../components/firm-dock.jsx', import.meta.url), 'utf8');

test('an artifact with its own chat owns the rail; a chat-less artifact shares it with the dock', () => {
  // Pin updated DELIBERATELY 2026-08-26 (Kari's stage-C canary finding:
  // "no chat input in the artifact — it's supposed to be the one and only
  // work surface with chat at the bottom"). Document/transaction artifacts
  // carry their own item chat and still hide the dock; every other type
  // stacks the dock beneath it — never a chat-less panel.
  assert.match(panelSource, /const ARTIFACT_TYPES_WITH_OWN_CHAT = new Set\(\['document', 'transaction'\]\);/);
  assert.match(panelSource, /const showDock = dockOpen && !!dock\n\s*&& \(!artifact \|\| !ARTIFACT_TYPES_WITH_OWN_CHAT\.has\(artifact\.type\)\);/);
  // The collapsed-dock pill follows the same law, so chat stays reachable
  // beneath a chat-less artifact (both mounted render sites).
  assert.match(consoleSource, /const dockCanShare = !artifact \|\| !ARTIFACT_TYPES_WITH_OWN_CHAT\.has\(artifact\.type\);/);
  assert.equal(consoleSource.match(/\{dockCanShare && dockPill\}/g)?.length, 2);
});

test('Donna and item artifacts share the responsive rail width and resize handle', () => {
  assert.match(panelSource, /const \[artifactWidth, setArtifactWidth\] = useState\(computeDefaultArtifactWidth\)/);
  assert.match(panelSource, /const railWidth = artifactWidth/);
  assert.doesNotMatch(panelSource, /DOCK_ONLY_WIDTH|dock's fixed width/);
  assert.match(panelSource, /\{railOpen && \(/);
  assert.match(panelSource, /data-artifact-resize-handle="true"/);
  assert.match(panelSource, /setArtifactWidth\(Math\.max\(360, Math\.min\(width/);
});

test('the contextual panel uses the split-panel control to hide the artifact', () => {
  assert.match(panelSource, /<ArtifactToggleIcon \/>/);
  assert.match(panelSource, /aria-label=\{message\('artifact\.hide'\)\}/);
  assert.match(panelSource, /onClick=\{\(\) => setArtifact\(null\)\}/);
  assert.doesNotMatch(panelSource, /PanelSizeIcon|isExpanded|computeExpandedArtifactWidth|aria-label="Close panel"|>\s*×\s*</);
  assert.match(panelSource, /event\.key !== 'Escape'/);
});

test('the mounted firm-wide Donna path contains one FirmDock and one FeedChat', () => {
  assert.equal(consoleSource.match(/<FirmDock\s/g)?.length, 1);
  assert.equal(dockSource.match(/<FeedChat\s/g)?.length, 1);
  assert.match(consoleSource, /<ArtifactPanel[^>]*dock=\{dockNode\} dockOpen=\{dockOpen\}/);
  assert.doesNotMatch(consoleSource, /<FeedChat\s/);
});

test('transaction-artifact Apply publishes every target into the mounted feed lifecycle', () => {
  assert.match(consoleSource, /const emitFeedApplyLifecycle = useCallback/);
  // The report canvas is a fourth mounted console branch. It keeps the same
  // Donna dock alive beside the report, so its lifecycle bridge is required
  // on the same footing as Home and the venture workspaces.
  assert.equal(consoleSource.match(/onApplyLifecycle=\{emitFeedApplyLifecycle\}/g)?.length, 4);
  assert.match(panelSource, /onApplyLifecycle=\{onApplyLifecycle\}/);
  assert.match(artifactSource, /transactionChatActionTargetIds\(\{/);
  assert.match(artifactSource, /onApplyLifecycle\?\.\(\{ phase: 'start', transactionIds \}\)/);
  assert.equal(
    artifactSource.match(/phase: 'settle'/g)?.length,
    3,
    'preview, production success, and production failure all settle the row pulse'
  );
});

test('suggested transactions no longer advertise an impossible posting sequence', () => {
  assert.doesNotMatch(artifactSource, /Accept this line first to post it/);
  assert.match(artifactSource, /if \(!posted && !postable && postState\.status !== 'error'\) return null/);
  assert.match(artifactSource, /onClick=\{handleSendToXero\}/);
  assert.match(artifactSource, /reviewState === 'accepted' \|\| reviewState === 'resolved'/);
});

test('matched artifacts have one document-review path and one calm summary', () => {
  assert.match(artifactSource, /transaction\.action\.openDocument/);
  assert.match(remainingCatalogSource, /'transaction\.action\.openDocument': 'Open document'/);
  assert.doesNotMatch(artifactSource, /Review document details/);
  assert.doesNotMatch(artifactSource, /label: 'Review document'/);
  assert.doesNotMatch(artifactSource, />\s*Explain the match\s*</);
  assert.match(artifactSource, /transaction\.match\.signals/);
  assert.match(artifactSource, /!isMeaningfulMatch\(match\) && \([\s\S]*<MetaBar/);
  assert.doesNotMatch(artifactSource, /explanation\?\.categoryReason/, 'the matched summary is not repeated in conversation');
});

test('a meaningful match always renders its hero — an unresolvable doc object degrades, never blanks', () => {
  // The land-lease dead zone (2026-08-16): `match && matchedDocument` gated
  // the hero AND the MetaBar branch requires !meaningful, so a meaningful
  // match with an unresolvable doc rendered NOTHING above the audit trail —
  // a reconciled line presenting as evidence-free. The hero now gates on the
  // match alone and says plainly when the file object isn't loadable.
  assert.doesNotMatch(artifactSource, /isMeaningfulMatch\(match\) && matchedDocument &&/);
  assert.match(artifactSource, /\{isMeaningfulMatch\(match\) && \(\s*<MatchHero/);
  assert.match(artifactSource, /if \(!isMeaningfulMatch\(match\)\) return null;/);
  assert.match(artifactSource, /transaction\.match\.fileUnavailable/);
  assert.match(artifactSource, /transaction\.match\.documentOnFile/);
  assert.match(catalogSource, /The matched file isn’t loadable in this view/);
  assert.match(catalogSource, /Matched document on file/);
});

test('the contextual composer remains while its stale disclaimer is gone', () => {
  assert.match(artifactSource, /transaction\.composer\.donnaPlaceholder/);
  assert.match(remainingCatalogSource, /Ask about this transaction — Cmd\/Ctrl\+Enter to send/);
  assert.doesNotMatch(artifactSource, /Donna proposes; you review and apply/);
  assert.match(artifactSource, /fontFamily: D\.ui/);
});

test('summary, live activity, and conversation are one flow with no Chat/Audit switch', () => {
  assert.doesNotMatch(artifactSource, /SegmentedControl|artifactView|label: 'Audit'/);
  assert.match(artifactSource, /<MatchHero[\s\S]*<TransactionAuditTimeline[\s\S]*<Composer/);
  assert.match(auditSource, /data-testid="transaction-live-audit"/);
  assert.match(auditSource, /transaction-audit-shimmer/);
  assert.match(auditSource, /activity \? ACTIVE_POLL_MS : IDLE_POLL_MS/);
  assert.match(auditSource, /transaction\.audit\.title/);
  assert.match(auditSource, /view\.actorLabel/);
  assert.match(localeFormattingSource, /field\('second', '2-digit'\)/);
  assert.match(localeFormattingSource, /field\('timeZoneName', 'short'\)/);
  assert.match(auditSource, /transaction\.audit\.gaps/);
  assert.doesNotMatch(auditSource, /visibleTimelineEvents|COLLAPSED_EVENT_COUNT|earlier step/);
  assert.match(artifactSource, /initialThreadPaintedRef/, 'opening a case stays at the summary instead of jumping to chat');
});

test('the complete audit makes absent receipt timing explicit', () => {
  assert.match(auditSource, /state\.view\.events/);
  assert.match(auditSource, /transaction\.audit\.timestampMissing/);
});

test('match decisions begin beside the composer and rejection stays conversational', () => {
  assert.match(artifactSource, /transaction\.action\.reject/);
  assert.match(artifactSource, /transaction\.reject\.title/);
  assert.match(artifactSource, /MATCH_REJECTION_CHOICES\.map/);
  assert.match(artifactSource, /transaction\.reject\.notApplied/);
  assert.match(remainingCatalogSource, /'transaction\.action\.reject': 'Reject this match…'/);
  assert.match(remainingCatalogSource, /'transaction\.reject\.title': 'What’s wrong with this match\?'/);
  assert.match(remainingCatalogSource, /Nothing is rejected until you apply Donna’s proposed correction/);
  assert.match(artifactSource, /starters=\{\(/);
  assert.doesNotMatch(artifactSource, /data\.onRejectMatch|RejectMatchButton/);
});
