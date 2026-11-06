import test from 'node:test';
import assert from 'node:assert';
import {
  rememberOwnerClientId,
  readOwnerClientId,
  clearOwnerClientId,
  OWNER_CLIENT_ID_KEY
} from './ownerPersona.js';

// Minimal localStorage shim so the browser-only module is exercisable under
// node's test runner (the functions read `window` at call time, not import).
const makeStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
};

test('remember + read round-trips a trimmed owner client id', () => {
  global.window = { localStorage: makeStorage() };
  assert.equal(typeof OWNER_CLIENT_ID_KEY, 'string');
  rememberOwnerClientId('  client-self-abc123  ');
  assert.equal(readOwnerClientId(), 'client-self-abc123');
  delete global.window;
});

test('a blank / falsy id is never stamped as a persona', () => {
  global.window = { localStorage: makeStorage() };
  rememberOwnerClientId('   ');
  assert.equal(readOwnerClientId(), null);
  rememberOwnerClientId(null);
  assert.equal(readOwnerClientId(), null);
  rememberOwnerClientId(undefined);
  assert.equal(readOwnerClientId(), null);
  delete global.window;
});

test('clear removes the persona (so the next user does not inherit it)', () => {
  global.window = { localStorage: makeStorage() };
  rememberOwnerClientId('client-self-abc123');
  assert.equal(readOwnerClientId(), 'client-self-abc123');
  clearOwnerClientId();
  assert.equal(readOwnerClientId(), null);
  delete global.window;
});

test('read returns null with no window (SSR / module-load safety)', () => {
  delete global.window;
  assert.equal(readOwnerClientId(), null);
  // writes + clears are no-ops, never throw
  assert.doesNotThrow(() => rememberOwnerClientId('client-self-x'));
  assert.doesNotThrow(() => clearOwnerClientId());
});
