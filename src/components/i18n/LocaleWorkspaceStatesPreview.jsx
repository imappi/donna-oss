import { useState } from 'react';
import { useIntl } from 'react-intl';

import DonnaClientPortal from '../donna-client-portal.jsx';
import DocumentArtifact from '../financials/document-artifact.jsx';
import FinancialReportWorkspace from '../financials/financial-report-workspace.jsx';
import FinancialsReportArtifact from '../financials/financials-report-artifact.jsx';
import TransactionArtifact from '../financials/transaction-artifact.jsx';
import FeedChat from '../financials/feed-chat.jsx';
import {
  PeriodHeader,
  PeriodTransactionRow
} from '../financials/donna-financials-panel.jsx';
import { BANK_FEED_SECTION_STYLE } from '../shared/bank-feed-list-style.js';
import { D, T } from '../shared/design-tokens.js';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import { IdentifierText } from '../../i18n/BidiText.jsx';

const PREVIEW_PERIOD = {
  monthKey: '2026-08',
  label: 'August 2026',
  ownerRows: [],
  openRows: [],
  documentRows: [],
  reconciledRows: [],
  closePeriod: { id: 'close-period-preview' },
  closed: false,
  closeStatus: 'ready',
  counts: { needsInput: 1, processing: 2, stalled: 0, reconciled: 1, remaining: 3 }
};

const OWNER_ROW = {
  source_id: 'owner-decision-preview',
  transaction_id: 'tx-preview-001',
  transaction_date: '2026-08-14',
  descriptor: 'شركة النور للتجارة · INV-2026-001',
  amount: -25,
  currency: 'AED',
  reason: 'No supporting document or transfer match found.',
  verdict: { blocks_close: true }
};

const RECONCILED_ROW = {
  id: 'tx-preview-002',
  transaction_date: '2026-08-18',
  desc: 'Al Noor Trading LLC · فاتورة ضريبية',
  amount: 'AED 1,234.56',
  cat: 'Input VAT · ضريبة المدخلات'
};

const PREVIEW_CLIENT = {
  id: 'client-preview-ae',
  companyName: 'شركة النور للتجارة LLC',
  contactName: 'مريم الكعبي',
  profile: { services_engaged: [] },
  services_engaged: []
};

const PORTAL_CLIENT = {
  jurisdiction: 'gb',
  id: 'client-preview-portal-gb',
  companyName: 'شركة النور للتجارة · Al Noor Trading Ltd',
  contactName: 'مريم الكعبي · Maryam Al Kaabi',
  registrationNumber: 'GB-CRN-09482048',
  profile: {
    jurisdiction: 'gb',
    entity_type: 'gb-ltd',
    incorporation_date: '2021-04-12',
    accounting_system: 'qbo',
    services_engaged: [
      'bank_reconciliation',
      'sales_invoicing',
      'bills_and_expenses',
      'payroll',
      'loan_tracking'
    ],
    gb: {
      vat_stagger: 1,
      confirmation_review_period_end: '2026-04-30',
      accounting_period_end: '2026-12-31'
    }
  },
  services_engaged: [
    'bank_reconciliation',
    'sales_invoicing',
    'bills_and_expenses',
    'payroll',
    'loan_tracking'
  ]
};

const PORTAL_DOCUMENTS = [
  {
    id: 'portal-doc-arabic-invoice',
    client_id: PORTAL_CLIENT.id,
    filename: 'INV-2026-001_فاتورة-شركة-النور.pdf',
    document_type: 'supplier_bill',
    parse_status: 'completed',
    file_size: 84217,
    uploaded_at: '2026-08-31T08:12:00Z'
  },
  {
    id: 'portal-doc-latin-statement',
    client_id: PORTAL_CLIENT.id,
    filename: 'HSBC_GB29NWBK60161331926819_Aug-2026.csv',
    document_type: 'bank_statement',
    parse_status: 'processing',
    file_size: 240310,
    uploaded_at: '2026-08-30T16:42:00Z'
  },
  {
    id: 'portal-doc-arabic-receipt',
    client_id: PORTAL_CLIENT.id,
    filename: 'إيصال_TRN-100483729100003_31-08.png',
    document_type: 'receipt',
    parse_status: 'failed',
    file_size: 1300480,
    uploaded_at: '2026-08-29T09:05:00Z'
  }
];

const PORTAL_TRANSACTIONS = [
  {
    id: 'portal-tx-001',
    client_id: PORTAL_CLIENT.id,
    transaction_date: '2026-08-28',
    description: 'شركة النور · REF-INV-2026-001 · IBAN GB29NWBK60161331926819',
    money_in: 0,
    money_out: 1234.56,
    amount: -1234.56,
    currency: 'GBP',
    account_currency: 'GBP'
  }
];

const PORTAL_REQUESTS = [
  {
    id: 'portal-ask-receipt',
    client_id: PORTAL_CLIENT.id,
    transaction_id: 'portal-tx-001',
    evidence_type: 'receipt',
    status: 'open',
    question: 'هل هذا إيصال المورد Al Noor Trading أم دفعة شخصية؟',
    created_at: '2026-08-29T10:00:00Z',
    request_payload: {
      description: 'شركة النور · REF-INV-2026-001 · TRN 100483729100003',
      amount: 1234.56,
      currency: 'GBP',
      date: '2026-08-28',
      evidence_topic: {
        status: 'open',
        channel: 'client_portal',
        current_need: 'Confirm the supplier receipt for REF-INV-2026-001.',
        last_owner_message_at: '2026-08-31T08:13:00Z',
        last_assessment: { outcome: 'clarification_requested' },
        turns: [{ outcome: 'clarification_requested', reply_excerpt: 'أقصد فاتورة شركة النور، not the card receipt.' }]
      }
    }
  },
  {
    id: 'portal-ask-statement',
    client_id: PORTAL_CLIENT.id,
    transaction_id: 'portal-tx-001',
    evidence_type: 'statement',
    status: 'open',
    question: 'Please upload the August statement for the second operating account.',
    created_at: '2026-08-30T10:00:00Z',
    request_payload: {
      account_reference: 'IBAN GB29NWBK60161331926819',
      transaction_description: 'تحويل بين الحسابات · Treasury transfer',
      amount: 25000,
      currency: 'GBP',
      date: '2026-08-30'
    }
  }
];

const PORTAL_MESSAGES = [
  {
    id: 'portal-firm-message-1',
    client_id: PORTAL_CLIENT.id,
    subject: 'VAT review · مراجعة ضريبة القيمة المضافة',
    body: 'Please confirm the TRN 100483729100003 and the invoice reference INV-2026-001.\nيرجى تأكيد رقم التسجيل الضريبي والمرجع.',
    sent_at: '2026-08-31T11:30:00Z',
    from: 'Kari Ledger · كاري'
  }
];

const PORTAL_VAT_ENVELOPE = {
  surface_acts: true,
  refusal: null,
  prepared: {
    period: {
      periodKey: '26A2',
      startsOn: '2026-04-01',
      endsOn: '2026-06-30',
      dueOn: '2026-08-07'
    },
    vatReturn: {
      boxes: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), (index + 1) * 123.45])),
      outcome: 'due',
      netVat: 370.35
    }
  }
};

const PORTAL_CHAT_PREVIEW = {
  open: true,
  reply: 'I found REF-INV-2026-001. This locale preview stays read-only.',
  messages: [
    {
      id: 'portal-chat-user-1',
      role: 'user',
      content: 'هل دفعة INV-2026-001 مرتبطة بفاتورة شركة النور؟',
      created_at: '2026-08-31T08:13:00Z'
    },
    {
      id: 'portal-chat-assistant-1',
      role: 'assistant',
      content: 'The amount and date match Al Noor Trading Ltd. Review the answer before filing it.',
      created_at: '2026-08-31T08:14:00Z',
      payload: {
        actions: [{
          type: 'answer_evidence_request',
          status: 'proposed',
          reply_text: 'هذه فاتورة المورد Al Noor Trading · REF-INV-2026-001.',
          evidence_request_id: 'portal-ask-receipt'
        }]
      }
    }
  ],
  evidenceTopics: [{
    evidence_request_id: 'portal-ask-receipt',
    status: 'open',
    channel: 'client_portal',
    current_need: 'Confirm the receipt for REF-INV-2026-001 and TRN 100483729100003.',
    last_owner_message_at: '2026-08-31T08:13:00Z',
    last_assessment: { outcome: 'clarification_requested' },
    recent_turns: [{ reply_excerpt: 'أقصد فاتورة شركة النور، not the card receipt.' }]
  }],
  ownerIntentCandidates: [{
    proposal_id: 'portal-owner-intent-1',
    status: 'proposed',
    intent_kind: 'answer_evidence_request',
    summary: 'File the owner answer against REF-INV-2026-001 after review.',
    memory_candidate: { status: 'suggested' },
    preflight: {
      status: 'prepared',
      apply_plan: { selected_mutation: { verb: 'answer_evidence_request', writer: 'resolveClientEvidenceRequestInDb' } },
      consequence_diff: { status: 'computed' },
      authority: { status: 'owner_confirmation_required' },
      execution_gate: { status: 'blocked', writer_invoked: false, apply_receipt_required: true },
      blockers: [{ code: 'owner_confirmation_required', detail: 'Owner confirmation is required before this answer is filed.' }]
    }
  }]
};

const PORTAL_PREVIEW_STATE = {
  ownerVatEnvelope: PORTAL_VAT_ENVELOPE,
  whatsAppState: { channel_acts: true, binding: null },
  telegramState: { channel_acts: true, binding: { id: 'telegram-preview', masked_chat_id: '-1002048123456' } },
  activity: {
    filename: 'كشف-حساب_HSBC_GB29NWBK60161331926819_Aug-2026.pdf',
    extension: 'PDF',
    size: 248310,
    transactionCount: 143,
    uploadedAt: '2026-08-31T08:12:00Z'
  }
};

const TRANSACTION_ARTIFACT = {
  type: 'transaction',
  data: {
    previewMode: 'detail',
    clientId: PREVIEW_CLIENT.id,
    transaction: {
      id: 'tx-preview-ae-001',
      client_id: PREVIEW_CLIENT.id,
      transaction_date: '2026-08-18',
      description: 'شركة النور للتجارة · INV-2026-001',
      money_in: 0,
      money_out: 1234.56,
      account_currency: 'AED',
      reconciliation_status: 'reconciled'
    },
    match: {
      id: 'match-preview-ae-001',
      status: 'auto_matched',
      match_amount: 1234.56,
      match_currency: 'AED',
      payload: {
        match_reason: {
          confidence: 0.98,
          reasoning: 'The amount, date and invoice reference agree with the recorded bank line.',
          hops: ['amount_exact', 'date_close', 'reference_INV-2026-001']
        }
      }
    },
    matchedDocument: {
      id: 'doc-preview-ae-001',
      filename: 'INV-2026-001_فاتورة-شركة-النور.pdf',
      vendor_name: 'شركة النور للتجارة LLC',
      document_type: 'supplier_bill',
      total_amount: 1234.56,
      currency: 'AED',
      document_date: '2026-08-18'
    },
    previewAuditSnapshot: {
      timeline: {
        present: true,
        terminal: { present: true, state: 'auto_reconciled', reason: 'matched_and_posted' },
        events: [
          {
            kind: 'document_received',
            density: 'owner',
            actor: 'owner',
            actor_name: 'مريم الكعبي',
            at: '2026-08-18T08:14:03Z',
            fields: {
              filename: 'INV-2026-001_فاتورة-شركة-النور.pdf',
              source: 'client_portal'
            }
          },
          {
            kind: 'match',
            density: 'owner',
            actor: 'donna',
            at: '2026-08-18T08:15:10Z',
            fields: {
              summary: 'Matched to invoice INV-2026-001 from شركة النور.',
              confidence: 0.98,
              authority: 'auto_matched'
            }
          },
          {
            kind: 'audit',
            density: 'owner',
            actor: 'firm',
            actor_name: 'Kari Ledger',
            at: '2026-08-18T08:17:40Z',
            fields: { action: 'ledger.post_transaction' }
          }
        ],
        gaps: []
      },
      case_health: {
        present: true,
        phase: 'finished',
        convergence: { state: 'auto_reconciled' },
        blocker: null,
        owner_question: null,
        recovery: { class: 'yes', basis: 'ledger_receipt' },
        missing_evidence: [],
        integration_failures: [],
        gaps: []
      }
    }
  }
};

const DOCUMENT_ROW = {
  id: 'doc-preview-ae-001',
  client_id: PREVIEW_CLIENT.id,
  filename: 'INV-2026-001_فاتورة-شركة-النور.pdf',
  original_filename: 'INV-2026-001_فاتورة-شركة-النور.pdf',
  document_type: 'supplier_bill',
  vendor_name: 'شركة النور للتجارة LLC',
  total_amount: 1234.56,
  tax_amount: 58.79,
  currency: 'AED',
  document_date: '2026-08-18',
  reference_number: 'INV-2026-001',
  status: 'ready'
};

const DOCUMENT_TRANSACTIONS = [
  {
    id: 'tx-preview-ae-001',
    client_id: PREVIEW_CLIENT.id,
    transaction_date: '2026-08-18',
    description: 'شركة النور للتجارة · INV-2026-001',
    money_in: 0,
    money_out: 1234.56,
    account_currency: 'AED',
    reconciliation_status: 'unmatched'
  },
  {
    id: 'tx-preview-ae-002',
    client_id: PREVIEW_CLIENT.id,
    transaction_date: '2026-08-20',
    description: 'Al Noor Trading LLC · office equipment',
    money_in: 0,
    money_out: 1230,
    account_currency: 'AED',
    reconciliation_status: 'unmatched'
  }
];

const DOCUMENT_MATCH = {
  id: 'match-preview-document-ae-001',
  matched_object_id: DOCUMENT_ROW.id,
  bank_transaction_id: DOCUMENT_TRANSACTIONS[0].id,
  status: 'auto_matched',
  match_confidence: 0.98
};

const REPORT_PREVIEW = {
  source: 'donna_ledger',
  client_id: PREVIEW_CLIENT.id,
  period_start: '2026-08-01',
  period_end: '2026-08-31',
  as_of: '2026-08-31',
  basis: 'accrual',
  currency: { presentation: 'AED', currencies: ['AED'], mixed: false },
  profit_and_loss: {
    accounts: [
      { id: 'report-revenue', account_label: 'إيرادات الاستشارات · Consulting revenue', section: 'revenue', revenue: 15000, expense: 0, net: 15000, currency: 'AED' },
      { id: 'report-expense', account_label: 'مستلزمات المكتب · Office supplies', section: 'expense', revenue: 0, expense: 6500, net: -6500, currency: 'AED' }
    ],
    revenue: 15000,
    expenses: 6500,
    net_income: 8500
  },
  balance_sheet: {
    as_of: '2026-08-31',
    assets: {
      accounts: [
        { id: 'report-bank', account_label: 'بنك الإمارات NBD · AED 001', amount: 8500, currency: 'AED' },
        { id: 'report-unclassified', account_label: 'INV-2026-001 · مصروف غير مصنف', amount: 250, currency: 'AED', unclassified: true }
      ]
    },
    liabilities: {
      accounts: [{ id: 'report-vat', account_label: 'ضريبة القيمة المضافة · Output VAT', amount: 2000, currency: 'AED' }]
    },
    equity: {
      accounts: [{ id: 'report-equity', name: 'Retained earnings · أرباح محتجزة', amount: 6250, currency: 'AED', synthetic: true }]
    },
    unclassified: { accounts: [{ id: 'report-unclassified' }], total: 250 },
    total_assets: 8750,
    total_liabilities: 2000,
    total_equity: 6250,
    total_liabilities_and_equity: 8250,
    imbalance: 500,
    balanced: false
  },
  trial_balance: {
    accounts: [
      { id: 'report-bank', account_label: 'بنك الإمارات NBD · AED 001', balance: 8500, debit_balance: 8500, credit_balance: 0, currency: 'AED' },
      { id: 'report-revenue', account_label: 'إيرادات الاستشارات · Consulting revenue', balance: 15000, debit_balance: 0, credit_balance: 15000, currency: 'AED' },
      { id: 'report-expense', account_label: 'مستلزمات المكتب · Office supplies', balance: 6000, debit_balance: 6000, credit_balance: 0, currency: 'AED' }
    ],
    total_debit: 14500,
    total_credit: 15000,
    imbalance: -500,
    balanced: false
  },
  cash: {
    accounts: [{ id: 'report-bank', account_label: 'بنك الإمارات NBD · AED 001', balance: 8500, currency: 'AED' }],
    total: 8500
  },
  draft: {
    is_draft: true,
    period_closed: false,
    stamp: 'DRAFT',
    reasons: [
      { code: 'ledger_imbalance', detail: 'Ledger debits and credits differ by -500.' },
      { code: 'balance_sheet_imbalance', detail: 'Balance sheet does not foot by 500.' },
      { code: 'unclassified_accounts', detail: '1 account not yet classified (250).', count: 1, amount: 250 },
      { code: 'unposted_transactions', detail: '2 transactions not yet posted to the ledger.', count: 2 },
      { code: 'pending_questions', detail: '1 item awaiting client evidence or review.', count: 1 },
      { code: 'preview_unknown', detail: 'مراجعة مرجع INV-2026-001 مع مريم الكعبي.' }
    ]
  }
};

const REPORT_ARTIFACT = {
  type: 'financials',
  data: {
    clientId: PREVIEW_CLIENT.id,
    period: '2026-08',
    previewReport: REPORT_PREVIEW,
    onDownloadReport: async () => ({ ok: true })
  }
};

const REPORT_COMPACT_ARTIFACT = {
  type: 'financials',
  data: {
    clientId: PREVIEW_CLIENT.id,
    period: '2026-08',
    previewSnapshot: {
      trial_balance: REPORT_PREVIEW.trial_balance,
      profit_and_loss: REPORT_PREVIEW.profit_and_loss,
      cash: REPORT_PREVIEW.cash
    }
  }
};

const DOCUMENT_CONVERSATION = [
  {
    id: 'document-chat-preview-system',
    role: 'system',
    content: 'تم تحديث حالة المطابقة من السجل المحفوظ.',
    created_at: '2026-08-31T08:12:00Z',
    payload: {}
  },
  {
    id: 'document-chat-preview-user',
    role: 'user',
    content: 'اربط هذه الفاتورة بالدفع INV-2026-001، ثم اترك ملاحظة للمراجعة.',
    created_at: '2026-08-31T08:13:00Z',
    payload: {}
  },
  {
    id: 'document-chat-preview-assistant',
    role: 'assistant',
    content: 'راجعت **INV-2026-001**. المبلغ والتاريخ واسم شركة النور تتطابق مع حركة البنك المحددة.',
    created_at: '2026-08-31T08:14:00Z',
    payload: {
      actions: [
        {
          type: 'link_transaction',
          status: 'proposed',
          reason: 'الحركة tx-preview-ae-001 تحمل المبلغ والتاريخ نفسيهما.',
          transaction_id: DOCUMENT_TRANSACTIONS[0].id
        },
        {
          type: 'leave_review_note',
          status: 'applied',
          reason: 'تم حفظ سياق القرار للمراجعة اللاحقة.',
          note: 'فاتورة المورد Al Noor Trading مرتبطة بالدفع المؤكد.',
          follow_up_at: '2026-09-01'
        },
        {
          type: 'future_action',
          status: 'proposed',
          reason: 'تقسيم الفاتورة على دفعتين يحتاج مساراً معتمداً.',
          future_type: 'split_match'
        }
      ]
    }
  }
];

const FEED_ACTION_CONVERSATION = [
  {
    id: 'feed-actions-user',
    role: 'user',
    content: 'راجع دفعات شركة النور ثم طبّق التصنيف على INV-2026-001.',
    created_at: '2026-09-01T08:10:00Z',
    payload: {}
  },
  {
    id: 'feed-actions-assistant',
    role: 'assistant',
    content: 'وجدت إجراءات محفوظة لهذه المجموعة. القيم والسلطة أدناه تأتي من الإيصال نفسه.',
    created_at: '2026-09-01T08:11:00Z',
    payload: {
      actions: [
        {
          type: 'apply_category',
          status: 'proposed',
          client_name: 'شركة النور للتجارة LLC',
          role_id: 'accountant',
          transaction_ids: ['tx-preview-ae-001', 'tx-preview-latin-002'],
          account_name: 'معدات مكتبية · Office equipment',
          account_code: '6200',
          tax_treatment: 'VAT 5%',
          reason: 'شركة النور للتجارة · AED 1,234.56 · د.إ ١٬٢٣٤٫٥٦ · (AED 25.00) · INV-2026-001 · TRN 100483729100003 · AE070331234567890123456 · finance@example-ae.example · https://donna.example/INV-2026-001 · فاتورة_INV-2026-001_شركة-النور.pdf'
        },
        {
          type: 'ask_client',
          status: 'applied',
          client_name: 'شركة النور للتجارة LLC',
          transaction_ids: ['tx-preview-ae-003'],
          question: 'هل كانت دفعة CLOUDHOST-42 مصروفاً تجارياً؟',
          evidence_type: 'business_purpose',
          result: {
            applied: 1,
            failed: 0,
            ask_id: 'ask-preview-AR-42',
            results: [{ transaction_id: 'tx-preview-ae-003', applied: true, note: 'تم إرسال السؤال إلى مريم.' }]
          }
        },
        {
          type: 'future_action',
          status: 'proposed',
          client_name: 'Al Noor Trading LLC',
          transaction_ids: ['tx-preview-ae-004'],
          future_type: 'split_settlement',
          reason: 'تقسيم التسوية بين INV-2026-004 ودفعة Latin-REF-9 غير متاح بعد.'
        },
        {
          type: 'retry_parse',
          status: 'proposed',
          client_name: 'شركة النور للتجارة LLC',
          transaction_ids: ['tx-preview-ae-005'],
          document_id: 'doc-preview-فاتورة-005',
          reason: 'أعد المحاولة مع بقاء المعرّف DOC-AR-005 معزولاً.'
        }
      ]
    }
  }
];

const TRANSACTION_ACTION_CONVERSATION = [
  {
    id: 'transaction-actions-assistant',
    role: 'assistant',
    content: 'راجعت المطابقة الحالية وحافظت على رموز السبب ومعرّفات السلطة كما هي.',
    created_at: '2026-09-01T08:12:00Z',
    payload: {
      actions: [
        {
          type: 'reject_match',
          status: 'proposed',
          transaction_id: 'tx-preview-ae-001',
          transaction_ids: ['tx-preview-ae-001'],
          document_id: 'doc-preview-INV-2026-001',
          reason: 'المستند الصحيح هو فاتورة المورد Al Noor-778، وليس الملف الحالي.'
        },
        {
          type: 'ask_client',
          status: 'applied',
          transaction_id: 'tx-preview-ae-001',
          transaction_ids: ['tx-preview-ae-001'],
          question: 'ما الغرض التجاري من CLOUDHOST-42؟',
          evidence_type: 'business_purpose',
          result: {
            applied: 1,
            failed: 0,
            ask_id: 'ask-preview-tx-42',
            results: [{ transaction_id: 'tx-preview-ae-001', applied: true, note: 'Client receipt ASK-42 persisted.' }]
          }
        },
        {
          type: 'future_action',
          status: 'proposed',
          transaction_id: 'tx-preview-ae-001',
          future_type: 'multi_currency_split',
          reason: 'التقسيم بين AED وUSD غير متاح على هذه البطاقة.'
        },
        {
          type: 'retry_parse',
          status: 'proposed',
          transaction_id: 'tx-preview-ae-001',
          transaction_ids: ['tx-preview-ae-001'],
          document_id: 'doc-preview-فاتورة-005',
          reason: 'تعذّر تحديث ParseRun-42؛ بقي الإجراء مقترحاً.'
        }
      ]
    }
  }
];

const TRANSACTION_ACTION_ARTIFACT = {
  type: 'transaction',
  data: {
    ...TRANSACTION_ARTIFACT.data,
    previewMode: 'action-cards',
    previewMessages: TRANSACTION_ACTION_CONVERSATION,
    previewAppliableActionTypes: ['reject_match', 'ask_client', 'retry_parse'],
    previewApplyState: {
      'transaction-actions-assistant:3': { status: 'error', error: 'تعذّر التطبيق · ERR-PARSE-42' }
    },
    previewExplanation: null
  }
};

const documentArtifactPreview = (scenario) => ({
  type: 'document',
  title: DOCUMENT_ROW.filename,
  data: {
    previewMode: scenario === 'conversation' ? 'conversation' : 'detail',
    previewMessages: scenario === 'conversation' ? DOCUMENT_CONVERSATION : [],
    previewAppliableActionTypes: scenario === 'conversation' ? ['link_transaction'] : [],
    firmDocument: DOCUMENT_ROW,
    document: {
      id: DOCUMENT_ROW.id,
      title: DOCUMENT_ROW.filename,
      doc_type: DOCUMENT_ROW.document_type,
      status: 'verified',
      mime_type: 'application/pdf',
      file_size: 84217
    },
    fileUrl: 'https://example.invalid/INV-2026-001.pdf',
    linkable: {
      transactions: DOCUMENT_TRANSACTIONS,
      reconciliationMatches: scenario === 'search' ? [] : [DOCUMENT_MATCH],
      onLink: async () => ({ snapshot: null })
    }
  }
});

const WorkspaceReviewHeader = ({ surface, setSurface }) => {
  const intl = useIntl();
  const { locale, setInterfaceLocale } = useInterfaceLocale();
  const message = (id) => intl.formatMessage({ id });
  return (
    <header
      style={{
        position: 'sticky',
        insetBlockStart: 0,
        zIndex: 120,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 14px',
        borderBlockEnd: `1px solid ${D.rule}`,
        background: D.card
      }}
    >
      <div style={{ marginInlineEnd: 'auto' }}>
        <strong style={{ display: 'block', fontSize: 13 }}>{message('workspacePreview.title')}</strong>
        <span style={{ display: 'block', marginBlockStart: 2, fontSize: 11.5, color: D.inkMute }}>
          {message('workspacePreview.note')}
        </span>
      </div>
      <div role="group" aria-label={message('settings.language.interface.label')} style={{ display: 'flex', gap: 4 }}>
        {[
          ['en', 'workspacePreview.locale.english'],
          ['ar-AE', 'settings.language.arabic.label'],
          ['ar-XB', 'workspacePreview.locale.rtl']
        ].map(([value, id]) => (
          <button
            key={value}
            data-locale-option={value}
            type="button"
            onClick={() => setInterfaceLocale(value)}
            aria-pressed={locale === value}
            style={{
              border: `1px solid ${locale === value ? D.ink : D.rule}`,
              borderRadius: 999,
              padding: '5px 10px',
              background: locale === value ? D.ink : D.card,
              color: locale === value ? D.card : D.ink,
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer'
            }}
          >
            {message(id)}
          </button>
        ))}
      </div>
      <nav
        aria-label={message('workspacePreview.title')}
        style={{ display: 'flex', flex: '1 1 100%', flexWrap: 'wrap', gap: 4, minWidth: 0 }}
      >
        {[
          ['report', 'report.heading.eyebrow'],
          ['lifecycle', 'workspacePreview.surface.lifecycle'],
          ['portal', 'workspacePreview.surface.portal'],
          ['transaction', 'workspacePreview.surface.transaction'],
          ['document', 'workspacePreview.surface.document'],
          ['actions', 'operator.action.type.fallback']
        ].map(([value, id]) => (
          <button
            key={value}
            data-surface-option={value}
            type="button"
            onClick={() => setSurface(value)}
            aria-pressed={surface === value}
            style={{
              border: 0,
              borderBlockEnd: `2px solid ${surface === value ? D.ink : 'transparent'}`,
              padding: '5px 7px',
              background: 'transparent',
              color: surface === value ? D.ink : D.inkMute,
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer'
            }}
          >
            {message(id)}
          </button>
        ))}
      </nav>
    </header>
  );
};

const LifecycleReview = () => (
  // Single-list grammar (Kari, 2026-08-31): the month is a boundary label,
  // the rows are one date-sorted stream, and state lives only on each row's
  // own pill — no lanes, no collapse.
  <main style={{ minHeight: 'calc(100vh - 65px)', background: D.paper, color: T.ink, padding: '36px 24px' }}>
    <section style={{ width: '100%', maxWidth: 1080, marginInline: 'auto', ...BANK_FEED_SECTION_STYLE }}>
      <PeriodHeader period={PREVIEW_PERIOD} onOpenClose={() => {}} />
      <PeriodTransactionRow row={OWNER_ROW} lane="owner" onOpen={() => {}} />
      <PeriodTransactionRow row={{ ...RECONCILED_ROW, cat: '' }} lane="reconciled" />
      <PeriodTransactionRow row={RECONCILED_ROW} lane="reconciled" onOpen={() => {}} />
    </section>
  </main>
);

const ReportReview = ({ onClose }) => (
  <main style={{ minHeight: 'calc(100vh - 65px)', background: D.paper, color: T.ink, padding: '24px 14px 56px' }}>
    <div
      style={{
        width: '100%',
        maxWidth: 1320,
        marginInline: 'auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
        alignItems: 'start',
        gap: 18
      }}
    >
      <section style={{ minWidth: 0, border: `1px solid ${D.rule}`, borderRadius: 14, background: D.card, overflow: 'hidden' }}>
        <FinancialReportWorkspace
          artifact={REPORT_ARTIFACT}
          ventureLabel={PREVIEW_CLIENT.companyName}
          onClose={onClose}
        />
      </section>
      <aside style={{ width: '100%', maxWidth: 420, minWidth: 0, border: `1px solid ${D.rule}`, borderRadius: 14, background: D.card, overflow: 'hidden' }}>
        <FinancialsReportArtifact artifact={REPORT_COMPACT_ARTIFACT} />
      </aside>
    </div>
  </main>
);

const DocumentReview = () => {
  const intl = useIntl();
  const [scenario, setScenario] = useState('matched');
  return (
    <main style={{ minHeight: 'calc(100vh - 65px)', background: D.paper, color: T.ink, padding: '28px 18px' }}>
      <div role="group" aria-label={intl.formatMessage({ id: 'workspacePreview.surface.document' })} style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBlockEnd: 12 }}>
        {[
          ['matched', 'workspacePreview.document.matched'],
          ['search', 'workspacePreview.document.search'],
          ['conversation', 'workspacePreview.document.conversation']
        ].map(([value, id]) => (
          <button
            key={id}
            data-document-scenario={value}
            type="button"
            onClick={() => setScenario(value)}
            aria-pressed={scenario === value}
            style={{
              border: `1px solid ${scenario === value ? D.ink : D.rule}`,
              borderRadius: 999,
              padding: '5px 10px',
              background: scenario === value ? D.ink : D.card,
              color: scenario === value ? D.card : D.ink,
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer'
            }}
          >
            {intl.formatMessage({ id })}
          </button>
        ))}
      </div>
      <section style={{ width: '100%', maxWidth: 720, minHeight: 640, marginInline: 'auto', border: `1px solid ${D.rule}`, borderRadius: 14, background: D.card }}>
        <DocumentArtifact key={scenario} artifact={documentArtifactPreview(scenario)} />
      </section>
    </main>
  );
};

const PortalReview = () => {
  const intl = useIntl();
  const [scenario, setScenario] = useState('detail');
  const [layout, setLayout] = useState('full');
  const emptyClient = {
    ...PORTAL_CLIENT,
    id: 'client-preview-portal-empty',
    companyName: 'مؤسسة جديدة · New Venture Ltd',
    profile: { ...PORTAL_CLIENT.profile, services_engaged: [] },
    services_engaged: []
  };
  const previewState = scenario === 'setup'
    ? {
        ...PORTAL_PREVIEW_STATE,
        setupDue: ['jurisdiction', 'entity_type', 'fiscal_period', 'gb_filing', 'channel_connect'],
        fiscalPeriodState: { intake_acts: true, periods: [] }
      }
    : scenario === 'chat'
      ? { ...PORTAL_PREVIEW_STATE, chat: PORTAL_CHAT_PREVIEW }
      : scenario === 'states'
        ? {
            ...PORTAL_PREVIEW_STATE,
            downloadError: intl.formatMessage({ id: 'portal.error.download' }),
            uploadError: intl.formatMessage({ id: 'portal.error.uploadFile' }),
            chat: {
              ...PORTAL_CHAT_PREVIEW,
              loading: true,
              errorLine: intl.formatMessage({ id: 'portal.chat.error.send' })
            }
          }
        : scenario === 'empty'
          ? {}
          : PORTAL_PREVIEW_STATE;
  const selectedClient = scenario === 'empty' ? emptyClient : PORTAL_CLIENT;
  const documents = scenario === 'empty' ? [] : PORTAL_DOCUMENTS;
  const transactions = scenario === 'empty' ? [] : PORTAL_TRANSACTIONS;
  const requests = scenario === 'empty' ? [] : PORTAL_REQUESTS;
  const firmMessages = scenario === 'empty' ? [] : PORTAL_MESSAGES;
  const layoutStyle = layout === 'compact'
    ? { width: 'min(390px, 100%)' }
    : layout === 'zoom'
      ? { width: '100%', zoom: 2 }
      : { width: '100%' };
  return (
    <main style={{ minHeight: 'calc(100vh - 65px)', background: D.paper, color: T.ink }}>
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          flexWrap: 'wrap',
          padding: '8px 12px',
          borderBlockEnd: `1px solid ${D.rule}`,
          background: D.card
        }}
      >
        <div role="group" aria-label={intl.formatMessage({ id: 'workspacePreview.surface.portal' })} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[
            ['detail', 'portal.activity.title'],
            ['empty', 'portal.documents.tabs.previousEmpty'],
            ['setup', 'portal.setup.entity.title'],
            ['chat', 'portal.setup.chat'],
            ['states', 'portal.chat.loading.thread']
          ].map(([value, id]) => (
            <button
              key={value}
              data-portal-scenario={value}
              type="button"
              onClick={() => setScenario(value)}
              aria-pressed={scenario === value}
              style={{
                border: `1px solid ${scenario === value ? D.ink : D.rule}`,
                borderRadius: 999,
                padding: '5px 10px',
                background: scenario === value ? D.ink : D.card,
                color: scenario === value ? D.card : D.ink,
                font: 'inherit',
                fontSize: 11.5,
                cursor: 'pointer'
              }}
            >
              {intl.formatMessage({ id })}
            </button>
          ))}
        </div>
        <div role="group" aria-label={intl.formatMessage({ id: 'workspacePreview.note' })} style={{ display: 'flex', gap: 4 }}>
          {[
            ['full', '100%'],
            ['compact', '390px'],
            ['zoom', '200%']
          ].map(([value, label]) => (
            <button
              key={value}
              data-portal-layout={value}
              type="button"
              onClick={() => setLayout(value)}
              aria-pressed={layout === value}
              style={{
                border: `1px solid ${layout === value ? D.ink : D.rule}`,
                borderRadius: 999,
                padding: '5px 10px',
                background: layout === value ? D.ink : D.card,
                color: layout === value ? D.card : D.ink,
                font: 'inherit',
                fontSize: 11.5,
                cursor: 'pointer'
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ ...layoutStyle, marginInline: 'auto', overflow: 'clip' }}>
        <DonnaClientPortal
          key={`${scenario}-${layout}`}
          clients={[selectedClient]}
          clientId={selectedClient.id}
          documents={documents}
          transactions={transactions}
          clientEvidenceRequests={requests}
          firmMessages={firmMessages}
          firmDataSource="local"
          previewState={previewState}
        />
      </div>
    </main>
  );
};

const ACTION_CARD_VIEWPORTS = Object.freeze([
  { id: 'wide', width: 720, label: '720px' },
  { id: 'compact', width: 390, label: '390px' },
  { id: 'zoom-200', width: 360, label: '200%' }
]);

const ActionCardsReview = () => {
  const intl = useIntl();
  const [viewport, setViewport] = useState(ACTION_CARD_VIEWPORTS[0]);
  const reviewLabel = intl.formatMessage({ id: 'workspacePreview.note' });
  return (
    <main style={{ minHeight: 'calc(100vh - 65px)', background: D.paper, color: T.ink, padding: '28px 12px' }}>
      <div
        role="group"
        aria-label={reviewLabel}
        style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBlockEnd: 12 }}
      >
        {ACTION_CARD_VIEWPORTS.map((candidate) => (
          <button
            key={candidate.id}
            data-action-viewport={candidate.id}
            type="button"
            onClick={() => setViewport(candidate)}
            aria-pressed={viewport.id === candidate.id}
            aria-label={`${reviewLabel} ${candidate.label}`}
            style={{
              border: `1px solid ${viewport.id === candidate.id ? D.ink : D.rule}`,
              borderRadius: 999,
              padding: '5px 10px',
              background: viewport.id === candidate.id ? D.ink : D.card,
              color: viewport.id === candidate.id ? D.card : D.ink,
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer'
            }}
          >
            <IdentifierText>{candidate.label}</IdentifierText>
          </button>
        ))}
      </div>
      <div
        data-preview-width={viewport.id}
        data-zoom-equivalent={viewport.id === 'zoom-200' ? '200%' : undefined}
        style={{
          width: `min(100%, ${viewport.width}px)`,
          marginInline: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 18
        }}
      >
        <section
          aria-label={intl.formatMessage({ id: 'feed.composer.askDonna' })}
          style={{ height: 680, display: 'flex', minWidth: 0, border: `1px solid ${D.rule}`, borderRadius: 14, background: D.card, overflow: 'hidden' }}
        >
          <FeedChat
            clientId={PREVIEW_CLIENT.id}
            previewMessages={FEED_ACTION_CONVERSATION}
            previewAppliableActionTypes={['apply_category', 'retry_parse']}
            previewApplyState={{ 'feed-actions-assistant:3': 'error:تعذّر التطبيق · ERR-PARSE-42' }}
          />
        </section>
        <section
          aria-label={intl.formatMessage({ id: 'workspacePreview.surface.transaction' })}
          style={{ minHeight: 680, minWidth: 0, border: `1px solid ${D.rule}`, borderRadius: 14, background: D.card, overflow: 'hidden' }}
        >
          <TransactionArtifact artifact={TRANSACTION_ACTION_ARTIFACT} setArtifact={() => {}} />
        </section>
      </div>
    </main>
  );
};

const LocaleWorkspaceStatesPreview = () => {
  const [surface, setSurface] = useState('report');
  return (
    <div
      data-locale-preview="workspaces"
      data-surface={surface}
      style={{ minHeight: '100vh', background: D.paper, color: D.ink, fontFamily: D.ui }}
    >
      <WorkspaceReviewHeader surface={surface} setSurface={setSurface} />
      {surface === 'report' && <ReportReview onClose={() => setSurface('lifecycle')} />}
      {surface === 'lifecycle' && <LifecycleReview />}
      {surface === 'portal' && <PortalReview />}
      {surface === 'transaction' && (
        <main style={{ minHeight: 'calc(100vh - 65px)', background: D.paper, color: T.ink, padding: '28px 18px' }}>
          <section style={{ width: '100%', maxWidth: 720, minHeight: 640, marginInline: 'auto', border: `1px solid ${D.rule}`, borderRadius: 14, background: D.card }}>
            <TransactionArtifact artifact={TRANSACTION_ARTIFACT} setArtifact={() => {}} />
          </section>
        </main>
      )}
      {surface === 'document' && <DocumentReview />}
      {surface === 'actions' && <ActionCardsReview />}
    </div>
  );
};

export default LocaleWorkspaceStatesPreview;
