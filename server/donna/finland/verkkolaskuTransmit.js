// FI-10 (send-half) — the Finvoice transmission envelope + email transmit.
// Design: docs/design-donna-finland-fi10-send-half.md.
//
// Two layers, kept separate:
//   • PURE — buildTransmissionEnvelope (KEEP-layer address/id validation) and
//     renderFinvoiceTransmissionXml (envelope as the FIRST child of <Finvoice>,
//     per the Finvoice 3.0 layout; the output must still round-trip through the
//     FI-9 receive parser, machine-checked in the tests).
//   • I/O-INJECTABLE — transmitFinvoiceEmail: the v1 transmit channel (D-FI10-S3;
//     the operator-network lane is a separate slice behind D-FI10-OP). No I/O
//     import lives in this module: the caller injects `sendEmail`. A transmit is
//     OUTWARD-FACING, so it refuses without an explicit authority basis + actor
//     (confirm-first — the same discipline as the FI-6 owner confirm) and returns
//     a receipt carrying actor, authority basis, and message id.

import { isValidIban } from './verkkolasku.js';
import { renderFinvoiceXml } from './verkkolaskuRender.js';
import { invoicePdfFilename, renderInvoicePdf } from './invoicePdf.js';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const clean = (v) => String(v ?? '').trim();

// ---------------------------------------------------------------------------------
// E-invoice address (verkkolaskuosoite) — KEEP-layer format invariant.
// ---------------------------------------------------------------------------------
// The two accepted forms: an OVT identifier (0037 + the 8-digit Y-tunnus body +
// an optional 0–5 char alphanumeric suffix) or a valid IBAN (netbank delivery).
// Anything else is refused, never shaded into a guess.
export const isValidEInvoiceAddress = (address) => {
  const s = clean(address).toUpperCase().replace(/\s+/g, '');
  if (!s) return false;
  if (/^0037\d{8}[0-9A-Z]{0,5}$/.test(s)) return true;
  return isValidIban(s);
};

// Operator/intermediator id (välittäjätunnus): a BIC (HELSFIHH, DABAFIHH) or an
// operator code (APIXFI22, MAVENTA / an OVT-form id). Loose on purpose — 4–35
// alphanumerics — the registry of live operators is data, not a format rule.
export const isValidIntermediator = (id) => /^[0-9A-Z]{4,35}$/.test(clean(id).toUpperCase());

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------------
// buildTransmissionEnvelope — the MessageTransmissionDetails model. Pure.
// ---------------------------------------------------------------------------------
// { sender: {eInvoiceAddress, intermediator}, receiver: {eInvoiceAddress,
//   intermediator}, messageId, timestamp } → { ok, errors, envelope }.
// `messageId` defaults to `<invoiceNumber>-<timestamp date>` when an invoice
// number is supplied. Never throws on bad input (same contract as buildFinvoice).
export const buildTransmissionEnvelope = ({
  sender = {},
  receiver = {},
  messageId = null,
  timestamp = null,
  invoiceNumber = null
} = {}) => {
  const errors = [];

  const senderAddress = clean(sender.eInvoiceAddress).toUpperCase().replace(/\s+/g, '');
  const receiverAddress = clean(receiver.eInvoiceAddress).toUpperCase().replace(/\s+/g, '');
  if (!isValidEInvoiceAddress(senderAddress)) errors.push('sender.eInvoiceAddress must be an OVT identifier (0037…) or a valid IBAN');
  if (!isValidEInvoiceAddress(receiverAddress)) errors.push('receiver.eInvoiceAddress must be an OVT identifier (0037…) or a valid IBAN');

  const senderIntermediator = clean(sender.intermediator).toUpperCase();
  const receiverIntermediator = clean(receiver.intermediator).toUpperCase();
  if (!isValidIntermediator(senderIntermediator)) errors.push('sender.intermediator is required (operator id / BIC, 4–35 alphanumerics)');
  if (!isValidIntermediator(receiverIntermediator)) errors.push('receiver.intermediator is required (operator id / BIC, 4–35 alphanumerics)');

  const ts = clean(timestamp);
  if (!ISO_TIMESTAMP.test(ts)) errors.push('timestamp must be an ISO-8601 datetime (e.g. 2026-07-09T12:00:00Z)');

  let id = clean(messageId);
  if (!id && isNonEmptyString(invoiceNumber) && ISO_TIMESTAMP.test(ts)) {
    id = `${clean(invoiceNumber)}-${ts.slice(0, 10)}`;
  }
  if (!id) errors.push('messageId is required (or supply invoiceNumber to derive one)');

  if (errors.length) return { ok: false, errors, envelope: null };

  return {
    ok: true,
    errors: [],
    envelope: {
      sender: { eInvoiceAddress: senderAddress, intermediator: senderIntermediator },
      receiver: { eInvoiceAddress: receiverAddress, intermediator: receiverIntermediator },
      messageId: id,
      timestamp: ts
    }
  };
};

// ---------------------------------------------------------------------------------
// renderFinvoiceTransmissionXml — the deliverable XML: envelope + invoice.
// ---------------------------------------------------------------------------------
// Renders the footed Finvoice via renderFinvoiceXml, then splices
// MessageTransmissionDetails in as the FIRST child of <Finvoice> (the Finvoice 3.0
// layout). The FI-9 receive parser extracts by local element names and ignores the
// envelope block, so the issue/receive round-trip is preserved (tested).
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const renderFinvoiceTransmissionXml = ({ finvoice, envelope } = {}) => {
  if (!envelope || !envelope.sender || !envelope.receiver) {
    return { ok: false, errors: ['a built transmission envelope is required'], xml: null };
  }
  const base = renderFinvoiceXml(finvoice);
  if (!base.ok) return base;

  const i2 = '  ';
  const i4 = '    ';
  const i6 = '      ';
  let block = `${i2}<MessageTransmissionDetails>\n`;
  block += `${i4}<MessageSenderDetails>\n`;
  block += `${i6}<FromIdentifier>${esc(envelope.sender.eInvoiceAddress)}</FromIdentifier>\n`;
  block += `${i6}<FromIntermediator>${esc(envelope.sender.intermediator)}</FromIntermediator>\n`;
  block += `${i4}</MessageSenderDetails>\n`;
  block += `${i4}<MessageReceiverDetails>\n`;
  block += `${i6}<ToIdentifier>${esc(envelope.receiver.eInvoiceAddress)}</ToIdentifier>\n`;
  block += `${i6}<ToIntermediator>${esc(envelope.receiver.intermediator)}</ToIntermediator>\n`;
  block += `${i4}</MessageReceiverDetails>\n`;
  block += `${i4}<MessageDetails>\n`;
  block += `${i6}<MessageIdentifier>${esc(envelope.messageId)}</MessageIdentifier>\n`;
  block += `${i6}<MessageTimeStamp>${esc(envelope.timestamp)}</MessageTimeStamp>\n`;
  block += `${i4}</MessageDetails>\n`;
  block += `${i2}</MessageTransmissionDetails>\n`;

  const marker = '<Finvoice Version="3.0">\n';
  const at = base.xml.indexOf(marker);
  if (at === -1) return { ok: false, errors: ['unexpected Finvoice XML root; cannot splice the envelope'], xml: null };
  const xml = base.xml.slice(0, at + marker.length) + block + base.xml.slice(at + marker.length);
  return { ok: true, errors: [], xml };
};

// ---------------------------------------------------------------------------------
// transmitFinvoiceEmail — the v1 transmit channel. I/O fully injected.
// ---------------------------------------------------------------------------------
// Refusals (typed, thrown — a refused transmit must not look like a soft error):
//   • FINVOICE_TRANSMIT_AUTHORITY_REQUIRED — no authorityBasis/actorId. A send is
//     outward-facing: nothing goes out without the owner's instruction receipt.
//   • FINVOICE_TRANSMIT_NOT_RENDERABLE — the model doesn't foot / envelope invalid.
//   • FINVOICE_TRANSMIT_NO_TRANSPORT / _NO_RECIPIENT — wiring errors.
// Returns { receipt } with actor, authority basis, messageId, and the model id
// when one drafted the invoice (the model id is part of the receipt).
export const transmitFinvoiceEmail = async ({
  finvoice,
  envelope,
  to,
  subject = null,
  bodyText = null,
  authorityBasis = null,
  actorId = null,
  model = null,
  sendEmail
} = {}) => {
  if (!authorityBasis || !authorityBasis.source || !actorId) {
    const error = new Error('Finvoice transmit requires an authority basis (the owner\'s instruction receipt) and an actor id.');
    error.code = 'FINVOICE_TRANSMIT_AUTHORITY_REQUIRED';
    throw error;
  }
  if (typeof sendEmail !== 'function') {
    const error = new Error('Finvoice email transmit requires an injected sendEmail transport.');
    error.code = 'FINVOICE_TRANSMIT_NO_TRANSPORT';
    throw error;
  }
  const recipient = clean(to);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    const error = new Error('Finvoice email transmit requires a valid recipient email address.');
    error.code = 'FINVOICE_TRANSMIT_NO_RECIPIENT';
    throw error;
  }

  const rendered = renderFinvoiceTransmissionXml({ finvoice, envelope });
  if (!rendered.ok) {
    const error = new Error(`Finvoice does not render: ${rendered.errors.join('; ')}`);
    error.code = 'FINVOICE_TRANSMIT_NOT_RENDERABLE';
    error.errors = rendered.errors;
    throw error;
  }

  // D-FI10-P3: the XML is the machine-readable deliverable and stays first; the
  // PDF is what the buyer's human reads. Both project the SAME validated model,
  // so a PDF render failure here is a bug to surface, not a leg to skip.
  const renderedPdf = await renderInvoicePdf({ finvoice });
  if (!renderedPdf.ok) {
    const error = new Error(`Invoice PDF does not render: ${renderedPdf.errors.join('; ')}`);
    error.code = 'FINVOICE_TRANSMIT_NOT_RENDERABLE';
    error.errors = renderedPdf.errors;
    throw error;
  }

  const d = (finvoice && finvoice.schema ? finvoice : finvoice?.finvoice)?.invoiceDetails || {};
  const invoiceNumber = d.invoiceNumber || envelope.messageId;
  const filename = `finvoice-${String(invoiceNumber).replace(/[^0-9A-Za-z_-]/g, '_')}.xml`;
  // G-8: a hyvityslasku (INV02) says what it is in the email copy.
  const artifactLabel = d.typeCode === 'INV02' ? 'Hyvityslasku' : 'Lasku';

  const sendResult = await sendEmail({
    to: recipient,
    subject: subject || `${artifactLabel} ${invoiceNumber}`,
    text: bodyText || `Liitteenä ${artifactLabel === 'Hyvityslasku' ? 'hyvityslasku' : 'verkkolasku'} ${invoiceNumber} (Finvoice 3.0 XML) sekä ${artifactLabel.toLowerCase()} PDF-muodossa.`,
    attachments: [
      { filename, content: rendered.xml, contentType: 'application/xml' },
      { filename: invoicePdfFilename(invoiceNumber), content: Buffer.from(renderedPdf.bytes), contentType: 'application/pdf' }
    ]
  });

  return {
    receipt: {
      channel: 'email',
      format: 'finvoice_xml',
      to: recipient,
      invoice_number: invoiceNumber,
      message_id: envelope.messageId,
      transmitted_at: envelope.timestamp,
      provider_result: sendResult ?? null,
      authority_basis: authorityBasis,
      actor_id: actorId,
      model: model || null
    }
  };
};
