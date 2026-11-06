// Compact mock queue — kept for demo purposes.
// In production this would come from the API.

const now = Date.now();

export const mockQueue = [
  {
    id: 'q1',
    trigger_type: 'looping',
    trigger_id: 'user_repeated_question',
    hold_reason: 'platform_deposit',
    created_at: now - 2 * 60_000,
    confidence: 'high',
    problem_summary: 'User asking why Stripe deposit is on hold (3rd time).',
    user_stuck_on: 'Why is this Stripe deposit on hold?',
    donna_response:
      "I understand the confusion! The hold is there because we need to match this Stripe deposit to your actual sales.\n\nHere is what to do:\n1. Log into your Stripe dashboard\n2. Go to Payouts and find the $9,500 payout\n3. Download the payout report\n4. Upload it here\n\nThis should take about 2 minutes.",
    conversation: [
      { role: 'User', text: 'Why is this Stripe deposit on hold?' },
      { role: 'Agent', text: 'We place holds until payouts are matched to sales.' },
      { role: 'User', text: 'But I already matched it yesterday.' },
      { role: 'Agent', text: 'We still need the payout report to verify the timing.' },
      { role: 'User', text: 'Why is this on hold then? I do not get it.' }
    ],
    root_cause: { hypothesis: 'User does not understand the reconciliation requirement for Stripe payouts.', evidence: ['Asked the same question three times', 'No acknowledgement of payout report step'], confidence: 'high' },
    proposed_fix: { owner: 'donna_agent', steps: ['Request the specific payout report in Stripe', 'Explain the matching rule in one sentence', 'Offer to complete the match once the report is uploaded'] },
    evidence_requested: ['Stripe payout report for $9,500'],
    escalation_flag: false
  },
  {
    id: 'q2',
    trigger_type: 'contradiction',
    trigger_id: 'agent_conflict',
    hold_reason: 'platform_deposit',
    created_at: now - 12 * 60_000,
    confidence: 'medium',
    problem_summary: 'Two agents gave conflicting guidance on how to clear a hold.',
    user_stuck_on: 'Which instruction is correct for clearing the hold?',
    donna_response:
      'You got conflicting guidance, so I want to clarify clearly. The correct next step is to upload the payout report for the hold so we can match it in Donna.\n\nOnce you upload that file, we will clear the hold for you.',
    conversation: [
      { role: 'User', text: 'Agent A told me to wait 24 hours.' },
      { role: 'Agent', text: 'Yes, holds clear automatically in 24 hours.' },
      { role: 'User', text: 'Agent B said I must upload a payout report.' },
      { role: 'Agent', text: 'We need the payout report to match it.' },
      { role: 'User', text: 'So which one is right?' }
    ],
    root_cause: { hypothesis: 'Contradictory guidance on hold clearing.', evidence: ['Two agents gave different instructions'], confidence: 'medium' },
    proposed_fix: { owner: 'donna_agent', steps: ['Confirm the correct flow', 'Apologize for mixed guidance', 'Request payout report'] },
    evidence_requested: ['Stripe payout report screenshot or CSV'],
    escalation_flag: false
  },
  {
    id: 'q3',
    trigger_type: 'no_path',
    trigger_id: 'missing_document',
    hold_reason: 'missing_document',
    created_at: now - 28 * 60_000,
    confidence: 'low',
    problem_summary: 'User says payout report is unavailable due to Stripe permissions.',
    user_stuck_on: 'I do not have access to Stripe reports.',
    donna_response:
      "Thanks for letting us know. If you do not have access to Stripe reports, the fastest path is to add a teammate who does, or share a screenshot of the payout list with the amount and date.",
    conversation: [
      { role: 'User', text: 'The payout report is not available to me.' },
      { role: 'Agent', text: 'Could you ask your admin to grant access?' },
      { role: 'User', text: 'I do not know who that is.' },
      { role: 'Agent', text: 'We need the report to resolve the hold.' },
      { role: 'User', text: 'I am stuck then.' }
    ],
    root_cause: { hypothesis: 'User lacks Stripe permissions.', evidence: ['No report access', 'No internal contact identified'], confidence: 'low' },
    proposed_fix: { owner: 'ph_pod', steps: ['Ask for alternate evidence', 'Offer to reach out to admin', 'Route to PH Pod'] },
    evidence_requested: ['Payout list screenshot', 'Stripe admin contact'],
    escalation_flag: true
  },
  {
    id: 'q4',
    trigger_type: 'frustration',
    trigger_id: 'user_category_pushback',
    hold_reason: 'confidence_low',
    created_at: now - 40 * 60_000,
    confidence: 'medium',
    problem_summary: 'User says Uber transaction is categorized wrong and wants recategorization.',
    user_stuck_on: 'This should be Meals, not Travel.',
    donna_response:
      "You're right to call this out. Quick check so we route this correctly: was this Uber charge for business travel, a client meeting, or personal commute?",
    conversation: [
      { role: 'User', text: 'Why did you categorize this Uber as Travel?' },
      { role: 'Agent', text: 'We often use Travel for Uber charges by default.' },
      { role: 'User', text: 'This one was for a client dinner, so it should be Meals.' },
      { role: 'Agent', text: 'Can you confirm that context so we can re-check?' },
      { role: 'User', text: 'Yes, client dinner meeting.' }
    ],
    root_cause: { hypothesis: 'Category dispute caused by missing business-purpose context.', evidence: ['User gave client-meeting context'], confidence: 'medium' },
    proposed_fix: { owner: 'donna_agent', steps: ['Capture context', 'Retry categorization', 'Confirm updated category'] },
    evidence_requested: ['Business purpose confirmation'],
    escalation_flag: false
  },
  {
    id: 'q5',
    trigger_type: 'queue_age',
    trigger_id: 'integration_sync_delay',
    hold_reason: 'unusual_pattern',
    created_at: now - 65 * 60_000,
    confidence: 'low',
    problem_summary: 'User says Stripe sync is broken because yesterday transactions are missing.',
    user_stuck_on: 'This is not working. Stripe sales are missing.',
    donna_response:
      "I can see why this feels broken. It looks like a sync delay between Stripe and Donna. I'll route this for sync investigation now.",
    conversation: [
      { role: 'User', text: 'Stripe transactions from yesterday are missing in Donna.' },
      { role: 'Agent', text: 'Can you refresh and check again?' },
      { role: 'User', text: 'I did, still missing. This is broken.' },
      { role: 'Agent', text: 'Thanks, we are checking sync status.' }
    ],
    root_cause: { hypothesis: 'Integration sync delay.', evidence: ['Missing day-level data', 'Refresh did not resolve'], confidence: 'low' },
    proposed_fix: { owner: 'ph_pod', steps: ['Check integration sync health', 'Trigger retry or backfill', 'Confirm date range'] },
    evidence_requested: ['Screenshot of missing date range'],
    escalation_flag: true
  },
  {
    id: 'q6',
    trigger_type: 'looping',
    trigger_id: 'reconciliation_gap',
    hold_reason: 'confidence_low',
    created_at: now - 22 * 60_000,
    confidence: 'medium',
    problem_summary: 'User says reconciliation is off by $342.17.',
    user_stuck_on: "My bank doesn't match my books.",
    donna_response:
      "I can see why that feels concerning. There's a $342.17 difference, and I'll help trace exactly which transactions are causing it.",
    conversation: [
      { role: 'User', text: "My reconciliation won't balance. It's off by $342.17." },
      { role: 'Agent', text: 'Are you comparing bank ending balance to book balance for the same period?' },
      { role: 'User', text: "Yes. It was fine last month, now it's wrong." },
      { role: 'Agent', text: 'Got it, let us trace the unmatched transactions.' }
    ],
    root_cause: { hypothesis: 'Unreconciled transaction set or timing differences.', evidence: ['Exact difference provided', 'Same-period comparison confirmed'], confidence: 'medium' },
    proposed_fix: { owner: 'donna_agent', steps: ['Search unmatched items for $342.17', 'Check recent edits/deletes', 'Explain specific gap items'] },
    evidence_requested: ['Bank statement ending balance screenshot'],
    escalation_flag: false
  }
];

export const mockHistory = [
  { id: 'h1', time: now - 45 * 60_000, trigger: 'looping', confidence: 'high', outcome: 'approved', problem: 'User kept asking about a Shopify hold.' },
  { id: 'h2', time: now - 2 * 3600_000, trigger: 'queue_age', confidence: 'medium', outcome: 'unblocked', problem: 'Queue timeout on categorization mismatch.' },
  { id: 'h3', time: now - 4 * 3600_000, trigger: 'frustration', confidence: 'low', outcome: 'rejected', problem: 'User upset about missing payout details.' },
  { id: 'h4', time: now - 6 * 3600_000, trigger: 'no_path', confidence: 'medium', outcome: 'escalated', problem: 'User lacks Stripe permissions.' },
  { id: 'h5', time: now - 9 * 3600_000, trigger: 'contradiction', confidence: 'high', outcome: 'approved', problem: 'Agent conflict on hold clearing.' },
  { id: 'h6', time: now - 12 * 3600_000, trigger: 'high_impact', confidence: 'high', outcome: 'unblocked', problem: 'High impact payout mismatch.' },
  { id: 'h7', time: now - 16 * 3600_000, trigger: 'looping', confidence: 'medium', outcome: 'approved', problem: 'User stuck on bank verification.' },
  { id: 'h8', time: now - 20 * 3600_000, trigger: 'queue_age', confidence: 'low', outcome: 'still_stuck', problem: 'Timeout on tax form request.' }
];

export const firmMockQueue = [
  {
    id: 'firm-q1',
    client_id: 'aurora-grid',
    client_name: 'Aurora Grid Pte. Ltd.',
    trigger_type: 'firm_client_intake',
    trigger_id: 'missing_intake_detail',
    hold_reason: 'missing_document',
    created_at: now - 5 * 60_000,
    confidence: 'high',
    queue_label: 'auto_send',
    pattern_category: 'missing_intake_detail',
    queue_reason: 'Routine incorporation intake chase. Donna can ask for the missing particulars without compliance judgment.',
    problem_summary: 'New incorporation intake is missing the proposed registered address and two officer NRIC/passport numbers.',
    user_stuck_on: 'Can you proceed with the incorporation first?',
    donna_response:
      'We can keep preparing the incorporation file, but we need two details before it is ready for filing: the registered office address and the NRIC/passport numbers for the proposed officers.\n\nPlease reply with those details, or send the completed intake form if that is easier. Once we have them, we can finish the draft for review.',
    conversation: [
      { role: 'Client', text: 'I filled most of the incorporation form but I am still checking the office address.' },
      { role: 'Firm', text: 'We also need the NRIC or passport numbers for the proposed directors.' },
      { role: 'Client', text: 'Can you proceed with the incorporation first?' }
    ],
    root_cause: {
      hypothesis: 'The incorporation pack is blocked by missing required intake fields.',
      evidence: ['Registered address is not confirmed', 'Officer ID numbers are missing'],
      confidence: 'high'
    },
    proposed_fix: {
      owner: 'client_intake',
      steps: ['Request registered office address', 'Request officer NRIC/passport numbers', 'Continue preparing the incorporation draft']
    },
    evidence_requested: ['Registered office address', 'Officer NRIC/passport numbers'],
    escalation_flag: false
  },
  {
    id: 'firm-q2',
    client_id: 'aurora-grid',
    client_name: 'Aurora Grid Pte. Ltd.',
    trigger_type: 'firm_bizfile_mismatch',
    trigger_id: 'bizfile_address_mismatch',
    hold_reason: 'unusual_pattern',
    created_at: now - 18 * 60_000,
    confidence: 'medium',
    queue_label: 'ops_review',
    pattern_category: 'bizfile_mismatch',
    queue_reason: 'Bizfile profile conflicts with intake. Intake should confirm the source of truth before Donna drafts the update.',
    problem_summary: 'Bizfile extract shows a different registered address than the client intake form.',
    user_stuck_on: 'Use the address I typed in the form.',
    donna_response:
      'I spotted a mismatch before we update the company record. The Bizfile profile shows a different registered address from the one in your intake form.\n\nPlease confirm which address is current, and if the Bizfile address is outdated, send the supporting change instruction so we can prepare the update correctly.',
    conversation: [
      { role: 'Client', text: 'Please use 18 Robinson Road as the registered address.' },
      { role: 'Firm', text: 'The Bizfile profile currently shows 10 Anson Road.' },
      { role: 'Client', text: 'Use the address I typed in the form.' }
    ],
    root_cause: {
      hypothesis: 'The client intake address does not match the ACRA/Bizfile company profile.',
      evidence: ['Bizfile address differs from intake address', 'Client asks to use intake address without confirming the formal record'],
      confidence: 'medium'
    },
    proposed_fix: {
      owner: 'client_intake',
      steps: ['Confirm current registered address', 'Request change instruction if Bizfile is stale', 'Prepare record update after confirmation']
    },
    evidence_requested: ['Confirmed registered address', 'Bizfile change instruction if needed'],
    escalation_flag: false
  },
  {
    id: 'firm-q3',
    client_id: 'merlion-studio',
    client_name: 'Merlion Studio Pte. Ltd.',
    trigger_type: 'firm_compliance_review',
    trigger_id: 'aml_cdd_evidence',
    hold_reason: 'confidence_low',
    created_at: now - 31 * 60_000,
    confidence: 'low',
    queue_label: 'expert_review',
    pattern_category: 'aml_cdd_evidence',
    queue_reason: 'AML/CDD evidence is incomplete. Compliance should decide whether the pack is sufficient or needs enhanced review.',
    problem_summary: 'Controller ID was uploaded, but proof of residential address is missing for AML/CDD.',
    user_stuck_on: 'Is the passport enough for KYC?',
    donna_response:
      'The passport is helpful, but the compliance pack still needs proof of residential address for the controller.\n\nPlease upload a recent utility bill, bank statement, or government letter showing the controller name and residential address. Our compliance reviewer will check the pack before we mark CDD complete.',
    conversation: [
      { role: 'Client', text: 'I uploaded the controller passport yesterday.' },
      { role: 'Firm', text: 'We still need address evidence for CDD.' },
      { role: 'Client', text: 'Is the passport enough for KYC?' }
    ],
    root_cause: {
      hypothesis: 'Identity evidence is present, but address evidence is missing from the AML/CDD pack.',
      evidence: ['Passport uploaded', 'No residential address proof uploaded'],
      confidence: 'low'
    },
    proposed_fix: {
      owner: 'compliance_review',
      steps: ['Request acceptable address proof', 'Keep CDD status open', 'Route final sufficiency check to compliance reviewer']
    },
    evidence_requested: ['Recent proof of residential address for the controller'],
    escalation_flag: true
  },
  {
    id: 'firm-q4',
    client_id: 'aurora-grid',
    client_name: 'Aurora Grid Pte. Ltd.',
    trigger_type: 'firm_record_change',
    trigger_id: 'officer_shareholder_change',
    hold_reason: 'unusual_pattern',
    created_at: now - 46 * 60_000,
    confidence: 'medium',
    queue_label: 'expert_review',
    pattern_category: 'officer_shareholder_change',
    queue_reason: 'Officer/shareholder changes affect statutory records. Compliance review should confirm the required approvals before filing.',
    problem_summary: 'Client wants to remove a director and transfer shares to a new shareholder.',
    user_stuck_on: 'Can you file the director removal today?',
    donna_response:
      'We can prepare this, but we should confirm the approvals before filing. Please send the signed director resignation or removal approval, the share transfer details, and the new shareholder particulars.\n\nOnce those are in, our compliance reviewer can check the required resolutions and confirm the filing path.',
    conversation: [
      { role: 'Client', text: 'We need to remove Mei Ling as director and transfer her shares to our new investor.' },
      { role: 'Firm', text: 'Please send the signed approvals and new shareholder details.' },
      { role: 'Client', text: 'Can you file the director removal today?' }
    ],
    root_cause: {
      hypothesis: 'The requested statutory change needs supporting approvals and new shareholder particulars before filing.',
      evidence: ['Director removal requested', 'Share transfer requested', 'Approvals not yet provided'],
      confidence: 'medium'
    },
    proposed_fix: {
      owner: 'compliance_review',
      steps: ['Request signed approvals', 'Collect new shareholder particulars', 'Prepare reviewer-ready filing pack']
    },
    evidence_requested: ['Signed director resignation/removal approval', 'Share transfer details', 'New shareholder particulars'],
    escalation_flag: true
  },
  {
    id: 'firm-q5',
    client_id: 'tanjong-trading',
    client_name: 'Tanjong Trading Pte. Ltd.',
    trigger_type: 'firm_xero_handoff',
    trigger_id: 'xero_sync_blocker',
    hold_reason: 'missing_document',
    created_at: now - 64 * 60_000,
    confidence: 'medium',
    queue_label: 'execution_queue',
    pattern_category: 'xero_sync_issue',
    queue_reason: 'Clean company profile is ready, but Xero handoff is blocked by missing contact mapping and tenant access.',
    problem_summary: 'Xero handoff is blocked because the client has not connected the Xero tenant or confirmed invoice contact fields.',
    user_stuck_on: 'Why is the accounting setup not done yet?',
    donna_response:
      'The company profile is ready for accounting handoff, but Xero is not connected yet and we still need the billing contact to sync.\n\nPlease invite our team to the Xero tenant or connect Xero from the onboarding link, then confirm the billing email and registered business address to use for the contact record.',
    conversation: [
      { role: 'Client', text: 'The incorporation is done. Why is the accounting setup not done yet?' },
      { role: 'Firm', text: 'We need Xero access and the billing contact details before syncing.' },
      { role: 'Client', text: 'I thought you already had everything from Bizfile.' }
    ],
    root_cause: {
      hypothesis: 'The statutory profile is complete, but the accounting system handoff needs Xero access and contact mapping.',
      evidence: ['Xero tenant is not connected', 'Billing contact fields are not confirmed'],
      confidence: 'medium'
    },
    proposed_fix: {
      owner: 'xero_handoff',
      steps: ['Request Xero tenant access', 'Confirm billing contact fields', 'Sync the reviewed client profile']
    },
    evidence_requested: ['Xero tenant access', 'Billing email', 'Billing contact address'],
    escalation_flag: false
  },
  {
    id: 'firm-q6',
    client_id: 'merlion-studio',
    client_name: 'Merlion Studio Pte. Ltd.',
    trigger_type: 'firm_annual_return',
    trigger_id: 'annual_return_deadline',
    hold_reason: 'unusual_pattern',
    created_at: now - 86 * 60_000,
    confidence: 'high',
    queue_label: 'ops_review',
    pattern_category: 'annual_return_deadline',
    queue_reason: 'Annual return prep is close to deadline. Intake should confirm AGM/FS status before compliance signs off.',
    problem_summary: 'Annual return due date is approaching, but AGM and financial statement status are not confirmed.',
    user_stuck_on: 'Can you just submit the annual return before the deadline?',
    donna_response:
      'We can help keep the annual return on track, but we need to confirm the AGM and financial statement status before submission.\n\nPlease confirm whether the AGM has been held or dispensed with, and whether the financial statements are ready for the filing year. Once confirmed, we can prepare the annual return pack for review.',
    conversation: [
      { role: 'Client', text: 'The annual return reminder says we are close to the deadline.' },
      { role: 'Firm', text: 'We need to confirm AGM and financial statement status before submission.' },
      { role: 'Client', text: 'Can you just submit the annual return before the deadline?' }
    ],
    root_cause: {
      hypothesis: 'Annual return prep cannot be finalized until AGM and financial statement status are confirmed.',
      evidence: ['Deadline is approaching', 'AGM status not confirmed', 'Financial statement status not confirmed'],
      confidence: 'high'
    },
    proposed_fix: {
      owner: 'client_intake',
      steps: ['Confirm AGM status', 'Confirm financial statement readiness', 'Prepare annual return pack for compliance review']
    },
    evidence_requested: ['AGM held/dispensed confirmation', 'Financial statement readiness confirmation'],
    escalation_flag: false
  }
];

export const firmMockHistory = [
  { id: 'firm-h1', client_id: 'aurora-grid', client_name: 'Aurora Grid Pte. Ltd.', time: now - 50 * 60_000, trigger: 'firm_client_intake', confidence: 'high', outcome: 'approved', problem: 'Client sent missing officer particulars after intake follow-up.' },
  { id: 'firm-h2', client_id: 'aurora-grid', client_name: 'Aurora Grid Pte. Ltd.', time: now - 3 * 3600_000, trigger: 'firm_bizfile_mismatch', confidence: 'medium', outcome: 'unblocked', problem: 'Bizfile address mismatch resolved with signed change instruction.' },
  { id: 'firm-h3', client_id: 'merlion-studio', client_name: 'Merlion Studio Pte. Ltd.', time: now - 7 * 3600_000, trigger: 'firm_compliance_review', confidence: 'low', outcome: 'accountant_answered', problem: 'Compliance reviewed AML/CDD pack and requested enhanced address evidence.' },
  { id: 'firm-h4', client_id: 'tanjong-trading', client_name: 'Tanjong Trading Pte. Ltd.', time: now - 11 * 3600_000, trigger: 'firm_xero_handoff', confidence: 'medium', outcome: 'approved', problem: 'Xero sync blocker cleared after tenant access was granted.' }
];

export const firmClientProfile = {
  id: 'aurora-grid',
  companyName: 'Aurora Grid Pte. Ltd.',
  uen: '202412345R',
  entityType: 'Private company limited by shares',
  incorporationDate: 'Incorporated 14 Mar 2024',
  stage: 'Onboarding active',
  nextDeadline: 'Annual return prep due 14 Sep 2025',
  // Drives which intake tiles render on the client portal. Read by
  // readApplicableCategories() in donna-client-portal.jsx. Aurora is
  // an early-stage SG company with no loan exposure — Loans pile is
  // intentionally omitted so the portal doesn't ask for evidence the
  // client doesn't have.
  applicable_intake_categories: ['bank', 'sales', 'bills', 'payroll', 'xero'],
  intakeChecklist: [
    {
      id: 'company-basics',
      label: 'Company basics',
      detail: 'Company name, UEN, entity type, incorporation date',
      status: 'complete'
    },
    {
      id: 'registered-address',
      label: 'Registered office address',
      detail: 'Client intake conflicts with Bizfile profile',
      status: 'review'
    },
    {
      id: 'officer-particulars',
      label: 'Officer particulars',
      detail: 'One proposed officer missing NRIC/passport number',
      status: 'pending'
    },
    {
      id: 'shareholder-register',
      label: 'Shareholder register',
      detail: 'New investor particulars and share transfer details needed',
      status: 'review'
    },
    {
      id: 'aml-cdd',
      label: 'AML/CDD evidence',
      detail: 'Controller address proof missing',
      status: 'blocked'
    },
    {
      id: 'accounting-handoff',
      label: 'Accounting handoff',
      detail: 'Xero tenant access and billing contact not confirmed',
      status: 'pending'
    }
  ],
  bizfile: {
    source: 'Sample Bizfile extract',
    facts: [
      { label: 'Company name', value: 'Aurora Grid Pte. Ltd.' },
      { label: 'UEN', value: '202412345R' },
      { label: 'Registered office', value: '10 Anson Road #12-14, Singapore 079903' },
      { label: 'Director', value: 'Mei Ling Tan' },
      { label: 'Share capital', value: 'SGD 100,000 ordinary shares' },
      { label: 'FYE', value: '31 December' }
    ],
    mismatches: [
      {
        field: 'Registered office',
        bizfile: '10 Anson Road #12-14',
        intake: '18 Robinson Road #08-03'
      },
      {
        field: 'Director status',
        bizfile: 'Mei Ling Tan active',
        intake: 'Remove Mei Ling and appoint replacement'
      }
    ]
  },
  xeroReadiness: [
    {
      id: 'profile-reviewed',
      label: 'Client profile reviewed',
      detail: 'Bizfile facts extracted and queued for mismatch review',
      status: 'complete'
    },
    {
      id: 'compliance-clearance',
      label: 'Compliance clearance',
      detail: 'AML/CDD address evidence still open',
      status: 'blocked'
    },
    {
      id: 'tenant-access',
      label: 'Xero tenant access',
      detail: 'Invite or onboarding connection required',
      status: 'pending'
    },
    {
      id: 'contact-mapping',
      label: 'Contact mapping',
      detail: 'Billing email and registered address need confirmation',
      status: 'pending'
    }
  ]
};

export const firmClientProfiles = [
  firmClientProfile,
  {
    id: 'merlion-studio',
    companyName: 'Merlion Studio Pte. Ltd.',
    uen: '202319870M',
    entityType: 'Private company limited by shares',
    incorporationDate: 'Incorporated 8 Jun 2023',
    stage: 'Compliance review',
    nextDeadline: 'Annual return prep due 8 Jul 2025',
    // Studio runs payroll and has financing exposure — full intake
    // pack applies.
    applicable_intake_categories: ['bank', 'sales', 'bills', 'payroll', 'loans', 'xero'],
    intakeChecklist: [
      { id: 'company-basics', label: 'Company basics', detail: 'Bizfile company record extracted', status: 'complete' },
      { id: 'registered-address', label: 'Registered office address', detail: 'Address confirmed against Bizfile', status: 'complete' },
      { id: 'officer-particulars', label: 'Officer particulars', detail: 'Director and secretary particulars complete', status: 'complete' },
      { id: 'shareholder-register', label: 'Shareholder register', detail: 'Controller evidence pending for one shareholder', status: 'review' },
      { id: 'aml-cdd', label: 'AML/CDD evidence', detail: 'Proof of address missing for controller', status: 'blocked' },
      { id: 'annual-return', label: 'Annual return readiness', detail: 'AGM and FS status need confirmation', status: 'pending' }
    ],
    bizfile: {
      source: 'Sample Bizfile extract',
      facts: [
        { label: 'Company name', value: 'Merlion Studio Pte. Ltd.' },
        { label: 'UEN', value: '202319870M' },
        { label: 'Registered office', value: '71 Ayer Rajah Crescent #04-01, Singapore 139951' },
        { label: 'Director', value: 'Amelia Ng' },
        { label: 'Share capital', value: 'SGD 50,000 ordinary shares' },
        { label: 'FYE', value: '31 December' }
      ],
      mismatches: [
        {
          field: 'Annual return status',
          bizfile: 'No latest AGM/AR values in intake workspace',
          intake: 'Client wants filing pack prepared'
        }
      ]
    },
    xeroReadiness: [
      { id: 'profile-reviewed', label: 'Client profile reviewed', detail: 'Bizfile facts extracted', status: 'complete' },
      { id: 'compliance-clearance', label: 'Compliance clearance', detail: 'AML/CDD evidence open', status: 'blocked' },
      { id: 'tenant-access', label: 'Xero tenant access', detail: 'Not requested yet', status: 'pending' },
      { id: 'contact-mapping', label: 'Contact mapping', detail: 'Wait for compliance clearance first', status: 'pending' }
    ]
  },
  {
    id: 'tanjong-trading',
    companyName: 'Tanjong Trading Pte. Ltd.',
    uen: '202402114K',
    entityType: 'Private company limited by shares',
    incorporationDate: 'Incorporated 17 Jan 2024',
    stage: 'Xero handoff',
    nextDeadline: 'Accounting setup waiting on Xero access',
    // Lean trader, sole-director — no employees, no debt yet.
    // Payroll and Loans piles drop off so the portal doesn't
    // ask for evidence the client doesn't have.
    applicable_intake_categories: ['bank', 'sales', 'bills', 'xero'],
    intakeChecklist: [
      { id: 'company-basics', label: 'Company basics', detail: 'Company record complete', status: 'complete' },
      { id: 'registered-address', label: 'Registered office address', detail: 'Confirmed from Bizfile', status: 'complete' },
      { id: 'officer-particulars', label: 'Officer particulars', detail: 'Director and secretary complete', status: 'complete' },
      { id: 'shareholder-register', label: 'Shareholder register', detail: 'Shareholder register complete', status: 'complete' },
      { id: 'aml-cdd', label: 'AML/CDD evidence', detail: 'Compliance pack marked ready', status: 'complete' },
      { id: 'accounting-handoff', label: 'Accounting handoff', detail: 'Xero tenant access and contact mapping pending', status: 'pending' }
    ],
    bizfile: {
      source: 'Sample Bizfile extract',
      facts: [
        { label: 'Company name', value: 'Tanjong Trading Pte. Ltd.' },
        { label: 'UEN', value: '202402114K' },
        { label: 'Registered office', value: '80 Robinson Road #08-01, Singapore 068898' },
        { label: 'Director', value: 'Daniel Koh' },
        { label: 'Share capital', value: 'SGD 10,000 ordinary shares' },
        { label: 'FYE', value: '31 December' }
      ],
      mismatches: []
    },
    xeroReadiness: [
      { id: 'profile-reviewed', label: 'Client profile reviewed', detail: 'Ready for accounting handoff', status: 'complete' },
      { id: 'compliance-clearance', label: 'Compliance clearance', detail: 'No blocker recorded', status: 'complete' },
      { id: 'tenant-access', label: 'Xero tenant access', detail: 'Invite or connection required', status: 'pending' },
      { id: 'contact-mapping', label: 'Contact mapping', detail: 'Billing email and address need confirmation', status: 'pending' }
    ]
  }
];

export const mockRates = {
  unblock_24h: 0.73,
  unblock_72h: 0.89,
  confident_wrong: 0.008,
  avg_messages: 2.3
};
