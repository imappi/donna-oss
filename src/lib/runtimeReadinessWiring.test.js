import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const consoleSource = readFileSync(new URL('../components/FirmOpsConsole.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('./firmApi.js', import.meta.url), 'utf8');

test('selected-entity chrome renders unconditional persisted readiness and the safe retry', () => {
  assert.match(consoleSource, /selectedClient\?\.runtime_readiness/);
  assert.match(consoleSource, /selectedReadiness\.label/);
  assert.match(consoleSource, /selectedReadiness\.reason_code/);
  assert.match(consoleSource, /selectedReadiness\.can_retry_now/);
  assert.match(consoleSource, /retryFirmClientReadiness\(selectedClient\.id, \{ reopenExhausted: readinessReopen \}\)/);
  assert.match(apiSource, /clients\/\$\{encodeURIComponent\(clientId\)\}\/readiness\/retry/);
});

test('an exhausted saga renders the explicit reopen action, never a dead pill', () => {
  assert.match(consoleSource, /selectedReadiness\?\.can_reopen/);
  assert.match(consoleSource, /firm\.readiness\.reopen/);
  assert.match(apiSource, /reopen_exhausted: true/);
});

test('a host-recovery refusal refreshes its persisted projection instead of leaving stale chrome', () => {
  assert.match(consoleSource, /fetchFirmSnapshot/);
  assert.match(consoleSource, /selectedReadiness\?\.reason_code === 'host_certificate_not_pass'/);
  assert.match(consoleSource, /selectedReadiness\?\.effective_state === 'host_unavailable'/);
  assert.match(consoleSource, /setTimeout\(pollReadiness, 1000\)/);
  assert.match(consoleSource, /attempts < 30/);
  assert.match(consoleSource, /refreshed\?\.effective_state === 'ready'/);
});

test('RT-09: a host wait renders its own copy and no Retry, and keeps the bounded host-recovery refresh alive', async () => {
  const { default: en } = await import('../i18n/catalogs/en.js');
  assert.match(consoleSource, /selectedReadiness\.waiting_for_host/, 'the tooltip names the host wait');
  assert.match(consoleSource, /firm\.readiness\.waitingForHost/);
  assert.match(consoleSource, /selectedReadiness\?\.waiting_for_host/, 'the host-recovery refresh poll includes every host-wait reason');
  assert.match(en['firm.readiness.waitingForHost'], /runtime host/i);
  assert.match(en['firm.readiness.waitingForHost'], /no retry budget/i);
  // The Retry/Reopen button is gated on the projection's can_retry_now /
  // can_reopen, which the server sets false for a host wait — the console
  // adds no client-side override that could re-offer the click.
  assert.match(consoleSource, /\(selectedReadiness\.can_retry_now \|\| selectedReadiness\.can_reopen\) && firmDataSource === 'database'/);
});
