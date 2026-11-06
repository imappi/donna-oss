// Appliance fixture documents (RT-06). Seven synthetic PDFs rendered from ONE
// declared world (world.json) by the existing world renderer
// (server/donna/world/worldRenderer.js): a supplier bill with a discount
// line, a processor payout statement, a two-line bank statement, a retail
// receipt, and (RT-18) a marketplace payout whose printed figures do not
// foot, a counter deposit slip and the September statement carrying its
// credit. The Desert Rose PDFs are not in the repo; these are the stand-ins
// every RT-* fixture uploads through the real routes.
//
// Boundary note. Non-test code under server/ may not import the world
// package (worldBoundary.test.js: `world_must_only_enter_through_runner`),
// so this module never imports the renderer. The rendered bytes are
// COMMITTED next to world.json together with receipts.json (sha256 per
// artifact + the renderer version), and the renderer is passed IN by the
// caller for the two operations that need it: `verifyApplianceFixtures`
// (the demo suite re-renders the world and proves the committed bytes are
// the renderer's, byte for byte) and `writeApplianceFixtures` (regenerate
// after editing world.json — run the demo suite with
// DONNA_APPLIANCE_FIXTURES_WRITE=1). Tests are exempt from the boundary, so
// the demo suite is where the renderer enters.
//
// The world is the oracle: `expected` on each fixture is what the document
// SAYS (amounts, dates, parties). A fixture asserts the runtime's persisted
// rows against these, never against the recorded provider body — the
// recording is what the model said; the world is what is true.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPLIANCE_FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APPLIANCE_FIXTURE_WORLD_PATH = path.join(APPLIANCE_FIXTURES_DIR, 'world.json');
export const APPLIANCE_FIXTURE_RECEIPTS_PATH = path.join(APPLIANCE_FIXTURES_DIR, 'receipts.json');

// name → how it is uploaded (filename / declared type / mime) and what the
// document says. Filenames are chosen deliberately: the supplier bill and
// the bank statement match the SPA's filename classifier
// (src/lib/firmDocuments.js classifyDocumentFile); the two payout reports
// match NO regex there (audit §9 fixture 4 — the router, not the filename,
// must classify them); the receipt matches the receipt branch.
export const APPLIANCE_FIXTURES = Object.freeze({
  supplier_bill_discount: Object.freeze({
    artifactId: 'artifact/supplier-bill',
    file: 'ochre-lighting-supplier-invoice-OL-2026-0812.pdf',
    mimeType: 'application/pdf',
    documentType: 'supplier_bill',
    expected: Object.freeze({
      vendor_name: 'Ochre Lighting',
      reference_number: 'OL-2026-0812',
      document_date: '2026-08-12',
      due_date: '2026-09-11',
      currency: 'GBP',
      subtotal_amount: 550,
      discount_amount: 27.5,
      tax_amount: 27.5,
      total_amount: 550,
      line_count: 2
    })
  }),
  payout_statement: Object.freeze({
    artifactId: 'artifact/payout-statement',
    file: 'paylink-PO-88121-2026-08-18.pdf',
    mimeType: 'application/pdf',
    // Upload-time type as the SPA would send it for a filename its
    // classifier does not recognise.
    documentType: 'unknown',
    expected: Object.freeze({
      counterparty_name: 'PayLink',
      reference_number: 'PO-88121',
      document_date: '2026-08-18',
      period_start: '2026-08-11',
      period_end: '2026-08-17',
      currency: 'GBP',
      gross_amount: 1250,
      fee_amount: 36.25,
      net_amount: 1213.75,
      transaction_count: 23,
      bank_last4: '5678',
      // RT-18: the payout / deposit-slip family — its own document type,
      // read by the payout extractor as gross → fees → net (before RT-18
      // the router carried it as payment_confirmation/ar ⇒ issued_receipt).
      document_type: 'payout_statement',
      direction: 'incoming',
      line_count: 2,
      router_family: 'payout_statement',
      router_direction: 'ar'
    })
  }),
  // RT-18 acceptance fixture (c): a marketplace payout whose PRINTED lines do
  // not foot — the world's settlement carries a 44.00 promotional
  // co-funding deduction the statement omits, so gross − commission − VAT
  // on commission = 1,634 while the printed net is 1,590. The totals
  // receipt must carry that drift; the owner ask is RT-10's lane.
  payout_statement_nonfooting: Object.freeze({
    artifactId: 'artifact/payout-statement-nonfooting',
    file: 'northgate-marketplace-payout-NM-2026-0825-771.pdf',
    mimeType: 'application/pdf',
    documentType: 'unknown',
    expected: Object.freeze({
      counterparty_name: 'Northgate Marketplace',
      reference_number: 'NM-2026-0825-771',
      document_date: '2026-08-25',
      currency: 'GBP',
      gross_amount: 2150,
      fee_amount: 430,
      fee_tax_amount: 86,
      printed_sum: 1634,
      net_amount: 1590,
      drift: -44,
      seller_tax_id: 'GB 456 7890 12',
      buyer_tax_id: 'GB 987 6543 21',
      document_type: 'payout_statement',
      direction: 'incoming',
      line_count: 2,
      router_family: 'payout_statement',
      router_direction: 'ar'
    })
  }),
  bank_statement_two_lines: Object.freeze({
    artifactId: 'artifact/bank-statement',
    file: 'kestrel-print-barclays-statement-2026-08.pdf',
    mimeType: 'application/pdf',
    documentType: 'bank_statement',
    expected: Object.freeze({
      currency: 'GBP',
      period_start: '2026-08-01',
      period_end: '2026-08-31',
      opening_balance: 2400,
      closing_balance: 3063.75,
      transactions: Object.freeze([
        Object.freeze({ date: '2026-08-19', description: 'PAYLINK PAYOUT PO-88121', money_in: 1213.75, money_out: 0 }),
        Object.freeze({ date: '2026-08-20', description: 'OCHRE LIGHTING LTD OL-2026-0812', money_in: 0, money_out: 550 })
      ])
    })
  }),
  // RT-18 acceptance fixture (b): a counter deposit slip (cash + one cheque)
  // and the September statement whose one line is the deposit credit.
  deposit_slip: Object.freeze({
    artifactId: 'artifact/deposit-slip',
    file: 'barclays-counter-deposit-DS-4471-2026-09-03.pdf',
    mimeType: 'application/pdf',
    documentType: 'unknown',
    expected: Object.freeze({
      counterparty_name: 'Barclays',
      reference_number: 'DS-4471',
      document_date: '2026-09-03',
      currency: 'GBP',
      cash_amount: 1200,
      cheque_amount: 1800,
      net_amount: 3000,
      document_type: 'deposit_slip',
      direction: 'incoming',
      line_count: 2,
      router_family: 'deposit_slip',
      router_direction: 'ar'
    })
  }),
  bank_statement_deposit: Object.freeze({
    artifactId: 'artifact/bank-statement-sep',
    file: 'kestrel-print-barclays-statement-2026-09.pdf',
    mimeType: 'application/pdf',
    documentType: 'bank_statement',
    expected: Object.freeze({
      currency: 'GBP',
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      opening_balance: 3063.75,
      closing_balance: 6063.75,
      transactions: Object.freeze([
        // No slip reference on the statement (as the bank prints it) — the
        // case the deterministic exact-reference tier cannot claim.
        Object.freeze({ date: '2026-09-03', description: 'COUNTER CREDIT YORK PARLIAMENT ST', money_in: 3000, money_out: 0 })
      ])
    })
  }),
  receipt_screwfix: Object.freeze({
    artifactId: 'artifact/receipt',
    file: 'screwfix-receipt-2026-08-22.pdf',
    mimeType: 'application/pdf',
    documentType: 'receipt',
    expected: Object.freeze({
      vendor_name: 'Screwfix',
      reference_number: '4471-2208-0193',
      document_date: '2026-08-22',
      currency: 'GBP',
      subtotal_amount: 35.82,
      tax_amount: 7.17,
      total_amount: 42.99,
      line_count: 2
    })
  })
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const loadApplianceFixtureWorld = () => JSON.parse(readFileSync(APPLIANCE_FIXTURE_WORLD_PATH, 'utf8'));

export const loadApplianceFixtureReceipts = () => JSON.parse(readFileSync(APPLIANCE_FIXTURE_RECEIPTS_PATH, 'utf8'));

export const listApplianceFixtures = () => Object.keys(APPLIANCE_FIXTURES);

// The committed bytes plus the world's claim about them. Throws when the
// bytes do not match receipts.json — a fixture edited by hand, or a
// world.json edit whose regeneration was forgotten, fails here before any
// runtime assertion can be misread.
export const loadApplianceFixture = (name) => {
  const spec = APPLIANCE_FIXTURES[name];
  if (!spec) throw new Error(`unknown appliance fixture "${name}" (have: ${listApplianceFixtures().join(', ')})`);
  const bytes = readFileSync(path.join(APPLIANCE_FIXTURES_DIR, spec.file));
  const digest = sha256(bytes);
  const receipt = loadApplianceFixtureReceipts().artifacts?.[spec.artifactId] || null;
  if (!receipt || receipt.sha256 !== digest) {
    throw new Error(
      `appliance fixture ${name} (${spec.file}) does not match receipts.json `
      + `(committed ${digest.slice(0, 12)}, receipt ${receipt?.sha256?.slice(0, 12) || 'missing'}); `
      + 'regenerate with DONNA_APPLIANCE_FIXTURES_WRITE=1 on the demo suite'
    );
  }
  return Object.freeze({
    name,
    artifactId: spec.artifactId,
    filename: spec.file,
    mimeType: spec.mimeType,
    documentType: spec.documentType,
    expected: spec.expected,
    bytes,
    sha256: digest,
    receipt
  });
};

// Render the world through the injected renderer and return artifactId →
// { bytes, sha256, rendererVersion, frozenDate }.
export const renderApplianceFixtures = async ({ renderWorldArtifacts } = {}) => {
  if (typeof renderWorldArtifacts !== 'function') {
    throw new Error('renderApplianceFixtures needs the world renderer injected (renderWorldArtifacts)');
  }
  const world = loadApplianceFixtureWorld();
  const rendered = await renderWorldArtifacts(world);
  if (!rendered?.ok) {
    throw new Error(`appliance fixture world failed to render: ${(rendered?.errors || []).join('; ')}`);
  }
  const byArtifact = {};
  for (const artifact of rendered.artifacts) {
    const bytes = Buffer.from(artifact.contentBase64, 'base64');
    byArtifact[artifact.id] = {
      bytes,
      sha256: sha256(bytes),
      rendererVersion: artifact.rendererVersion,
      frozenDate: artifact.frozenDate,
      format: artifact.format
    };
  }
  for (const [name, spec] of Object.entries(APPLIANCE_FIXTURES)) {
    if (!byArtifact[spec.artifactId]) throw new Error(`world.json renders no artifact for fixture ${name} (${spec.artifactId})`);
    if (byArtifact[spec.artifactId].format !== 'pdf') throw new Error(`fixture ${name} must render as pdf`);
  }
  return { world, rendered, byArtifact };
};

// Compare the committed files against a fresh render. Returns
// { ok, mismatches: [{ name, file, committed, rendered }] }.
export const verifyApplianceFixtures = async ({ renderWorldArtifacts } = {}) => {
  const { byArtifact, rendered } = await renderApplianceFixtures({ renderWorldArtifacts });
  const receipts = loadApplianceFixtureReceipts();
  const mismatches = [];
  for (const [name, spec] of Object.entries(APPLIANCE_FIXTURES)) {
    const fresh = byArtifact[spec.artifactId];
    let committed = null;
    try {
      committed = sha256(readFileSync(path.join(APPLIANCE_FIXTURES_DIR, spec.file)));
    } catch {
      committed = null;
    }
    const receipt = receipts.artifacts?.[spec.artifactId]?.sha256 || null;
    if (committed !== fresh.sha256 || receipt !== fresh.sha256) {
      mismatches.push({ name, file: spec.file, committed, receipt, rendered: fresh.sha256 });
    }
  }
  if (receipts.renderer_version !== rendered.version) {
    mismatches.push({ name: 'renderer_version', committed: receipts.renderer_version, rendered: rendered.version });
  }
  return { ok: mismatches.length === 0, mismatches };
};

// Regenerate the committed PDFs + receipts.json from world.json.
export const writeApplianceFixtures = async ({ renderWorldArtifacts } = {}) => {
  const { world, rendered, byArtifact } = await renderApplianceFixtures({ renderWorldArtifacts });
  const artifacts = {};
  for (const [name, spec] of Object.entries(APPLIANCE_FIXTURES)) {
    const fresh = byArtifact[spec.artifactId];
    writeFileSync(path.join(APPLIANCE_FIXTURES_DIR, spec.file), fresh.bytes);
    artifacts[spec.artifactId] = {
      fixture: name,
      file: spec.file,
      sha256: fresh.sha256,
      byte_length: fresh.bytes.length,
      frozen_date: fresh.frozenDate
    };
  }
  const receipts = {
    world_id: world.worldId,
    world_seed: world.seed,
    renderer_version: rendered.version,
    artifacts
  };
  writeFileSync(APPLIANCE_FIXTURE_RECEIPTS_PATH, `${JSON.stringify(receipts, null, 2)}\n`);
  return receipts;
};
