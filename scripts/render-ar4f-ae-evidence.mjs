#!/usr/bin/env node

// Reproducible, send-free AR-4F visual evidence generator. Every byte comes
// from the shipping AE pack and production email/PDF renderers; the script
// writes local review artifacts only and performs no provider or database I/O.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { bidiSafeRenderValues, stripBidiControls } from '../server/donna/outbound/bidiText.js';
import {
  bidiPlainTextToHtml, buildOutboundEmailArtifact
} from '../server/donna/outbound/emailArtifact.js';
import {
  renderInvoicePdfArtifact, renderQuotePdfArtifact
} from '../server/donna/outbound/invoicePdfArtifact.js';
import {
  loadOutboundPack, renderPackTemplate, resolveCorrespondenceLanguage
} from '../server/donna/outbound/packs.js';

const outputDirectory = path.resolve(process.argv[2] || '/tmp/ar4f-ae-evidence');
await mkdir(outputDirectory, { recursive: true });

const pack = loadOutboundPack('ae', { bypassCache: true });
const resolution = resolveCorrespondenceLanguage(pack, {
  requestedLanguage: 'ar', requestedSource: 'party_preference'
});
if (!resolution.ok) throw new Error(`Arabic language resolution failed: ${resolution.reason}`);

const values = bidiSafeRenderValues({
  document_title: 'فاتورة ضريبية',
  owner_business_name: 'شركة ساحل الخليج للاستشارات ذ.م.م / Gulf Coast Consulting FZ-LLC',
  counterparty_name: 'مؤسسة النور للتجارة / Al Noor Trading',
  invoice_number: 'INV-2026-014',
  quote_number: 'Q-2026-017',
  issue_date: '31 أغسطس 2026',
  due_date: '14 سبتمبر 2026',
  valid_until: '30 سبتمبر 2026',
  lines_block: 'خدمات استشارية طويلة تحافظ على اتصال الحروف العربية عند الالتفاف — 1 × -12,345.67 = -12,345.67 AED\nرصيد صفري — ٠ × 0.00 = 0.00 AED',
  invoice_total: '12,345.67',
  quote_total: '12,345.67',
  amount_due: '12,345.67',
  currency: 'AED',
  days_overdue: '٣٠',
  days_until_due: '7',
  payment_instructions: 'TRN 100234567890003\nIBAN AE07 0331 2345 6789 0123 456\nمرجع الفاتورة INV-2026-014\nbilling@example-ae.example\nhttps://example-ae.example/invoices/INV-2026-014',
  unsubscribe_url: 'https://donna.example/unsubscribe?token=abc123'
}, { force: true });

const emailTemplates = [
  'invoice_issue', 'quote_send', 'quote_follow_up_1',
  'reminder_step_1', 'reminder_step_2', 'reminder_step_3', 'payable_notice'
];
const artifacts = emailTemplates.map((templateName) => {
  const rendered = renderPackTemplate(pack, { template: templateName, language: 'ar', values });
  return [templateName, buildOutboundEmailArtifact({
    recipient: 'billing@example-ae.example', subject: rendered.subject,
    text: rendered.body, language: 'ar', languageResolution: resolution,
    pack, templateName
  })];
});

const bodyFragment = (html) => html.match(/<div style="white-space: pre-wrap">([\s\S]*)<\/div>/)?.[1] || '';
const cards = artifacts.map(([templateName, artifact]) => `
  <article class="message" lang="ar" dir="rtl" data-template="${templateName}">
    <header>
      <span class="template">${templateName}</span>
      <strong>${bidiPlainTextToHtml(artifact.subject)}</strong>
    </header>
    <div class="body">${bodyFragment(artifact.html)}</div>
    <footer>ar-AE · AE pack v5 · ${artifact.contentFingerprint}</footer>
  </article>`).join('\n');

const matrixHtml = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AR-4F AE Arabic email matrix</title>
  <style>
    @font-face { font-family: "Donna Noto Sans Arabic"; src: url("../../server/donna/outbound/fonts/NotoSansArabic-wdth-wght.ttf") format("truetype"); font-display: block; }
    :root { font-family: "Donna Noto Sans Arabic", Arial, sans-serif; color: #14213d; background: #edf2f7; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; }
    main { width: min(960px, 100%); margin-inline: auto; display: grid; gap: 20px; }
    h1 { margin: 0; font-size: 24px; }
    .meta { direction: ltr; text-align: left; color: #52606d; font: 12px/1.5 ui-monospace, monospace; }
    .message { background: white; border: 1px solid #cbd5e1; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px #1f29370f; }
    header { display: grid; gap: 8px; padding: 16px 18px; background: #f8fafc; border-block-end: 1px solid #e2e8f0; }
    header strong { font-size: 16px; line-height: 1.65; }
    .template { direction: ltr; text-align: left; color: #475569; font: 11px/1.4 ui-monospace, monospace; }
    .body { white-space: pre-wrap; padding: 18px; line-height: 1.9; overflow-wrap: anywhere; }
    footer { direction: ltr; text-align: left; padding: 10px 18px; border-block-start: 1px solid #e2e8f0; color: #64748b; font: 10px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
    bdi { unicode-bidi: isolate; }
    @media (max-width: 480px) { body { padding: 10px; } main { gap: 12px; } .body, header { padding: 13px; } footer { padding: 9px 13px; } }
  </style>
</head>
<body>
  <main>
    <h1>مصفوفة رسائل دونا العربية — إصدار تجريبي</h1>
    <div class="meta">AR-4F · 7/7 shipping email families · generated by production renderers · no external send</div>
${cards}
  </main>
</body>
</html>
`;
await writeFile(path.join(outputDirectory, 'email-matrix.html'), matrixHtml);
await writeFile(
  path.join(outputDirectory, 'email-matrix-zoom-200.html'),
  matrixHtml.replace('<body>', '<body style="zoom: 2">')
);
await writeFile(path.join(outputDirectory, 'email-logical-text.json'), JSON.stringify(
  Object.fromEntries(artifacts.map(([name, artifact]) => [name, {
    subject: stripBidiControls(artifact.subject),
    body: artifact.logicalText,
    content_fingerprint: artifact.contentFingerprint,
    delivery_contract_fingerprint: artifact.deliveryContractFingerprint
  }])), null, 2
) + '\n');

const invoiceValues = {
  ...values,
  lines_block: bidiSafeRenderValues({
    lines_block: Array.from({ length: 42 }, (_, index) => (
      `خدمات استشارية مفصلة للبند ${index + 1} — 1 × ${index === 0 ? '-12,345.67' : index === 1 ? '0.00' : '1,234.56'} = ${index === 0 ? '-12,345.67' : index === 1 ? '0.00' : '1,234.56'} AED`
    )).join('\n')
  }, { force: true }).lines_block
};
for (const [filename, documentTitle, renderValues] of [
  ['invoice-registered.pdf', 'فاتورة ضريبية', values],
  ['invoice-unregistered.pdf', 'فاتورة', values],
  ['invoice-long.pdf', 'فاتورة ضريبية', invoiceValues]
]) {
  const artifact = await renderInvoicePdfArtifact({
    pack, language: 'ar',
    values: { ...renderValues, document_title: bidiSafeRenderValues({ document_title: documentTitle }, { force: true }).document_title }
  });
  await writeFile(path.join(outputDirectory, filename), artifact.content);
}
const quote = await renderQuotePdfArtifact({ pack, language: 'ar', values });
await writeFile(path.join(outputDirectory, 'quote.pdf'), quote.content);

console.log(outputDirectory);
