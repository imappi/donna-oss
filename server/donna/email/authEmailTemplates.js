// Branded HTML for the Supabase auth emails, rendered server-side from the repo
// (version-controlled) so they go out through the Send-Email hook + Resend with
// Donna branding instead of GoTrue's default "powered by Supabase" template.
//
// These are PURE functions (no I/O) so the mapping action-type → {subject,html}
// is unit-testable. The hook (authEmailHook.js) calls renderAuthEmail and hands
// the result to resendClient.sendEmail.
//
// Link construction: when a Send-Email hook is active, GoTrue does NOT build the
// confirmation URL for us — we build the standard verify link ourselves from the
// project URL + the token_hash GoTrue passed in email_data. The link hits
// GoTrue's /auth/v1/verify, which then redirects to `redirect_to` (our funnel
// already sets that to <origin>/start for signups; /reset-password for recovery).

const BRAND_RED = '#d0021b';
const BRAND_GOLD = '#f5a623';
const PAPER = '#f6f3ee';
const INK = '#1c1a17';

const esc = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// The standard GoTrue verification link. token_hash + type + redirect_to is the
// documented shape for hook-rendered emails.
export const buildVerifyUrl = ({ supabaseUrl, tokenHash, type, redirectTo } = {}) => {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('token', tokenHash || '');
  params.set('type', type || '');
  if (redirectTo) params.set('redirect_to', redirectTo);
  return `${base}/auth/v1/verify?${params.toString()}`;
};

// Shared brand shell. `bodyHtml` is the action-specific middle. `preheader`, when
// set, is the hidden inbox preview line (shown next to the subject in most
// clients) — a small but real commercial lever.
const shell = ({ bodyHtml, footerNote, preheader }) => `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:${PAPER};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">
    ${preheader ? `<span style="display:none !important;max-height:0;overflow:hidden;opacity:0;color:${PAPER};">${esc(preheader)}</span>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #ece6dc;">
            <tr>
              <td style="background:linear-gradient(135deg,${BRAND_GOLD},${BRAND_RED});padding:28px 32px;">
                <span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background:#ffffff;color:${BRAND_RED};font-weight:800;font-size:20px;border-radius:8px;">D</span>
                <span style="color:#ffffff;font-weight:700;font-size:18px;margin-left:10px;vertical-align:middle;">Donna</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #ece6dc;font-size:12px;color:#9a948a;">
                ${footerNote}<br /><br />
                Donna, by Example Operator Ltd. &middot; support@books.example
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

const ctaBlock = ({ url, label }) => `
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;">
                  <tr>
                    <td style="border-radius:10px;background:${BRAND_RED};">
                      <a href="${esc(url)}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;border-radius:10px;">${esc(label)}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#7a746b;">
                  If the button does not work, copy this link into your browser:<br />
                  <a href="${esc(url)}" style="color:${BRAND_RED};word-break:break-all;">${esc(url)}</a>
                </p>`;

const linkBody = ({ heading, intro, extra, url, cta }) => `
                <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;">${esc(heading)}</h1>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#44403a;">${esc(intro)}</p>
                ${ctaBlock({ url, label: cta })}
                ${extra ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#7a746b;">${esc(extra)}</p>` : ''}`;

// Per-action copy. `type` is the GoTrue verify type for the link.
const ACTIONS = {
  signup: {
    type: 'signup',
    subject: 'Confirm your email and Donna gets started',
    preheader: 'One click to confirm, then Donna gets to work on your books.',
    heading: "You're almost in.",
    intro: "Thanks for signing up. Confirm your email and you're set. Then tell Donna your monthly volume, connect your bank statements, and she gets to work.",
    extra: 'Donna reads your statements, receipts, and invoices, codes every line, and posts clean double-entry to your books. The judgment calls get a human. Your month-end stops piling up.',
    cta: 'Confirm my email',
    footerNote: "You're getting this because someone signed up for Donna with this address. If that wasn't you, ignore it and nothing happens."
  },
  recovery: {
    type: 'recovery',
    subject: 'Reset your Donna password',
    heading: 'Reset your password',
    intro: 'We got a request to reset the password for your Donna account. Click below to choose a new one. The link expires shortly.',
    cta: 'Set a new password',
    footerNote: 'If you did not ask to reset your password, you can ignore this email and your password stays the same.'
  },
  magiclink: {
    type: 'magiclink',
    subject: 'Your Donna sign-in link',
    heading: 'Sign in to Donna',
    intro: 'Click below to sign in. The link expires shortly and can be used once.',
    cta: 'Sign in to Donna',
    footerNote: 'If you did not request this link, you can ignore this email.'
  },
  invite: {
    type: 'invite',
    subject: 'You are invited to Donna',
    heading: 'You are invited to Donna',
    intro: 'You have been invited to Donna. Accept the invitation to set up your account and get started.',
    cta: 'Accept the invitation',
    footerNote: 'If you were not expecting this invitation, you can ignore this email.'
  },
  email_change: {
    type: 'email_change',
    subject: 'Confirm your new email for Donna',
    heading: 'Confirm your new email',
    intro: 'Confirm this address to finish changing the email on your Donna account.',
    cta: 'Confirm new email',
    footerNote: 'If you did not request this change, contact us at support@books.example.'
  }
};

// Reauthentication is a 6-digit code, not a link.
const renderCodeEmail = ({ code }) => ({
  subject: 'Your Donna verification code',
  html: shell({
    bodyHtml: `
                <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;">Your verification code</h1>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#44403a;">Enter this code to confirm it is you. It expires shortly.</p>
                <p style="margin:0;font-size:30px;font-weight:800;letter-spacing:6px;color:${BRAND_RED};">${esc(code)}</p>`,
    footerNote: 'If you did not request this code, you can ignore this email.'
  })
});

// Map a Supabase Send-Email hook payload's email_data into { subject, html }.
// Unknown action types fall back to the signup-style link email so the hook
// NEVER drops an email it does not recognise (a hook that returns nothing fails
// the auth action — defensiveness here protects signup).
export const renderAuthEmail = ({
  emailActionType,
  supabaseUrl,
  tokenHash,
  tokenHashNew,
  token,
  redirectTo
} = {}) => {
  if (emailActionType === 'reauthentication') {
    return renderCodeEmail({ code: token });
  }
  const cfg = ACTIONS[emailActionType] || ACTIONS.signup;
  const hash = tokenHash || tokenHashNew || '';
  const url = buildVerifyUrl({ supabaseUrl, tokenHash: hash, type: cfg.type, redirectTo });
  return {
    subject: cfg.subject,
    html: shell({
      bodyHtml: linkBody({ heading: cfg.heading, intro: cfg.intro, extra: cfg.extra, url, cta: cfg.cta }),
      footerNote: cfg.footerNote,
      preheader: cfg.preheader
    })
  };
};
