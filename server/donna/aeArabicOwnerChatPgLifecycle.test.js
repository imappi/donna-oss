// AR-5B integration pin: Arabic is not proved by calling a prompt helper in
// isolation. This drives the desktop runtime's authenticated client-chat POST,
// its real persisted context gather, structured model request, proposal writer,
// owner-safe GET projection, and the same pure view projection mounted by
// ClientPortalChatPanel. Provider intelligence is replayed at the HTTP boundary;
// PostgreSQL, routes, authorization, persistence and proposal lifecycle are real.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createClientEvidenceRequestInDb } from './firmDb.js';
import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { portalChatActionCards, portalChatDisplayMessages } from '../../src/lib/clientPortalChat.js';

test(
  'real PG: Arabic owner answer reaches the mounted client-chat route and rests as a confirmable owner proposal',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({
      now: new Date('2026-09-02T09:00:00.000Z'),
      firm: { jurisdiction: 'AE', currency: 'AED' }
    });
    try {
      const { clientId } = await appliance.createClient({
        profile: {
          companyName: 'Gulf Trading LLC / شركة الخليج للتجارة ذ.م.م',
          entityType: 'ae-llc',
          jurisdiction: 'AE',
          accounting_currency: 'AED'
        }
      });
      const scanBytes = await readFile(new URL('../../data/worlds/ae/artifacts/ar5b/tax-invoice-scan-ar.png', import.meta.url));
      const uploaded = await appliance.uploadDocument({
        clientId,
        bytes: scanBytes,
        filename: 'فاتورة-ضريبية-AE-INV-2026-0042.png',
        mimeType: 'image/png',
        documentType: 'supplier_bill'
      });
      const minted = await createClientEvidenceRequestInDb({
        firmId: appliance.firmId,
        clientId,
        documentId: uploaded.documentId,
        question: 'أي التزام تسدده دفعة ٥٬٢٥٠ د.إ؟',
        evidenceType: 'business_purpose',
        actorId: appliance.memberId,
        returnSnapshot: false
      });
      const askId = minted.evidence_request.id;
      assert.equal(minted.evidence_request.status, 'draft'); // W1: a mint is a draft until a channel sends it

      const recording = loadRecording('chat_engine/ar5b-ask-answer-ar');
      const body = structuredClone(recording.body);
      const action = body.content[0].input.actions[0];
      action.evidence_request_id = askId;
      appliance.providers.script('chat_engine', [{ recording: recording.name, body }]);

      const ownerText = 'دفعة ٥٬٢٥٠ د.إ تسدد التزام ضريبة القيمة المضافة لشهر أغسطس.';
      const posted = await appliance.api.request({
        method: 'POST',
        path: '/api/donna/firms/client-chat/messages',
        auth: true,
        body: { firm_id: appliance.firmId, client_id: clientId, message: ownerText }
      });
      assert.equal(posted.status, 201, posted.text);
      assert.match(posted.json.assistant_message.content, /[\p{Script=Arabic}]/u);
      assert.equal(posted.json.assistant_message.actor_type, 'llm');
      assert.equal(posted.json.assistant_message.payload.actions.length, 1);
      assert.equal(posted.json.assistant_message.payload.actions[0].type, 'answer_evidence_request');
      assert.equal(posted.json.assistant_message.payload.actions[0].evidence_request_id, askId);
      assert.equal(posted.json.assistant_message.payload.actions[0].status, 'proposed');

      const thread = await appliance.api.request({
        path: `/api/donna/firms/client-chat?firm_id=${encodeURIComponent(appliance.firmId)}&client_id=${encodeURIComponent(clientId)}`,
        auth: true
      });
      assert.equal(thread.status, 200, thread.text);
      const display = portalChatDisplayMessages(thread.json.messages);
      assert.equal(display.at(-2).text, ownerText);
      assert.match(display.at(-1).text, /[\p{Script=Arabic}]/u);
      const card = portalChatActionCards(thread.json.messages.at(-1))[0];
      assert.equal(card.evidenceRequestId, askId);
      assert.equal(card.confirmable, true);
      assert.match(card.replyText, /[\p{Script=Arabic}]/u);

      const asks = await appliance.read.asks(clientId);
      assert.equal(asks.find((row) => row.id === askId)?.status, 'draft', 'proposal does not apply the owner answer before confirmation (W1: never sent, so still a draft)');
      const journalCount = await appliance.query(
        'select count(*)::int as count from ledger_journals where firm_id = $1 and client_id = $2',
        [appliance.firmId, clientId]
      );
      assert.equal(journalCount.rows[0].count, 0, 'an owner-chat proposal cannot write the ledger');
      const proposalAudit = await appliance.read.audit({ clientId, action: 'chat.proposal_minted' });
      assert.equal(proposalAudit.length, 1);
      assert.equal(proposalAudit[0].metadata.surface, 'client_chat');
      assert.deepEqual(proposalAudit[0].metadata.action_types, ['answer_evidence_request']);

      const calls = appliance.providers.callsFor('chat_engine');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].recording, recording.name);
      appliance.providers.assertNoUnscripted();
    } finally {
      await appliance.stop();
    }
  }
);
