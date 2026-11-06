import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml } from './xmlReader.js';
import * as finlandReceive from './finland/verkkolaskuReceive.js';

test('the retired FI XML shim is absent; callers use the shared reader directly', () => {
  assert.equal(Object.hasOwn(finlandReceive, 'parseXml'), false);
});

test('the shared reader preserves raw names, namespace declarations and source text for adapters', () => {
  const root = parseXml('<doc:Invoice xmlns:doc="urn:invoice" currency="AED"><doc:Name>A &amp; B</doc:Name></doc:Invoice>');
  assert.deepEqual(root, {
    name: 'doc:Invoice', localName: 'Invoice',
    attrs: { 'xmlns:doc': 'urn:invoice', currency: 'AED' },
    children: [{ name: 'doc:Name', localName: 'Name', attrs: {}, children: [], text: 'A & B' }],
    text: ''
  });
});
