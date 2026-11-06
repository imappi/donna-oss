// toastBus — pure pub/sub tests.

import assert from 'node:assert/strict';

import {
  __resetToastBusForTests,
  emitToast,
  subscribeToToasts
} from './toastBus.js';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  __resetToastBusForTests();
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.stack || err?.message || err}`);
  }
};

console.log('toastBus:');

await test('emitToast: string payload reaches subscribers', () => {
  const received = [];
  subscribeToToasts((toast) => received.push(toast));
  emitToast('Client replied');
  assert.equal(received.length, 1);
  assert.equal(received[0].message, 'Client replied');
  assert.equal(received[0].tone, 'info');
  assert.match(received[0].id, /^toast-/);
});

await test('emitToast: object payload preserves tone and href', () => {
  const received = [];
  subscribeToToasts((toast) => received.push(toast));
  emitToast({ message: 'Client replied', tone: 'intel', href: '/foo' });
  assert.equal(received[0].tone, 'intel');
  assert.equal(received[0].href, '/foo');
});

await test('emitToast: silently drops empty / nullish messages', () => {
  const received = [];
  subscribeToToasts((toast) => received.push(toast));
  emitToast('');
  emitToast('   ');
  emitToast(null);
  emitToast(undefined);
  emitToast({ message: '' });
  emitToast({ message: null });
  assert.equal(received.length, 0);
});

await test('subscribeToToasts: returns an unsubscribe that stops further calls', () => {
  const received = [];
  const unsubscribe = subscribeToToasts((toast) => received.push(toast));
  emitToast('first');
  unsubscribe();
  emitToast('second');
  assert.deepEqual(received.map((t) => t.message), ['first']);
});

await test('subscribeToToasts: unsubscribe is idempotent', () => {
  const received = [];
  const unsubscribe = subscribeToToasts((toast) => received.push(toast));
  unsubscribe();
  unsubscribe(); // second call must not throw
  emitToast('still nothing');
  assert.equal(received.length, 0);
});

await test('emitToast: a throwing subscriber does not break siblings', () => {
  const received = [];
  const originalError = console.error;
  console.error = () => {}; // silence the expected log
  try {
    subscribeToToasts(() => {
      throw new Error('boom');
    });
    subscribeToToasts((toast) => received.push(toast));
    emitToast('survives');
    assert.equal(received.length, 1);
    assert.equal(received[0].message, 'survives');
  } finally {
    console.error = originalError;
  }
});

await test('emitToast: durationMs and onClick survive normalization', () => {
  const received = [];
  const cb = () => {};
  subscribeToToasts((toast) => received.push(toast));
  emitToast({ message: 'x', durationMs: 1234, onClick: cb });
  assert.equal(received[0].durationMs, 1234);
  assert.equal(received[0].onClick, cb);
});

console.log(`\ntoastBus: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
