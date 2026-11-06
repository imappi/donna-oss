// SG-CS — the Singapore customer-support / judgment knowledge substrate + eval
// seed. The Finnish support corpus does NOT transfer (different tax law,
// different authority vocabulary, different owner questions) — this is the SG
// reset the handoff names, built for the 2026-07-23 self-service model:
//
//   Under the 100% self-service re-amendment (CLAUDE.md, Kari 2026-07-23) there
//   is NO professional handoff and no professional in the loop. Knowledge /
//   judgment / rule questions (GST treatment, capitalize-vs-expense, ECI
//   obligations) Donna answers HERSELF, grounded in a curated base of
//   HIGH-TRUST sources — for Singapore that is IRAS, ACRA, MOM, and PDPC
//   first-party material. This registry is that curated base's SG spine: the
//   L2/L3 substrate (L2 curated playbook topics, L3 raw high-trust references)
//   the retrieval layer grounds on. Every entry carries provenance +
//   jurisdiction + an as-of date (the re-amendment's "high-trust and current"
//   requirement, verbatim). A business FACT stays an owner ask; a KNOWLEDGE
//   question grounds here — the fork is FACT vs KNOWLEDGE, not simple vs hard.
//
// Pure DATA + pure lookup. The retrieval/RAG layer consumes this registry; the
// eval seed below is the regression harness's SG starter set (mirroring the
// Finnish CS eval architecture: question → expected grounding source ids +
// must-mention markers). Low confidence still means the Keep layer refuses —
// "I'm not sure, here's my best read and the source" — never a confident
// fabrication.

// Config-plane flag (migration 042 pattern) — envFallback () => false.
export const SINGAPORE_CS_KNOWLEDGE_FLAG_KEY = 'SINGAPORE_CS_KNOWLEDGE';

// Closed topic vocabulary — the retrieval router's SG lanes.
export const SG_KNOWLEDGE_TOPICS = Object.freeze([
  'gst',
  'corporate_tax',
  'acra_filings',
  'payroll_cpf',
  'pdpa',
  'record_keeping'
]);

// These pages were read live on as_of. Confirmation covers the cited page
// and excerpt, not an embedded, comprehensive corpus or eligibility verdict.
// Authority page moves are reflected in the deep links below.
export const SG_KNOWLEDGE_SOURCES = Object.freeze([
  Object.freeze({
    "id": "iras_gst_overview",
    "authority": "IRAS",
    "topic": "gst",
    "url": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)",
    "title": "Goods & Services Tax (GST)",
    "quote": "GST Registration/Deregistration",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  }),
  Object.freeze({
    "id": "iras_gst_f5_guide",
    "authority": "IRAS",
    "topic": "gst",
    "url": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst/completing-gst-returns",
    "title": "Completing GST Return",
    "quote": "Revenue",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  }),
  Object.freeze({
    "id": "iras_cit_overview",
    "authority": "IRAS",
    "topic": "corporate_tax",
    "url": "https://www.iras.gov.sg/taxes/corporate-income-tax/estimated-chargeable-income-(eci)-filing",
    "title": "Estimated Chargeable Income (ECI) Filing",
    "quote": "within 3 months",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  }),
  Object.freeze({
    "id": "iras_record_keeping",
    "authority": "IRAS",
    "topic": "record_keeping",
    "url": "https://www.iras.gov.sg/taxes/corporate-income-tax/basics-of-corporate-income-tax/record-keeping-requirements",
    "title": "Record Keeping Requirements",
    "quote": "at least 5 years",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  }),
  Object.freeze({
    "id": "acra_annual_return",
    "authority": "ACRA",
    "topic": "acra_filings",
    "url": "https://www.acra.gov.sg/manage/companies/legal-requirements-common-offences/filing-annual-returns-companies/deadline-requirements/",
    "title": "Deadline & requirements for annual returns",
    "quote": "Within seven months after FYE",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  }),
  Object.freeze({
    "id": "acra_xbrl",
    "authority": "ACRA",
    "topic": "acra_filings",
    "url": "https://www.acra.gov.sg/manage/companies/legal-requirements-common-offences/filing-financial-statements-in-xbrl-format/requirements-exemptions/",
    "title": "Financial statements: Filing requirements & exemptions",
    "quote": "Simplified XBRL",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  }),
  Object.freeze({
    "id": "mom_cpf_employment",
    "authority": "CPF Board",
    "topic": "payroll_cpf",
    "url": "https://www.cpf.gov.sg/employer",
    "title": "Central Provident Fund Board (CPFB)",
    "quote": "Who should receive CPF contributions",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  }),
  Object.freeze({
    "id": "pdpc_pdpa",
    "authority": "PDPC",
    "topic": "pdpa",
    "url": "https://www.pdpc.gov.sg/data-protection-obligations",
    "title": "Data Protection Obligations",
    "quote": "Retention Limitation Obligation",
    "as_of": "2026-09-24",
    "jurisdiction": "sg",
    "trust": "primary",
    "confirmed_content": true
  })
]);

const BY_ID = new Map(SG_KNOWLEDGE_SOURCES.map((s) => [s.id, s]));

// resolveKnowledgeSource(id) → the registry entry, or null.
export const resolveKnowledgeSource = (id) => BY_ID.get(String(id || '').trim()) || null;

// knowledgeSourcesForTopic(topic) → the registry entries for a topic lane.
export const knowledgeSourcesForTopic = (topic) => {
  const key = String(topic || '').trim().toLowerCase();
  return SG_KNOWLEDGE_SOURCES.filter((s) => s.topic === key);
};

// ---------------------------------------------------------------------------------
// The eval seed — the SG starter regression set (the Finnish CS eval
// architecture's shape: question → expected grounding + must-mention markers).
// ---------------------------------------------------------------------------------
// `kind` carries the FACT-vs-KNOWLEDGE fork explicitly so the eval also guards
// the routing: a 'knowledge' item must ground in the registry and NEVER
// escalate to the owner; a 'fact' item must become an owner ask and NEVER be
// answered from the registry. That routing is the self-service model's spine —
// the eval exists to keep it from regressing.
export const SG_CS_EVAL_SEED = Object.freeze([
  Object.freeze({
    id: 'gst_rate_current',
    kind: 'knowledge',
    question: 'What GST rate should be on my invoices right now?',
    expected_sources: Object.freeze(['iras_gst_overview']),
    must_mention: Object.freeze(['9%'])
  }),
  Object.freeze({
    id: 'gst_registration_threshold',
    kind: 'knowledge',
    question: 'At what revenue do I have to register for GST?',
    expected_sources: Object.freeze(['iras_gst_overview']),
    must_mention: Object.freeze(['S$1', 'million', 'exceeds'])
  }),
  Object.freeze({
    id: 'gst_filing_deadline',
    kind: 'knowledge',
    question: 'When is my GST return due after the quarter ends?',
    expected_sources: Object.freeze(['iras_gst_f5_guide']),
    must_mention: Object.freeze(['one month']),
    provenance: Object.freeze({
      url: 'https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst/due-dates-and-requests-for-extension',
      title: 'Due Dates and Requests for Extension',
      quote: 'due one month',
      as_of: '2026-09-24',
      confirmedAgainstPrimary: true
    })
  }),
  Object.freeze({
    id: 'eci_waiver',
    kind: 'knowledge',
    question: 'Do I need to file ECI if my company made no profit?',
    expected_sources: Object.freeze(['iras_cit_overview']),
    must_mention: Object.freeze(['S$5', 'nil'])
  }),
  Object.freeze({
    id: 'annual_return_deadline',
    kind: 'knowledge',
    question: 'When does my Pte Ltd have to file its annual return with ACRA?',
    expected_sources: Object.freeze(['acra_annual_return']),
    must_mention: Object.freeze(['7 months'])
  }),
  Object.freeze({
    id: 'record_retention',
    kind: 'knowledge',
    question: 'How long do I need to keep my receipts and invoices?',
    expected_sources: Object.freeze(['iras_record_keeping']),
    must_mention: Object.freeze(['5 years'])
  }),
  Object.freeze({
    id: 'charge_purpose_fact',
    kind: 'fact',
    question: 'What was the S$482.10 Grab charge on 12 June for?',
    expected_sources: Object.freeze([]),
    must_mention: Object.freeze([])
  }),
  Object.freeze({
    id: 'private_vs_business_fact',
    kind: 'fact',
    question: 'Is the Apple Store purchase on the DBS card business or personal?',
    expected_sources: Object.freeze([]),
    must_mention: Object.freeze([])
  })
]);
