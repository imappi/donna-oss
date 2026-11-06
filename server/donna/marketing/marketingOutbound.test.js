// Marketing outbound — unit coverage for the pure invariants: the claim
// checklist (the honest-promise rail enforced at the writer), authority-stage
// resolution (no rows = off), and send rendering (unsubscribe link injection).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAFT_STATUSES,
  MARKETING_CHANNELS,
  SUPPRESSION_REASONS,
  TERMINAL_DRAFT_STATUSES,
  UNSUBSCRIBE_PLACEHOLDER,
  buildUnsubscribeUrl,
  renderForSend,
  resolveAuthorityStage,
  stageAllowsUnsupervisedSend,
  validateDraftCopy
} from './marketingOutbound.js';

const CLEAN_BODY = `Hi — a quick note from Donna.\n\nNo more emails? ${UNSUBSCRIBE_PLACEHOLDER}`;

test('a clean draft passes the claim checklist', () => {
  assert.deepEqual(validateDraftCopy({ subject: 'About your books', body: CLEAN_BODY }), []);
});

test('the honest-promise rail refuses human-reviewed claims', () => {
  const violations = validateDraftCopy({
    subject: 'Every close is human-reviewed',
    body: CLEAN_BODY
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /human-reviewed claim/);
});

test('the canonical 2026-07-23 promise passes the checklist (negations are not claims)', () => {
  // The approved honest-promise copy must NEVER be refused by the validator —
  // it phrases the no-human-back-office truth as negations that avoid every
  // banned pattern. If this test breaks, a pattern is over-broad.
  const violations = validateDraftCopy({
    subject: 'How Donna runs your books',
    body: `Donna runs your books herself. There is no human back office and no bookkeeper reviewing or finishing your work. Disagree anytime — she learns from your corrections.\n\nNo more emails? ${UNSUBSCRIBE_PLACEHOLDER}`
  });
  assert.deepEqual(violations, []);
});

test('retired-promise claims are refused: human-monitored and appointed professional', () => {
  const monitored = validateDraftCopy({
    subject: 'Hello',
    body: `A human monitors every close.\n${UNSUBSCRIBE_PLACEHOLDER}`
  });
  assert.equal(monitored.length, 1);
  assert.match(monitored[0], /human-monitored claim/);

  const professional = validateDraftCopy({
    subject: 'Hello',
    body: `Your appointed professional handles the hard parts.\n${UNSUBSCRIBE_PLACEHOLDER}`
  });
  assert.equal(professional.length, 1);
  assert.match(professional[0], /appointed-professional claim/);
});

test('guarantees, replaces-your-accountant, and set-and-forget are refused', () => {
  for (const bad of [
    'We guarantee clean books.',
    'Donna replaces your accountant.',
    'Truly set-and-forget bookkeeping.'
  ]) {
    const violations = validateDraftCopy({ subject: 'Hello', body: `${bad}\n${UNSUBSCRIBE_PLACEHOLDER}` });
    assert.equal(violations.length, 1, `expected exactly one violation for: ${bad}`);
  }
});

test('deceptive Re:/Fwd: subjects are refused', () => {
  assert.match(validateDraftCopy({ subject: 'Re: our chat', body: CLEAN_BODY })[0], /deceptive subject/);
  assert.match(validateDraftCopy({ subject: 'FWD: invoice', body: CLEAN_BODY })[0], /deceptive subject/);
});

test('a genuine reply may carry Re: — but only replies, and Fwd: never (M4)', () => {
  // isReply: a draft linked to a real inbound message answers a real thread.
  assert.deepEqual(validateDraftCopy({ subject: 'Re: our chat', body: CLEAN_BODY }, { isReply: true }), []);
  // The refusal stays absolute for cold drafts (default path unchanged)…
  assert.match(validateDraftCopy({ subject: 'Re: our chat', body: CLEAN_BODY }, { isReply: false })[0], /deceptive subject/);
  // …and Fwd: is never legitimate, reply or not.
  assert.match(validateDraftCopy({ subject: 'Fwd: invoice', body: CLEAN_BODY }, { isReply: true })[0], /deceptive subject/);
  // The claim checklist still applies to replies in full.
  assert.ok(
    validateDraftCopy({ subject: 'Re: books', body: `We guarantee results. ${CLEAN_BODY}` }, { isReply: true }).some((v) => /guarantee/.test(v))
  );
});

test('a draft without the unsubscribe placeholder is refused (even 1:1)', () => {
  const violations = validateDraftCopy({ subject: 'Hello', body: 'No unsubscribe here.' });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /unsubscribe/);
});

test('prices must be pricing.js numbers — invented prices are refused', () => {
  // $99 (recurring), $50/$90/$150 (bands) are allowed.
  assert.deepEqual(
    validateDraftCopy({ subject: 'Pricing', body: `Flat $99 a month, or closes from $50. ${UNSUBSCRIBE_PLACEHOLDER}` }),
    []
  );
  const violations = validateDraftCopy({ subject: 'Pricing', body: `Only $79 a month! ${UNSUBSCRIBE_PLACEHOLDER}` });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /\$79 is not a pricing\.js price/);
});

test('authority: no history rows resolves to off (the structural default)', () => {
  assert.equal(resolveAuthorityStage([], 'waitlist_nurture'), 'off');
  assert.equal(resolveAuthorityStage([{ channel: 'other_channel', stage: 'auto', created_at: '2026-07-01' }], 'waitlist_nurture'), 'off');
});

test('authority: the LATEST row per channel wins; junk stages resolve to off', () => {
  const rows = [
    { channel: 'waitlist_nurture', stage: 'dry_run', created_at: '2026-07-01T00:00:00Z' },
    { channel: 'waitlist_nurture', stage: 'canary', created_at: '2026-07-02T00:00:00Z' }
  ];
  assert.equal(resolveAuthorityStage(rows, 'waitlist_nurture'), 'canary');
  assert.equal(
    resolveAuthorityStage([{ channel: 'waitlist_nurture', stage: 'yolo', created_at: '2026-07-03T00:00:00Z' }], 'waitlist_nurture'),
    'off'
  );
});

test('only canary/auto ever allow an unsupervised send', () => {
  assert.equal(stageAllowsUnsupervisedSend('off'), false);
  assert.equal(stageAllowsUnsupervisedSend('dry_run'), false);
  assert.equal(stageAllowsUnsupervisedSend('shadow'), false);
  assert.equal(stageAllowsUnsupervisedSend('canary'), true);
  assert.equal(stageAllowsUnsupervisedSend('auto'), true);
});

test('renderForSend injects the real unsubscribe link into text, html, and headers', () => {
  const draft = {
    subject: 'A note from Donna',
    body: CLEAN_BODY,
    unsubscribe_token: 'tok-123'
  };
  const rendered = renderForSend({ draft, baseUrl: 'https://donna.example.com/' });
  const expectedUrl = buildUnsubscribeUrl('https://donna.example.com/', 'tok-123');
  assert.equal(expectedUrl, 'https://donna.example.com/api/donna/marketing/unsubscribe?token=tok-123');
  assert.ok(rendered.text.includes(expectedUrl), 'text carries the link');
  assert.ok(!rendered.text.includes(UNSUBSCRIBE_PLACEHOLDER), 'placeholder fully replaced');
  assert.ok(rendered.html.includes(`href="${expectedUrl}"`), 'html carries the anchor');
  assert.equal(rendered.headers['List-Unsubscribe'], `<${expectedUrl}>`);
  assert.equal(rendered.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('renderForSend escapes HTML in the body (LLM output is untrusted)', () => {
  const rendered = renderForSend({
    draft: { subject: 's', body: `<script>x</script> ${UNSUBSCRIBE_PLACEHOLDER}`, unsubscribe_token: 't' },
    baseUrl: 'https://d.example'
  });
  assert.ok(!rendered.html.includes('<script>'));
  assert.ok(rendered.html.includes('&lt;script&gt;'));
});

test('vocabularies are pinned (two-terminal-states: drafts rest on-Kari or terminal)', () => {
  assert.deepEqual([...DRAFT_STATUSES], ['proposed', 'approved', 'rejected', 'superseded', 'sent']);
  assert.deepEqual([...TERMINAL_DRAFT_STATUSES], ['rejected', 'superseded', 'sent']);
  assert.deepEqual([...SUPPRESSION_REASONS], ['unsubscribed', 'bounced', 'complaint', 'manual']);
  // 'reply' (M4): response drafts to inbound mail — same per-send approval path.
  assert.deepEqual([...MARKETING_CHANNELS], ['waitlist_nurture', 'reply']);
});
