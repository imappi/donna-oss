// The portal shows the owner what Donna did with an answered question: the
// stored line (server/donna/ownerReplyNotice.js), never a composed one, never
// a line that invites a reply the closed question does not have, and never a
// line for a reply that a later one superseded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const answered = ({ id, status = 'resolved', statement, line = statement, replyKey = `${id}:reply-1`, processedKey = replyKey, state = 'completed', at = '2026-11-01T10:00:00.000Z', clientId = 'client-a' }) => ({
  id, client_id: clientId, status, resolved_at: status === 'resolved' ? at : null, responded_at: at, updated_at: at,
  response_payload: { reply: 'Synthetic owner answer.', owner_notice: line, owner_notice_statement: statement, owner_notice_reply_key: replyKey,
    reply_processing: { state, reply_key: processedKey } }
});

const load = async (t) => {
  const directory = await mkdtemp(resolve('.answered-notices-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await build({ stdin: { contents: `export { default as AnsweredOwnerNotices, answeredOwnerNotices } from './src/components/AnsweredOwnerNotices.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx';`, resolveDir: process.cwd() },
    outfile: `${directory}/render.mjs`, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  return import(pathToFileURL(`${directory}/render.mjs`));
};

test('the portal renders the stored statement of each answered question, in the owner\'s language, and nothing else', async (t) => {
  const { AnsweredOwnerNotices, answeredOwnerNotices, LocaleProvider } = await load(t);
  const recorded = answered({ id: 'ask-recorded', statement: 'We recorded that the business has been VAT-registered since 2026-01-01.',
    line: 'We recorded that the business has been VAT-registered since 2026-01-01. Reply here if that is not right.' });
  const notRecorded = answered({ id: 'ask-locked', status: 'replied', at: '2026-11-02T10:00:00.000Z',
    statement: 'Your answer is saved, but we did not change the VAT registration details we hold for the business. Your accountant needs to check it before the record is changed.' });
  const requests = [
    recorded, notRecorded,
    // A later reply on the same question is not processed yet: its old line is not shown.
    answered({ id: 'ask-superseded', status: 'replied', statement: 'Superseded line.', processedKey: 'ask-superseded:reply-2', state: 'pending' }),
    // Still processing, another client, an open question, a question with no line.
    answered({ id: 'ask-pending', status: 'replied', statement: 'Pending line.', state: 'retry_pending' }),
    answered({ id: 'ask-other-client', statement: 'Another client.', clientId: 'client-b' }),
    { ...answered({ id: 'ask-open', statement: 'Open line.' }), status: 'open' },
    { id: 'ask-plain', client_id: 'client-a', status: 'resolved', response_payload: { reply: 'x', reply_processing: { state: 'completed', reply_key: 'k' } } }
  ];
  assert.deepEqual(answeredOwnerNotices(requests, { clientId: 'client-a' }).map((row) => row.id), ['ask-locked', 'ask-recorded']);
  const render = (locale, rows) => renderToStaticMarkup(React.createElement(LocaleProvider, { initialPreferences: { locale } },
    React.createElement(AnsweredOwnerNotices, { requests: rows, clientId: 'client-a' })));
  const html = render('en', requests);
  assert.match(html, /What Donna did with your answers/);
  assert.match(html, /We recorded that the business has been VAT-registered since 2026-01-01\./);
  assert.match(html, /Your accountant needs to check it before the record is changed\./);
  assert.doesNotMatch(html, /Reply here/, 'no invitation to a reply the closed question does not have');
  assert.doesNotMatch(html, /Superseded line|Pending line|Another client|Open line/);
  // The line is the stored one, already in the owner's language; the heading follows the interface locale.
  const fi = render('fi', [answered({ id: 'ask-fi', statement: 'Kirjasimme, että yritys on arvonlisäverorekisterissä 2026-01-01 alkaen.' })]);
  assert.match(fi, /Mitä Donna teki vastauksillasi/);
  assert.match(fi, /Kirjasimme, että yritys on arvonlisäverorekisterissä 2026-01-01 alkaen\./);
  assert.doesNotMatch(fi, /Vastaa tähän/);
  assert.equal(render('en', requests.slice(2)), '', 'no section without a line to show');
});

test('the component is mounted in the owner portal on the client\'s own questions', async () => {
  const portal = await readFile(new URL('./components/donna-client-portal.jsx', import.meta.url), 'utf8');
  assert.match(portal, /import AnsweredOwnerNotices from '\.\/AnsweredOwnerNotices\.jsx';/);
  assert.match(portal, /<AnsweredOwnerNotices requests=\{clientEvidenceRequestsScoped\} clientId=\{selectedClient\?\.id \|\| null\} \/>/);
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');
  assert.match(app, /import ClientPortal from '\.\/components\/donna-client-portal\.jsx'/);
});
