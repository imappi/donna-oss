// Tests for the intake-document → pipeline routing (intakeUpload.js).
// Pure-node harness in the uploadTray.test.js style — the orchestrator
// takes injected deps so no DOM, network, or localStorage is needed.

import {
  pipelineDocumentTypeForIntake,
  resolvePipelineMimeType,
  routeIntakeDocumentToPipeline
} from './intakeUpload.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  const report = (err) => {
    if (err) {
      failed += 1;
      console.error(`  fail ${name}`);
      console.error(`       ${err?.message || err}`);
    } else {
      passed += 1;
      console.log(`  ok  ${name}`);
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => report(null), report);
    }
    report(null);
  } catch (err) {
    report(err);
  }
  return Promise.resolve();
};

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// %PDF in base64.
const PDF_BASE64 = 'JVBERi0xLjQKJcfs';

const makeTrayDeps = () => {
  const calls = [];
  return {
    calls,
    tray: {
      startTrayBatch: (args) => {
        calls.push(['startTrayBatch', args]);
        return {
          batches: [
            { id: args.batchId, rows: [{ row_id: `${args.batchId}-0` }] }
          ]
        };
      },
      setRowUploaded: (args) => calls.push(['setRowUploaded', args]),
      setRowUploadFailed: (args) => calls.push(['setRowUploadFailed', args]),
      setRowRegistered: (args) => calls.push(['setRowRegistered', args]),
      setRowRegisterFailed: (args) => calls.push(['setRowRegisterFailed', args])
    }
  };
};

const STORED = {
  provider: 'supabase_storage',
  bucket: 'donna-evidence',
  key: 'firm/client/abc.pdf',
  checksum_sha256: 'feedbeef',
  size: 12,
  content_type: 'application/pdf'
};

const run = async () => {
  // ── resolvePipelineMimeType ─────────────────────────────────────────

  await test('PDF bytes outrank a wrong declared mime', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: PDF_BASE64, mimeType: 'image/png', filename: 'scan.png' }),
      'application/pdf',
      'byte sniff'
    );
  });

  await test('PDF bytes rescue an empty mime', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: PDF_BASE64, mimeType: '', filename: 'statement' }),
      'application/pdf',
      'byte sniff, no mime, no extension'
    );
  });

  await test('declared allowlisted mime is kept for non-PDF bytes', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: 'iVBORw0KGgo=', mimeType: 'image/png', filename: 'photo.png' }),
      'image/png',
      'declared png'
    );
  });

  await test('extension fallback when mime is octet-stream', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: 'abcd', mimeType: 'application/octet-stream', filename: 'IMG_1.jpeg' }),
      'image/jpeg',
      'extension jpeg'
    );
  });

  await test('text files have no pipeline path', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: 'abcd', mimeType: 'text/plain', filename: 'notes.txt' }),
      null,
      'txt'
    );
  });

  // ── CSV intake (design-donna-csv-statement-intake.md §3) ────────────

  await test('declared text/csv is allowlisted', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: 'abcd', mimeType: 'text/csv', filename: 'statement.csv' }),
      'text/csv',
      'declared csv'
    );
  });

  await test('the Windows/Excel vnd.ms-excel trap normalizes via the .csv extension', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: 'abcd', mimeType: 'application/vnd.ms-excel', filename: 'Bank Export.CSV' }),
      'text/csv',
      'vnd.ms-excel + .csv'
    );
    assertEqual(
      resolvePipelineMimeType({ base64: 'abcd', mimeType: 'application/octet-stream', filename: 'export.csv' }),
      'text/csv',
      'octet-stream + .csv'
    );
  });

  await test('a true .xls stays out (the trap fix admits only .csv)', () => {
    assertEqual(
      resolvePipelineMimeType({ base64: 'abcd', mimeType: 'application/vnd.ms-excel', filename: 'report.xls' }),
      null,
      'xls'
    );
  });

  // ── pipelineDocumentTypeForIntake ───────────────────────────────────

  await test('model document_kind bank_statement outranks a receipt-looking filename', () => {
    assertEqual(
      pipelineDocumentTypeForIntake({ documentKind: 'bank_statement', filename: 'expense receipt.pdf' }),
      'bank_statement',
      'kind wins'
    );
  });

  await test('registry_extract maps to statutory_record', () => {
    assertEqual(
      pipelineDocumentTypeForIntake({ documentKind: 'registry_extract', filename: 'companies-house.pdf' }),
      'statutory_record',
      'registry'
    );
  });

  await test('utility_bill maps to supplier_bill', () => {
    assertEqual(
      pipelineDocumentTypeForIntake({ documentKind: 'utility_bill', filename: 'power.pdf' }),
      'supplier_bill',
      'utility'
    );
  });

  await test('invoice_or_bill keeps the filename direction when it has one', () => {
    assertEqual(
      pipelineDocumentTypeForIntake({ documentKind: 'invoice_or_bill', filename: 'INV-2026-001.pdf' }),
      'sales_invoice',
      'AR by filename'
    );
  });

  await test('invoice_or_bill defaults to supplier_bill without a direction signal', () => {
    assertEqual(
      pipelineDocumentTypeForIntake({ documentKind: 'invoice_or_bill', filename: 'document.pdf' }),
      'supplier_bill',
      'AP default'
    );
  });

  await test('unmapped kinds fall back to the filename classifier', () => {
    assertEqual(
      pipelineDocumentTypeForIntake({ documentKind: 'other', filename: 'DBS statement June.pdf' }),
      'bank_statement',
      'filename fallback'
    );
    assertEqual(
      pipelineDocumentTypeForIntake({ documentKind: 'tax_notice', filename: 'mystery.pdf' }),
      'unknown',
      'honest unknown'
    );
  });

  // ── routeIntakeDocumentToPipeline ───────────────────────────────────

  await test('happy path: upload → register, tray rows in lockstep', async () => {
    const { calls, tray } = makeTrayDeps();
    const registered = { id: 'doc-x', parse_status: 'pending' };
    let uploadArgs = null;
    let registerArgs = null;
    const result = await routeIntakeDocumentToPipeline(
      {
        clientId: 'honeybee-hills-apiary-llc',
        filename: 'Honeybee_Statement_Q2.pdf',
        base64: PDF_BASE64,
        mimeType: '',
        documentKind: 'bank_statement'
      },
      {
        upload: async (args) => {
          uploadArgs = args;
          return STORED;
        },
        register: async (args) => {
          registerArgs = args;
          return { documents: [registered] };
        },
        tray
      }
    );
    assertEqual(result.routed, true, 'routed');
    assertEqual(uploadArgs.mimeType, 'application/pdf', 'upload mime resolved from bytes');
    assertEqual(uploadArgs.clientId, 'honeybee-hills-apiary-llc', 'upload client');
    const doc = registerArgs.documents[0];
    assertEqual(doc.client_id, 'honeybee-hills-apiary-llc', 'register client');
    assertEqual(doc.document_type, 'bank_statement', 'register type from model kind');
    assertEqual(doc.source, 'firm_intake', 'register source');
    assertEqual(doc.storage_bucket, STORED.bucket, 'register bucket');
    assertEqual(doc.storage_object_key, STORED.key, 'register key');
    assertEqual(doc.checksum_sha256, STORED.checksum_sha256, 'register checksum');
    assertEqual(typeof doc.batch_id, 'string', 'batch id present');
    assertEqual(doc.id.startsWith('doc-'), true, 'document id shape');
    assertEqual(
      calls.map(([name]) => name).join(','),
      'startTrayBatch,setRowUploaded,setRowRegistered',
      'tray call order'
    );
    assertEqual(calls[2][1].document, registered, 'registered doc reaches the tray');
  });

  await test('storage failure marks the tray row and never registers', async () => {
    const { calls, tray } = makeTrayDeps();
    let registerCalled = false;
    const result = await routeIntakeDocumentToPipeline(
      { clientId: 'c1', filename: 'a.pdf', base64: PDF_BASE64, documentKind: 'other' },
      {
        upload: async () => {
          throw new Error('storage down');
        },
        register: async () => {
          registerCalled = true;
          return { documents: [] };
        },
        tray
      }
    );
    assertEqual(result.routed, false, 'not routed');
    assertEqual(result.reason, 'upload_failed', 'reason');
    assertEqual(registerCalled, false, 'register not called');
    assertEqual(
      calls.map(([name]) => name).join(','),
      'startTrayBatch,setRowUploadFailed',
      'tray call order'
    );
    assertEqual(calls[1][1].message, 'storage down', 'failure message surfaced');
  });

  await test('register failure marks the row for the orphan-retry path', async () => {
    const { calls, tray } = makeTrayDeps();
    const result = await routeIntakeDocumentToPipeline(
      { clientId: 'c1', filename: 'a.pdf', base64: PDF_BASE64, documentKind: 'other' },
      {
        upload: async () => STORED,
        register: async () => {
          throw new Error('register 503');
        },
        tray
      }
    );
    assertEqual(result.routed, false, 'not routed');
    assertEqual(result.reason, 'register_failed', 'reason');
    assertEqual(
      calls.map(([name]) => name).join(','),
      'startTrayBatch,setRowUploaded,setRowRegisterFailed',
      'storage key reached the tray before the failure'
    );
  });

  await test('unsupported source types are skipped without touching the tray', async () => {
    const { calls, tray } = makeTrayDeps();
    const result = await routeIntakeDocumentToPipeline(
      { clientId: 'c1', filename: 'notes.txt', base64: 'aGVsbG8=', mimeType: 'text/plain', documentKind: 'other' },
      { upload: async () => STORED, register: async () => ({ documents: [] }), tray }
    );
    assertEqual(result.routed, false, 'not routed');
    assertEqual(result.reason, 'unsupported_file_type', 'reason');
    assertEqual(calls.length, 0, 'no tray rows');
  });

  await test('missing inputs are skipped', async () => {
    const { calls, tray } = makeTrayDeps();
    const result = await routeIntakeDocumentToPipeline(
      { clientId: '', filename: 'a.pdf', base64: PDF_BASE64 },
      { upload: async () => STORED, register: async () => ({ documents: [] }), tray }
    );
    assertEqual(result.routed, false, 'not routed');
    assertEqual(result.reason, 'missing_input', 'reason');
    assertEqual(calls.length, 0, 'no tray rows');
  });

  console.log(`\nintakeUpload: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
};

run();
