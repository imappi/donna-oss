// Venture intake — build a client profile + first queue action from the
// strong-LLM intake draft (`/api/donna/bizfile/intake-draft`).
//
// Replaces the hand-written Bizfile regex parser (bizfileParser.js): the
// model reads ANY identity-bearing document — registry extracts from any
// jurisdiction, bank statements, tax notices, invoices — and this module
// only maps its draft onto the profile shape the firm workspace already
// renders. The `bizfile` key is kept as the container name because
// FirmClientWorkspace renders `profile.bizfile.facts` / `.tables` by that
// name; it now simply means "source-document extract".

const slugify = (value = 'entity') =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'entity';

export const formatDraftAddress = (address = {}) =>
  [address.line1, address.line2, address.city, address.state, address.postal_code, address.country]
    .map((part) => (part == null ? '' : String(part).trim()))
    .filter(Boolean)
    .join(', ');

const DOCUMENT_KIND_LABELS = {
  registry_extract: 'Registry extract',
  bank_statement: 'Bank statement',
  invoice_or_bill: 'Invoice / bill',
  tax_notice: 'Tax notice',
  utility_bill: 'Utility bill',
  contract: 'Contract',
  other: 'Document'
};

export const DOCUMENT_KIND_MESSAGE_IDS = Object.freeze({
  registry_extract: 'mounted.venture.kind.registry',
  bank_statement: 'mounted.venture.kind.bank',
  invoice_or_bill: 'mounted.venture.kind.invoice',
  tax_notice: 'mounted.venture.kind.tax',
  utility_bill: 'mounted.venture.kind.utility',
  contract: 'mounted.venture.kind.contract',
  other: 'mounted.venture.kind.document'
});

export const documentKindLabel = (kind) => DOCUMENT_KIND_LABELS[kind] || 'Document';

// People & ownership renders profile.bizfile.tables, found by
// title-match (/officer/i, /shareholder/i) with records shaped
// { name, badge, items: [{label, value}] } — the shape the retired
// regex bizfileParser produced. The draft's structured officers/
// shareholders arrays map onto it here; a shareholder's holding must
// ride an item labelled "Shares" because numberFromRecord() finds the
// count by /shares|holding/ label match.
export const buildPeopleTables = (draft = {}) => {
  const officers = (Array.isArray(draft.officers) ? draft.officers : []).filter((row) => row && row.name);
  const shareholders = (Array.isArray(draft.shareholders) ? draft.shareholders : []).filter((row) => row && row.name);
  const tables = [];
  if (officers.length) {
    tables.push({
      title: 'Officers',
      meta: `${officers.length} extracted row${officers.length === 1 ? '' : 's'}`,
      records: officers.map((row) => ({
        name: row.name,
        badge: row.role || 'Officer',
        items: [
          { label: 'Role', value: row.role || 'Officer' },
          ...(row.appointed_on ? [{ label: 'Appointed', value: row.appointed_on }] : [])
        ]
      }))
    });
  }
  if (shareholders.length) {
    tables.push({
      title: 'Shareholders',
      meta: `${shareholders.length} extracted row${shareholders.length === 1 ? '' : 's'}`,
      records: shareholders.map((row) => ({
        name: row.name,
        badge: 'Shareholder',
        items: row.holding ? [{ label: 'Shares', value: row.holding }] : []
      }))
    });
  }
  return tables;
};

// Map the (possibly bookkeeper-edited) draft onto the profile shape
// `POST /clients` persists. The editable fields arrive merged into
// `draft` by the intake screen; `options` carries the handoff fields.
export const buildProfileFromIntakeDraft = (draft, options = {}) => {
  const companyName = String(draft.company_name || '').trim();
  const registrationNumber = String(draft.registration_number || '').trim();
  const idBase = `${slugify(companyName)}-${registrationNumber.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  const id = options.id || idBase.replace(/-+$/, '') || `entity-${Date.now()}`;

  const legalNames = [companyName, ...(Array.isArray(draft.legal_names) ? draft.legal_names : [])]
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .filter((name, index, all) => all.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index);

  const addressText = formatDraftAddress(draft.registered_address || {});
  const missing = [];
  if (!registrationNumber) missing.push('registration number');
  if (!draft.jurisdiction) missing.push('jurisdiction');
  if (!draft.default_currency) missing.push('default currency');
  if (!addressText) missing.push('registered address');

  const facts = [
    { label: 'Company name', value: companyName },
    {
      label: draft.registration_number_kind || 'Registration number',
      value: registrationNumber || 'Not on document'
    },
    {
      label: 'Jurisdiction',
      value: draft.jurisdiction
        ? `${draft.jurisdiction}${draft.jurisdiction_detail ? ` — ${draft.jurisdiction_detail}` : ''}`
        : 'Not determined'
    },
    { label: 'Default currency', value: draft.default_currency || 'Not determined' },
    { label: 'Registered address', value: addressText || 'Not on document' },
    ...(Array.isArray(draft.facts) ? draft.facts : [])
  ];

  return {
    id,
    companyName,
    legalName: legalNames[0] || companyName,
    legalNames,
    // `uen` is the legacy column name for "registration number" — kept so
    // existing renderers and the clients.uen column stay populated.
    uen: registrationNumber || '',
    registrationNumberKind: draft.registration_number_kind || '',
    entityType: draft.entity_type || '',
    incorporationDate: draft.incorporation_date
      ? `Incorporated ${draft.incorporation_date}`
      : 'Incorporation date not extracted',
    jurisdiction: draft.jurisdiction || '',
    jurisdictionDetail: draft.jurisdiction_detail || '',
    defaultCurrency: draft.default_currency || '',
    ...(options.processingReview ? {
      accounting_system: options.processingReview.accounting_system,
      accounting_view: options.processingReview.accounting_view,
      defaultCurrency: options.processingReview.currency
    } : options.donnaLedger ? {
      // Books kept on Donna's own ledger (no accounting-system connection),
      // stated explicitly so a hosted market that requires them (the US
      // hosted pilot) can admit the client.
      accounting_system: 'none',
      accounting_view: 'management_books'
    } : {}),
    registeredAddress: draft.registered_address || null,
    primaryContact: draft.primary_contact?.name ? draft.primary_contact : null,
    stage: 'Intake review',
    nextDeadline: missing.length
      ? `Confirm ${missing.join(', ')}`
      : 'First reconciliation pending — upload statements to begin.',
    intakeChecklist: [
      {
        id: 'company-basics',
        label: 'Company basics',
        detail: `Identity drafted from ${documentKindLabel(draft.document_kind).toLowerCase()}`,
        status: draft.extraction_status === 'confident' ? 'complete' : 'review'
      },
      {
        id: 'jurisdiction',
        label: 'Jurisdiction',
        detail: draft.jurisdiction
          ? `${draft.jurisdiction} — ${draft.jurisdiction_basis || 'from the document'}`
          : 'No jurisdiction signal on the document',
        status: draft.jurisdiction ? 'review' : 'pending'
      },
      {
        id: 'registered-address',
        label: 'Registered address',
        detail: addressText || 'Address not on the document',
        status: addressText ? 'review' : 'pending'
      },
      {
        id: 'registration-number',
        label: draft.registration_number_kind || 'Registration number',
        detail: registrationNumber || 'Not on the document — request from the client',
        status: registrationNumber ? 'complete' : 'pending'
      },
      {
        id: 'accounting-handoff',
        label: 'Accounting handoff',
        // Connecting Xero/QBO is intentionally out-of-band from intake — the
        // connect flow lives in the entity workspace (Accounting tab) and the
        // client portal, not on this firm-driven intake screen. The pending
        // copy points the operator there rather than dead-ending.
        detail: options.processingReview
          ? 'Document processing and review on the Donna ledger. Posting is unavailable in this workspace.'
          : options.xeroConnected
          ? 'Accounting tenant marked connected'
          : 'Connect Xero or QuickBooks from the workspace Accounting tab after intake',
        status: options.xeroConnected ? 'review' : 'pending'
      }
    ],
    bizfile: {
      source: options.sourceFile || documentKindLabel(draft.document_kind),
      document_kind: draft.document_kind,
      extraction_status: draft.extraction_status,
      extraction_confidence: draft.extraction_confidence,
      chosen_party_reasoning: draft.chosen_party_reasoning || '',
      other_parties: Array.isArray(draft.other_parties) ? draft.other_parties : [],
      warnings: Array.isArray(draft.warnings) ? draft.warnings : [],
      facts,
      sections: [],
      tables: buildPeopleTables(draft),
      mismatches: []
    },
    xeroReadiness: [
      {
        id: 'profile-reviewed',
        label: 'Client profile reviewed',
        detail: `Profile drafted from ${documentKindLabel(draft.document_kind).toLowerCase()} and confirmed at intake`,
        status: 'review'
      },
      {
        id: 'tenant-access',
        label: 'Accounting tenant access',
        detail: options.processingReview ? 'Donna ledger — document processing and review only' : options.xeroConnected ? 'Marked connected during intake' : 'Invite or connection required',
        status: options.xeroConnected ? 'complete' : 'pending'
      },
      {
        id: 'contact-mapping',
        label: 'Contact mapping',
        detail: options.billingEmail
          ? `Billing email: ${options.billingEmail}`
          : 'Billing email and contact address need confirmation',
        status: options.billingEmail ? 'review' : 'pending'
      }
    ]
  };
};

export const buildQueueFromIntakeProfile = (profile, options = {}) => {
  // Same posture as the Bizfile-era queue builder: the only action after
  // intake is the drafted welcome message — firm-internal tracking stays
  // on the entity's intakeChecklist, not as urgent queue items.
  //
  // Delivery path (intended, June 2026): this welcome item lands in the firm's
  // `ops_review` queue as an OPEN draft (see proposed_fix.steps below) — the
  // firm reviews the drafted message, confirms the client contact, and SENDS.
  // It is NOT auto-delivered to the client on create. The `auto_send_client_asks`
  // firm setting governs the separate evidence-ASK pipeline (client_evidence_
  // requests), not this welcome draft — so a beta client only receives the
  // welcome once the firm actions this queue item. Keep that explicit: an
  // unactioned welcome item means the client was never contacted.
  const createdAt = Date.now();
  const companyName = profile.companyName;
  const registrationNumber = profile.uen;
  const subject = `Welcome to Donna — getting ${companyName} set up`;
  const body = [
    `Hi there,`,
    ``,
    `Welcome to Donna. We've set up ${companyName}` +
      (registrationNumber ? ` (${profile.registrationNumberKind || 'reg. no.'} ${registrationNumber})` : '') +
      ` in our system from the ${String(options.sourceKindLabel || 'document').toLowerCase()} you shared.`,
    ``,
    options.processingReview
      ? 'This workspace supports document processing and review only; accounting posting is unavailable. Please share the materials you want reviewed:'
      : `To get accounting and compliance running cleanly, please share anything you already have from trading to date:`,
    ``,
    `• Bank statements (last 6-12 months, all accounts)`,
    `• Invoices issued and bills received`,
    `• Receipts for business expenses`,
    `• Existing financial agreements (loans, shareholder agreements, leases, service contracts)`,
    ``,
    `If ${companyName} hasn't traded yet, just reply "no trading yet" and we'll set up the basics so you're ready when activity starts.`,
    ``,
    `You can upload directly via the client portal or reply to this email with attachments.`
  ].join('\n');

  return [
    {
      id: `${profile.id}-welcome-${createdAt}`,
      trigger_type: 'firm_client_welcome',
      trigger_id: 'first_contact',
      queue_label: 'ops_review',
      pattern_category: 'client_onboarding',
      hold_reason: 'awaiting_client_materials',
      confidence: 'high',
      problem_summary: `Welcome ${companyName} and request initial trading materials`,
      user_stuck_on: 'What does the firm need from us to get started?',
      donna_response: body,
      queue_reason:
        'First client outreach: pull whatever trading documents the client already has so accounting and compliance work has real evidence to start from.',
      subject,
      client_id: profile.id,
      client_name: companyName,
      created_at: createdAt,
      conversation: [
        {
          role: 'Client',
          text: options.sourceFile ? `I uploaded ${options.sourceFile}.` : 'I shared the company details.'
        },
        {
          role: 'Firm',
          text: `Donna drafted the company profile for ${companyName}. Drafting the welcome message and asking for any trading documents the client already has.`
        }
      ],
      root_cause: {
        hypothesis: 'New venture intake — no trading materials yet on file.',
        evidence: ['Client profile drafted from an intake document.'],
        confidence: 'high'
      },
      proposed_fix: {
        owner: 'ops_review',
        steps: [
          'Review the drafted welcome message',
          'Confirm the client contact and send',
          'Wait for the client to upload materials via the portal'
        ]
      },
      evidence_requested: [
        'Bank statements',
        'Invoices and bills',
        'Receipts',
        'Existing financial agreements'
      ],
      escalation_flag: false
    }
  ];
};
