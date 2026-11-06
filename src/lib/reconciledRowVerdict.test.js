// The bank-feed row builders render the persisted coding verdict, not the
// parse-time fossil — the render-the-persisted-verdict rail, pinned at the
// source level because the builders live inside the panel JSX.
//
// The coder's verdict may sit under any of the three ai_suggestion keys —
// proposed_account (the coding batch), account_name / account_code (accept
// and post patches). Every server-side reader resolves that triple
// (caseTimeline.fromAiSuggestion, codingAutoPost); a surface reading only
// one key falls through to the parse-time `category` fossil and renders a
// coded line as 'Suspense'. Sighting: the land-lease line (2026-08-16) —
// audit trail said "Coded to Rent", the Reconciled-tab pill said "Suspense".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(
  new URL('../components/financials/donna-financials-panel.jsx', import.meta.url),
  'utf8'
);

test('one shared resolver reads the coding-verdict triple', () => {
  assert.match(
    panelSource,
    /const aiSuggestionAccount = \(suggestion\) =>\s*\n?\s*suggestion\?\.proposed_account \|\| suggestion\?\.account_name \|\| suggestion\?\.account_code \|\| null/
  );
});

test('both live-row builders and the recent feed resolve the verdict through the triple', () => {
  // buildLiveRow (aiCat + cat), transactionToReconciledRow (aiCat + cat),
  // RecentPanel — five call sites; no builder is allowed to read a single
  // ai_suggestion key directly.
  const calls = panelSource.match(/aiSuggestionAccount\(/g) || [];
  assert.ok(calls.length >= 5, `expected ≥5 aiSuggestionAccount call sites, saw ${calls.length}`);
  assert.doesNotMatch(
    panelSource,
    /ai_suggestion\?\.proposed_account/,
    'no builder bypasses the triple with a single-key read'
  );
});

test('terminal reconciled rows read posted account, then the verdict triple, then the fossil', () => {
  assert.match(
    panelSource,
    /cat: tx\.account_name\s*\n\s*\|\| tx\.account_code\s*\n\s*\|\| aiSuggestionAccount\(tx\.ai_suggestion\)/
  );
});

test('no fabricated Suspense claim when no verdict exists anywhere', () => {
  // A row with no verdict renders the missing state ("Needs category"),
  // never a manufactured 'Suspense' pill. The literal survives only in
  // mock/demo data and the chart-of-accounts entry, plus the expanded-row
  // picker's park default — none of which is a rendered claim about a line.
  assert.doesNotMatch(panelSource, /tx\.category \|\|\s*\n?\s*'Suspense'/);
});
