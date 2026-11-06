// Dossier drafter — the load-bearing investigation call of the Prospecting
// Lab (P0D of docs/design-donna-prospecting.md §6).
//
// Trust-the-strong-LLM, applied to prospecting: give the strong model the
// candidate reference (identity + the source's signal hypothesis + campaign
// tags), let it investigate PUBLIC facts with the provider's web-search tool,
// and render what it says. Kari's per-dossier approve/reject (+§10A reasons)
// is the cheap correction surface. No hand-written scoring heuristics — the
// deterministic layer is prospectLab.validateDossier, which REFUSES rail
// violations (no signal / no citation / empty negative-evidence / guessed fit
// / rail-violating message) at the writer; it never substitutes judgment.
//
// API shape (verified against the OpenAI docs, 2026-07-06): the Responses API
// takes built-in tools via `tools: [{ type: 'web_search' }]` and combines
// them with structured outputs under `text.format` (json_schema). Never-guess
// still applies to the LIVE account: the first production run must confirm
// the model + account support web_search; a provider error surfaces as an
// honest 503, never as a silently un-researched dossier.

import { BANDS, RECURRING_MONTHLY_PRICE, fmt } from '../../../src/lib/pricing.js';
import { UNSUBSCRIBE_PLACEHOLDER } from './marketingOutbound.js';
import { getOpenAiConfig, outputTextFromResponse } from './openAiConfig.js';
import { RECOMMENDED_ACTIONS, RUBRIC_DIMENSIONS, tierCapabilities } from './prospectLab.js';

const FIT_GATES = ['service_business', 'volume_under_1000', 'single_entity', 'country_in_icp'];
const FIT_ENUM = ['yes', 'no', 'unknown'];

export const buildDossierInstructions = ({ includeMessage }) => [
  'You are the investigator for Donna, a done-for-you AI bookkeeping service for small single-entity businesses in the US, UK, Singapore, and Australia, run by a hands-on founder (Kari, Donna). Donna sells by DIAGNOSING: it finds a real, publicly-verifiable sign that a business\'s books need help, explains it, and offers the specific fix — never volume outbound.',
  '',
  'You are given one candidate business (its name, any registry number, website, the signal hypothesis that made a human or scan surface it, and campaign tags). Investigate it using web search on PUBLIC sources only — the company\'s own website, public registries (e.g. Companies House), public reviews and posts. Then produce a dossier: your case for (or against) contacting this business.',
  '',
  'Non-negotiable rules — a deterministic validator refuses dossiers that break them:',
  '- NO SIGNAL, NO DOSSIER. The disorder/lifecycle signal must be a specific, true, publicly-verifiable fact with a citation (URL or registry reference, plus when you observed it). The source\'s signal hypothesis is a HYPOTHESIS — verify it; if you cannot verify a real signal, say so plainly in the summary and recommend reject: the validator will refuse the dossier and that is the correct outcome.',
  '- NEVER GUESS A GATE. Each fit gate is yes/no/unknown with the evidence basis stated. An unknown is stated, never rounded up to "fit". Transaction-volume estimates must name their (weak) basis — headcount, locations, reviews.',
  '- ARGUE AGAINST YOURSELF. The negative-evidence block is mandatory: list what might make this prospect NOT fit (thin website, can\'t verify trading, looks inventory-heavy, dormant/micro-entity accounts, multiple entities, payment-sensitive category…). An empty block is refused.',
  '- CONTACT LEGITIMACY. Only report a contact address the business itself published (its website, its registry filing). Record WHERE it was published (URL) and why it is role-relevant. Never invent, scrape databases, or use third-party contact brokers. If no legitimate published address exists, contact.email is null — that is a finding, not a failure.',
  '- JURISDICTION CHECK. UK: the target must be a limited company or LLP (corporate subscriber under PECR); sole traders are off-limits. US: CAN-SPAM (honest headers, opt-out). Singapore: artisanal 1:1 sends only. Australia: inferred consent requires a conspicuously published, role-relevant address with no "no unsolicited messages" note — record the publication URL. State the basis for this prospect.',
  '- The rubric scores each dimension 1 (weak) to 3 (strong). Score honestly; a 3 needs externally-visible evidence.',
  `- recommended_action is one of ${RECOMMENDED_ACTIONS.join(' / ')}. "research_only" is for strategically interesting but not-sendable-today segments (payment-sensitive, unclear legality). When in doubt, recommend reject or hold — the founder\'s time is the scarce resource.`,
  '',
  includeMessage
    ? [
        'Also draft the 1:1 message (subject + plain-text body) Kari would send:',
        '- It must reference the SPECIFIC cited signal and offer the specific fix. No fake familiarity, no "I noticed you…" theater beyond what the evidence actually shows, no invented urgency.',
        '- Identify Donna honestly (AI bookkeeping service run by a hands-on founder). Never pretend to be a customer, applicant, or anything else.',
        `- The honest promise (re-amended 2026-07-23): Donna runs the books herself — no human back office, no bookkeeper reviewing or finishing the work; she shows what she did, answers questions from a curated base of high-trust accounting and tax sources, and asks the owner only for facts about their business only they can know. NEVER say "human-reviewed"/"human-monitored"/"review", never guarantee outcomes, never say it replaces an accountant, never set-and-forget.`,
        `- Prices, only if relevant: one-off/catch-up closes from ${fmt(Math.min(...BANDS.map((b) => b.price)))} per month-close by volume; ongoing subscription flat ${fmt(RECURRING_MONTHLY_PRICE)}/month. Never invent other numbers.`,
        `- Plain text, under 150 words, founder-personal, zero marketing gloss. Subject: specific and honest, no "Re:"/"Fwd:". The body MUST end with a short opt-out line containing the literal placeholder ${UNSUBSCRIBE_PLACEHOLDER}.`
      ].join('\n')
    : 'Do NOT draft an outreach message for this prospect: its segment tier is research-only for messaging (message generation requires an explicit sign-off that does not exist). Produce the dossier fields only.'
].join('\n');

const buildDossierSchema = ({ includeMessage }) => {
  const properties = {
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['company_name', 'company_number', 'company_type', 'website', 'industry'],
      properties: {
        company_name: { type: 'string' },
        company_number: { type: ['string', 'null'], description: 'Registry number if verified, else null.' },
        company_type: { type: ['string', 'null'], description: 'e.g. ltd, LLP, LLC, sole trader — as verified.' },
        website: { type: ['string', 'null'] },
        industry: { type: ['string', 'null'], description: 'SIC code or plain-language industry.' }
      }
    },
    disorder_signal: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'citation', 'observed_at'],
      properties: {
        summary: { type: 'string', description: 'The specific, verifiable disorder/lifecycle signal. Empty string if none could be verified.' },
        citation: { type: 'string', description: 'Where this is publicly verifiable: URL or registry reference. Empty string if none.' },
        observed_at: { type: 'string', description: 'When you observed the signal (ISO date).' }
      }
    },
    fit: {
      type: 'object',
      additionalProperties: false,
      required: FIT_GATES,
      properties: Object.fromEntries(FIT_GATES.map((gate) => [gate, { type: 'string', enum: FIT_ENUM }]))
    },
    fit_evidence: { type: 'string', description: 'The evidence basis for each fit verdict, including the (weak) basis of any volume estimate.' },
    jurisdiction_check: {
      type: 'object',
      additionalProperties: false,
      required: ['basis', 'notes'],
      properties: {
        basis: { type: 'string', description: 'Why contacting this prospect is lawful in its jurisdiction (e.g. UK PECR corporate subscriber: verified ltd company).' },
        notes: { type: 'string' }
      }
    },
    contact: {
      type: 'object',
      additionalProperties: false,
      required: ['email', 'published_where', 'role_relevance'],
      properties: {
        email: { type: ['string', 'null'], description: 'Business-published address, or null if none found.' },
        published_where: { type: ['string', 'null'], description: 'URL where the business itself published this address.' },
        role_relevance: { type: ['string', 'null'], description: 'Why this address is role-relevant to bookkeeping/finance.' }
      }
    },
    why_now: { type: 'string', description: 'One line: why this business, why now. The first thing Kari reads.' },
    main_risk: { type: 'string', description: 'One line: the main risk of engaging this prospect.' },
    negative_evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'Mandatory: what might make this prospect NOT fit.'
    },
    rubric: {
      type: 'object',
      additionalProperties: false,
      required: [...RUBRIC_DIMENSIONS],
      // Range enforced by prospectLab.validateDossier (strict structured
      // outputs reject numeric-range keywords, so the description carries it).
      properties: Object.fromEntries(RUBRIC_DIMENSIONS.map((dim) => [dim, { type: 'integer', description: '1 (weak) to 3 (strong).' }]))
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    recommended_action: { type: 'string', enum: [...RECOMMENDED_ACTIONS] }
  };
  const required = Object.keys(properties);
  if (includeMessage) {
    properties.message = {
      description: 'The drafted 1:1 message; null when recommending against contact.',
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['subject', 'body'],
          properties: {
            subject: { type: 'string' },
            body: { type: 'string', description: `Plain-text body ending with an opt-out line containing ${UNSUBSCRIBE_PLACEHOLDER}.` }
          }
        },
        { type: 'null' }
      ]
    };
    required.push('message');
  }
  return { type: 'object', additionalProperties: false, required, properties };
};

// The investigation input: everything the lab knows about the candidate.
// source_note is the SOURCE's signal hypothesis (to verify, not to trust);
// campaigns are the GTM hypotheses being tested (campaign ≠ source).
export const buildDossierInput = (prospect = {}) => ({
  candidate: {
    company_name: prospect.company_name,
    company_number: prospect.company_number || null,
    jurisdiction: prospect.jurisdiction,
    website: prospect.website || null,
    contact_email_on_file: prospect.contact_email || null
  },
  source: prospect.source,
  signal_hypothesis: prospect.source_note || null,
  campaigns: prospect.campaigns || [],
  tier: prospect.tier,
  tier_capabilities: tierCapabilities(prospect.tier)
});

const drafterUnavailable = (message) => {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = 'DOSSIER_DRAFTER_UNAVAILABLE';
  return error;
};

// Investigate one prospect and return { dossier, model } where `model` is the
// provider-RETURNED id (the receipt — stamped on the row by attachDossier).
// Validation is NOT done here: prospectLab.validateDossier runs as the
// attachDossier writer precondition, so an invalid dossier can never reach
// the queue whatever the caller does.
export const draftProspectDossier = async ({ prospect, fetchImpl = fetch, openAiConfig = null } = {}) => {
  const config = openAiConfig || getOpenAiConfig();
  if (!config.apiKey) {
    throw drafterUnavailable('OpenAI API key is not configured; the dossier drafter has no fallback by design.');
  }

  const includeMessage = tierCapabilities(prospect.tier).can_generate_message;
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      instructions: buildDossierInstructions({ includeMessage }),
      input: JSON.stringify(buildDossierInput(prospect)),
      store: false,
      tools: [{ type: 'web_search' }],
      text: {
        format: {
          type: 'json_schema',
          name: 'prospect_dossier',
          strict: true,
          schema: buildDossierSchema({ includeMessage })
        }
      }
    })
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw drafterUnavailable(errorBody?.error?.message || `OpenAI dossier request failed with ${response.status}.`);
  }

  const payload = await response.json();
  let dossier = null;
  try {
    dossier = JSON.parse(outputTextFromResponse(payload));
  } catch {
    throw drafterUnavailable('OpenAI returned an unreadable dossier.');
  }
  if (!includeMessage) dossier.message = null;

  return { dossier, model: payload.model || config.model };
};
