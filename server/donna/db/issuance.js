// Shared owner-invoice command orchestration. Country lifecycle implementations
// are registered separately; no country numbering, settlement or quote policy lives here.
import { toLocalIsoDay } from '../dates.js';
import { configSnapshotId, readClientConfigSnapshot } from '../clientConfig.js';
import { resolveOwnerInvoiceSellerContext } from '../ownerInvoiceSellerContext.js';
import { runOwnerInvoiceCommand } from '../ownerInvoiceCommand.js';
import { readOwnerInvoiceCommand } from '../ownerInvoiceCommandRead.js';
import { listCustomerPartyCandidates } from '../outbound/partyStore.js';
import { createOutboundInvoiceDraft } from '../outbound/issuance.js';
import { withFirmDbClient } from './pool.js';
import { shortHash } from './shared.js';
import { DEFAULT_FIRM_ID } from './clients.js';

// The jurisdiction-neutral seller context for the owner-command adapter
// (kernel-audit M2). Sibling of getInvoiceSellerContextInDb above, which reads
// the SAME row through the FI-specific reader: this one resolves the pack from
// the client's jurisdiction and the tax-registration status from that market's
// registration record (server/donna/ownerInvoiceSellerContext.js). All the
// resolution is pure — this function is only the query.
//
// Returns null for an unknown client so the adapter refuses by name rather than
// building on an empty row.
export const getOwnerInvoiceSellerContextInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, onDate = null } = {}) => {
  if (!clientId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select * from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return resolveOwnerInvoiceSellerContext(row, {
      // Host-local "today" (audit F-11).
      onDate: onDate || toLocalIsoDay(new Date())
    });
  });
};

// The owner-command adapter, bound to production machinery (kernel-audit M2,
// piece 3). This is the ONLY place `runOwnerInvoiceCommand`'s injected
// dependencies resolve to something real; the adapter itself still owns no
// transport, no store and no pool handle.
//
// Everything runs on ONE connection inside ONE transaction: the claim, the
// draft mint and the settle. That is what makes the source-message claim
// meaningful — a crash rolls the whole turn back to "unclaimed" rather than
// leaving a burnt invoice number attached to a command that never settled.
//
// Born OFF. `runOwnerInvoiceCommand` checks OWNER_INVOICE_COMMAND before it
// claims, reads or writes anything, so with no stage row this function opens a
// transaction, resolves a flag to false, and commits nothing.
export const runOwnerInvoiceCommandInDb = async ({
  firmId = DEFAULT_FIRM_ID, clientId,
  sourceMessageId, sourceChannel,
  principalActorType, principalActorId = null, channelBinding = {},
  messageText, env = process.env, now = Date.now(),
  fetchImpl = undefined, continuationAskId = null
} = {}) => {
  if (!clientId) return { status: 'skipped', reason: 'no_client' };
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await runOwnerInvoiceCommandTurn(client, {
        firmId, clientId, sourceMessageId, sourceChannel,
        principalActorType, principalActorId, channelBinding,
        messageText, env, now, fetchImpl, continuationAskId
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// The turn itself, on a caller-managed transaction (the M0 store posture every
// other outbound writer follows). Split out so the transaction boundary above
// stays readable and so a future caller that already holds a transaction can
// reuse it without opening a nested one.
export const runOwnerInvoiceCommandTurn = async (client, {
  firmId, clientId, sourceMessageId, sourceChannel,
  principalActorType, principalActorId, channelBinding,
  messageText, env, now, fetchImpl, continuationAskId = null
}) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  let continuation = null;
  const currentMessageText = messageText;
  if (continuationAskId) {
    continuation = await prepareOwnerInvoiceContinuation(client, {
      firmId, clientId, continuationAskId, principalActorType, principalActorId,
      sourceChannel, sourceMessageId, messageText
    });
    if (continuation.result) return continuation.result;
    messageText = continuation.messageText;
  }
  const result = await runOwnerInvoiceCommand({
    client, firmId, clientId,
    sourceMessageId, sourceChannel,
    principalActorType, principalActorId, channelBinding,
    messageText, currentMessageText, snapshot, env, now,
    configSnapshotId: configSnapshotId(snapshot),

    readCommandFn: (args) => readOwnerInvoiceCommand({
      ...args,
      ...(fetchImpl ? { fetchImpl } : {})
    }),

    listBuyerCandidatesFn: ({ client: c, firmId: f, clientId: cl }) =>
      listCustomerPartyCandidates(c, { firmId: f, clientId: cl }),

    // Jurisdiction-neutral: the pack and the seller's tax-registration status
    // come from the client's OWN persisted facts, resolved for today's date.
    resolveSellerContextFn: async ({ client: c, firmId: f, clientId: cl }) => {
      const { rows } = await c.query(
        `select * from clients where firm_id = $1 and id = $2 limit 1`,
        [f, cl]
      );
      if (!rows[0]) return null;
      return resolveOwnerInvoiceSellerContext(rows[0], {
        // Host-local "today" (audit F-11).
        onDate: toLocalIsoDay(now)
      });
    },

    createInvoiceDraftFn: createOutboundInvoiceDraft,

    // The owner ask, on the existing evidence-request substrate — the same
    // surface every other "Donna needs a fact only you can know" lands on, so
    // an incomplete command rests ON THE OWNER and never in a firm-side queue.
    askOwnerFn: async ({ client: c, firmId: f, clientId: cl, question, commandId, missing }) => {
      const requestId = `owner-invoice-command-${f}-${cl}-${shortHash(`${commandId}`)}`;
      const { rows } = await c.query(
        `insert into client_evidence_requests (
           id, firm_id, client_id, status, evidence_type, question, request_payload,
           first_sent_at, last_sent_at, send_count, created_by
         )
         values ($1, $2, $3, 'open', 'owner_invoice_command', $4, $5::jsonb, now(), now(), 1, $6)
         on conflict (id) do update set last_sent_at = now()
         returning *`,
        [
          requestId, f, cl, question,
          JSON.stringify({ kind: 'owner_invoice_command', command_id: commandId, missing: missing || [], command_message: String(messageText || '').slice(0, 4000) }),
          principalActorId || principalActorType || 'system'
        ]
      );
      return rows[0] || null;
    }
  });
  if (continuation && ['drafted', 'asked'].includes(result.status)) {
    await finishOwnerInvoiceContinuation(client, {
      firmId, clientId, askId: continuationAskId, sourceMessageId,
      actorId: principalActorId, reply: currentMessageText, result
    });
  }
  return result;
};

// These helpers extend the existing owner-command ask writer. All reads,
// continuation minting and closing the answered ask share its caller's
// transaction; a rollback cannot leave a second open question or a draft
// without its source. No general evidence-reply path is reclassified.
export const prepareOwnerInvoiceContinuation = async (client, {
  firmId, clientId, continuationAskId, principalActorType, principalActorId,
  sourceChannel, sourceMessageId, messageText
}) => {
  const { rows } = await client.query(
    `select r.*, c.principal_actor_type as command_actor_type,
            c.principal_actor_id as command_actor_id, c.source_channel as command_channel
       from client_evidence_requests r
       join owner_invoice_commands c on c.id = r.request_payload->>'command_id'
         and c.firm_id = r.firm_id and c.client_id = r.client_id
      where r.firm_id = $1 and r.client_id = $2 and r.id = $3
        and r.evidence_type = 'owner_invoice_command'
      for update of r`, [firmId, clientId, continuationAskId]
  );
  const ask = rows[0];
  const samePrincipal = ask && principalActorType === ask.command_actor_type
    && principalActorId && principalActorId === ask.command_actor_id
    && sourceChannel === ask.command_channel;
  if (!samePrincipal || ask.status !== 'open') {
    if (samePrincipal && ask.response_payload?.invoice_continuation?.source_message_id === sourceMessageId) {
      return { result: { status: 'duplicate' } };
    }
    return { result: { status: 'refused', reason: 'draft_invalid',
      error: 'The invoice question is no longer open or belongs to a different owner/channel. Send a new complete invoice instruction.' } };
  }
  const original = String(ask.request_payload?.command_message || '').trim();
  const reply = String(messageText || '').trim();
  const combined = original ? `${original}\n\nOWNER FOLLOW-UP (supersedes conflicting earlier facts):\n${reply}` : reply;
  // Overflow/legacy asks require a complete new statement rather than reading
  // silently truncated history. The ordinary missing-fact fork remains active.
  return { ask, messageText: combined.length <= 4000 ? combined : reply };
};

export const finishOwnerInvoiceContinuation = async (client, {
  firmId, clientId, askId, sourceMessageId, actorId, reply, result
}) => {
  const successorId = result?.status === 'asked' ? result.evidenceRequestId
    : result?.status === 'drafted' ? result.draft?.id : null;
  if (!actorId || !String(successorId || '').trim()
    || (result?.status === 'asked' && successorId === askId)) {
    throw new Error('Invoice continuation requires an attributed successor outcome');
  }
  const receipt = {
    reply: String(reply || ''),
    invoice_continuation: { source_message_id: sourceMessageId, actor_id: actorId,
      authority_basis: 'owner_invoice_command_reply', status: result.status,
      issued_invoice_id: result.draft?.id || null, successor_evidence_request_id: result.evidenceRequestId || null }
  };
  const closed = await client.query(
    `update client_evidence_requests set status = 'resolved',
       response_payload = coalesce(response_payload, '{}'::jsonb) || $4::jsonb,
       responded_at = coalesce(responded_at, now()), resolved_at = now(), resolved_by = $5, updated_at = now()
     where firm_id = $1 and client_id = $2 and id = $3 and status = 'open'
       and evidence_type = 'owner_invoice_command' returning id`,
    [firmId, clientId, askId, JSON.stringify(receipt), actorId]
  );
  if (!closed.rows[0]) throw new Error('Invoice continuation lost its open question');
};
