// Donna — public marketing info/legal pages (FAQ · Terms · Privacy · Security).
//
// These back the footer links on the landing page (`DonnaLanding.jsx`). They
// are real, routed pages (App.jsx maps `/faq` `/terms` `/privacy` `/security`
// here) rather than the old mailto stubs.
//
// FAQ + Security copy is deliberately plain-language and matched to what the
// product actually does — per the CLAUDE.md brand rail, Donna runs the books,
// shows what she did, and asks when owner facts, approval, or specialist
// judgment are needed. Do not let copy drift toward hidden-reviewer language,
// and do not add security/compliance claims the system can't honestly back
// (e.g. a named certification we don't hold).
//
// Terms + Privacy: the public source release carries no operator's legal
// terms. Whoever runs Donna for others writes their own and puts them here.

import { D } from '../shared/design-tokens.js';
import { PUBLIC_AVAILABILITY_LABEL } from '../../lib/publicAvailability.js';

const CONTACT_EMAIL = 'support@books.example';
// The operator's contact address; set your own.
const SECURITY_EMAIL = CONTACT_EMAIL;
// The operating entity behind Donna, surfaced on the legal pages.
const OPERATOR = 'Example Operator Ltd.';
// Effective/last-updated date for the legal pages. Bump when the copy changes
// materially.
const EFFECTIVE_DATE = 'November 3, 2026';

const inkA = (alpha) => `oklch(0.08 0 0 / ${alpha})`;
const serif = "'Instrument Serif', 'Source Serif 4', Georgia, serif";
const monoCaps = { fontFamily: D.mono, textTransform: 'uppercase' };

// ── Page content ─────────────────────────────────────────────────────────────
// Each page is { title, intro, sections:[{ heading, body:[...] }] }. A body
// entry is a string (paragraph) or { list:[...] } (bullet list).
const PAGES = {
  faq: {
    eyebrow: 'Help',
    title: 'Frequently asked questions',
    intro:
      `Donna keeps the books for service businesses in ${PUBLIC_AVAILABILITY_LABEL}. Not software you operate. A bookkeeper that does the work and finishes it.`,
    sections: [
      {
        heading: 'What is Donna?',
        body: [
          'Donna is an autonomous bookkeeper. She reads your bank statements, receipts, and invoices, codes every transaction the way a sharp bookkeeper would, and posts real double-entry to your own Xero, with QuickBooks and more integrations on the way. She works continuously, so your books stay current instead of piling up for month-end. When a transaction needs a call she can’t make on her own, she asks you — and for specialist tax or accounting judgment, she flags it and prepares a handoff to your accountant.'
        ]
      },
      {
        heading: 'How is this different from bookkeeping software?',
        body: [
          'Software gives you tools and leaves the work to you. Donna does the work. You don’t categorize transactions, chase receipts, or reconcile anything. Donna does it and closes it, and asks you only when a call is genuinely yours to make.'
        ]
      },
      {
        heading: 'Who is Donna for?',
        body: [
          `Service and commerce businesses in ${PUBLIC_AVAILABILITY_LABEL} — creators and agencies count as service businesses. Single-entity, cash or accrual. For commerce, Donna reconciles your payouts, fees, refunds, and bank evidence and closes the month; full inventory/COGS accounting isn’t part of the promise — anything beyond scope goes to a human. We keep that focus on purpose. It’s how Donna stays fast and accurate. Behind on past months? Catch me up closes them too. If your business is genuinely more complex, we’ll tell you before you pay, not after.`,
          'Finland is not publicly advertised. Invited Finnish owners can still use the existing signup path under their separate pilot arrangement.'
        ]
      },
      {
        heading: 'What if Donna gets something wrong?',
        body: [
          'Donna posts the calls she’s sure about and flags the rest. She works the flags, fixes what she can, and asks you the one question only you can answer when something is truly unclear. Your books stay yours. You can question or change anything.'
        ]
      },
      {
        heading: 'Is my data safe?',
        body: [
          'Your documents and data live in our own managed database, encrypted in transit and at rest. Donna posts to your accounting system through a connection you authorize and can revoke anytime. We never sell your data, and we never let AI providers train on it.'
        ]
      },
      {
        heading: 'How do I start?',
        body: [
          'Create an account and send one recent bank statement. Donna takes it from there. Anything else, email ' + CONTACT_EMAIL + '.'
        ]
      }
    ]
  },
  terms: {
    eyebrow: 'Legal',
    title: 'Terms of Service',
    intro: 'This is a source release of Donna. It comes with no service, and so with no terms of service.',
    sections: [
      {
        heading: 'If you run Donna for others',
        body: [
          'Write your own terms of service and put them on this page before anyone else uses your deployment. The software itself is licensed under the Apache License 2.0; see LICENSE in the repository.'
        ]
      }
    ]
  },
  privacy: {
    eyebrow: 'Legal',
    title: 'Privacy Policy',
    intro: 'This is a source release of Donna. It comes with no service, and so with no privacy policy.',
    sections: [
      {
        heading: 'If you run Donna for others',
        body: [
          'Write your own privacy policy and put it on this page before anyone else uses your deployment. Say which providers process the data, such as your database host and the model providers you call, and where.'
        ]
      }
    ]
  },
  // The Claude Desktop extension landing (MCP surface, docs/design-donna-mcp-
  // surface.md §8 item 4). Copy rails, binding: sells the CLOSE, not the chat;
  // the §2 data-posture statement stated plainly (tool results reach the Claude
  // model in Anthropic's cloud — bridge register, NO custody slogans); promises
  // nothing v1 doesn't do (five read-only tools; anything else is explicitly
  // "not yet"); no prices anywhere. Pinned by claudeExtensionCopy.test.js.
  claude: {
    eyebrow: 'Claude + Donna',
    title: 'Ask Claude what’s blocking the close',
    intro:
      'The Donna extension for Claude Desktop connects Claude to the Donna app running on your Mac. Donna keeps the books; Claude becomes the place you ask about them — what’s blocking the close, who still owes documents, what got done overnight.',
    sections: [
      {
        heading: 'What you can ask',
        body: [
          'The extension gives Claude a small set of read-only views into your books. In practice, that sounds like:',
          {
            list: [
              '“What’s blocking the close this month?” — open blockers, bucket counts, and the questions waiting on you.',
              '“Which businesses still owe us documents?” — outstanding document and evidence requests, per business.',
              '“What did Donna do overnight?” — her recent actions, straight from the audit trail.',
              '“Show me the unmatched items for the studio.” — unresolved transactions and documents, paginated.',
              '“Which businesses are connected?” — the businesses you’ve chosen to expose, with a close-status summary.'
            ]
          },
          'That is the whole v1 surface — five read-only views. Anything you don’t see here, it doesn’t do yet.'
        ]
      },
      {
        heading: 'Read-only by construction',
        body: [
          'Claude cannot post, approve, file, or send anything through this extension. There is no write path to route a mutation through — the tool registry only contains reads. Every call Claude makes is recorded in Donna’s audit trail, attributed to the extension, before the answer is returned.'
        ]
      },
      {
        heading: 'You choose what Claude sees',
        body: [
          'No business is visible until you expose it inside Donna — per business, off by default, in Settings → AI chat access (one consent covers the extension, the ChatGPT app and the Claude connector). A business you haven’t exposed answers exactly like one that doesn’t exist. You can turn any business off again at any time, and a client reset clears its exposure with it.'
        ]
      },
      {
        heading: 'Where your data goes',
        body: [
          'Plainly: the connection between Claude Desktop and Donna is local to your machine, but the results of each call — the book data Claude reads — are sent to the Claude model in Anthropic’s cloud, like anything else you put in a Claude conversation. Enabling the extension for a business is a data-routing decision, which is exactly why it is off by default and per business.'
        ]
      },
      {
        heading: 'Try it before connecting anything',
        body: [
          'No Donna installed? The extension still works: it answers from a clearly labeled built-in sample company, so you can ask “what’s blocking the close?” and see the experience before connecting real books. Every sample answer says it is demo data — it never mixes with a live Donna.'
        ]
      },
      {
        heading: 'Requirements and availability',
        body: [
          'You’ll need Claude Desktop and the Donna app for Mac (for real books; the built-in sample company works without Donna). We are preparing the extension’s listing in the Claude connector directory — until it’s live, write to ' + CONTACT_EMAIL + ' for early access.'
        ]
      }
    ]
  },
  security: {
    eyebrow: 'Trust',
    title: 'Security',
    intro:
      'Donna handles sensitive financial data, so security is part of the product, not an afterthought. Here is how we protect it during the beta.',
    sections: [
      {
        heading: 'Encryption',
        body: [
          'All traffic to and from Donna is encrypted in transit (TLS). Data stored in our managed database is encrypted at rest by our infrastructure providers.'
        ]
      },
      {
        heading: 'Access and authentication',
        body: [
          'You sign in with a password or with Google. Access to a firm’s data is scoped and authenticated on every request, and operator actions inside Donna are recorded to an audit trail so changes are traceable.'
        ]
      },
      {
        heading: 'Connected accounting systems',
        body: [
          'Donna writes to your accounting system using a connection you authorize, with the narrowest scope needed, and which you can revoke at any time. Pushing entries to your ledger is a deliberate, separate step from corrections made inside Donna.'
        ]
      },
      {
        heading: 'Infrastructure',
        body: [
          'We build on established cloud infrastructure for hosting, database, and AI processing. We limit internal access to production data to what is required to operate and support the service.'
        ]
      },
      {
        heading: 'Reporting a vulnerability',
        body: [
          'If you believe you have found a security issue, please email ' + SECURITY_EMAIL + ' with the details. We appreciate responsible disclosure and will work with you to confirm and address valid reports.'
        ]
      }
    ]
  }
};

// Map of route path → page key. App.jsx resolves the pathname against this.
export const MARKETING_PAGE_ROUTES = {
  '/faq': 'faq',
  '/terms': 'terms',
  '/privacy': 'privacy',
  '/security': 'security',
  '/claude': 'claude'
};

export const resolveMarketingPageKey = (pathname) => {
  if (typeof pathname !== 'string') return null;
  const clean = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  return MARKETING_PAGE_ROUTES[clean] || null;
};

const BodyBlock = ({ entry }) => {
  if (entry && typeof entry === 'object' && Array.isArray(entry.list)) {
    return (
      <ul style={{ margin: '0 0 1.1rem', padding: '0 0 0 1.1rem', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        {entry.list.map((item) => (
          <li key={item} style={{ fontFamily: D.body, fontSize: '1rem', lineHeight: 1.6, color: inkA(0.74) }}>
            {item}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p style={{ fontFamily: D.body, fontSize: '1rem', lineHeight: 1.65, color: inkA(0.74), margin: '0 0 1.1rem', maxWidth: '64ch' }}>
      {entry}
    </p>
  );
};

const MarketingPage = ({ pageKey }) => {
  const page = PAGES[pageKey];
  if (!page) {
    // Defensive — App.jsx only mounts this for a resolved key, but never 404
    // into a blank screen.
    return (
      <div style={{ minHeight: '100vh', background: D.paper, color: D.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: D.body }}>
        <p>Page not found. <a href="/" style={{ color: D.ink }}>Back to Donna</a></p>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: D.paper,
        color: D.ink,
        fontFamily: D.body,
        WebkitFontSmoothing: 'antialiased',
        display: 'flex',
        justifyContent: 'center',
        padding: 'clamp(2.5rem, 6vh, 5rem) clamp(1.5rem, 5vw, 3rem)'
      }}
    >
      <div style={{ width: '100%', maxWidth: '46rem' }}>
        <a
          href="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            ...monoCaps,
            fontSize: 11,
            letterSpacing: '0.16em',
            color: inkA(0.55),
            textDecoration: 'none',
            marginBottom: '2.5rem'
          }}
        >
          <span aria-hidden="true">←</span>
          <span>Donna</span>
        </a>

        <p style={{ ...monoCaps, fontSize: 11, letterSpacing: '0.22em', color: inkA(0.5), margin: '0 0 0.9rem' }}>
          {page.eyebrow}
        </p>
        <h1
          style={{
            fontFamily: serif,
            fontWeight: 400,
            fontSize: 'clamp(2.2rem, 4vw, 3.1rem)',
            lineHeight: 1.05,
            letterSpacing: '-0.01em',
            margin: '0 0 1.25rem'
          }}
        >
          {page.title}
        </h1>
        <p style={{ fontFamily: D.body, fontSize: '1.05rem', lineHeight: 1.6, color: inkA(0.62), margin: '0 0 2.75rem', maxWidth: '60ch' }}>
          {page.intro}
        </p>

        {page.sections.map((section) => (
          <section key={section.heading} id={section.id} style={{ margin: '0 0 2.25rem', scrollMarginTop: '2rem' }}>
            <h2
              style={{
                fontFamily: D.body,
                fontWeight: 600,
                fontSize: '1.15rem',
                lineHeight: 1.3,
                letterSpacing: '-0.005em',
                margin: '0 0 0.85rem',
                color: D.ink
              }}
            >
              {section.heading}
            </h2>
            {section.body.map((entry, i) => (
              <BodyBlock key={i} entry={entry} />
            ))}
          </section>
        ))}

        {/* Legal footer (effective date + operator) — legal pages only; the
            FAQ and the Claude-extension product page carry no effective date. */}
        {pageKey !== 'faq' && pageKey !== 'claude' && (
          <p style={{ ...monoCaps, fontSize: 10.5, letterSpacing: '0.14em', color: inkA(0.45), margin: '2.5rem 0 0', borderTop: `1px solid ${inkA(0.12)}`, paddingTop: '1.25rem' }}>
            Effective {EFFECTIVE_DATE} · {OPERATOR}
          </p>
        )}
      </div>
    </div>
  );
};

export default MarketingPage;
