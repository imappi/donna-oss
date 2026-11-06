// Marketing drafts queue — the slice-1 approval surface (/firms/marketing).
//
// Renders the PERSISTED outbound state (waitlist leads, proposed drafts with
// their model-id receipts, send receipts, per-channel authority stages) and
// gives Kari the two decisions a draft can take: Approve & send (the per-send
// approval that IS v1's only send authority) or Reject (terminal, training
// signal). Nothing here sends without a click; nothing rendered is inferred
// at view time (render-the-persisted-verdict rail).
//
// NOTE (design doc §8.1): Kari's chosen approval surface is the global admin
// chat. This panel is the slice-1 stand-in while the chat apply-spine work on
// the sibling track settles — same terminal states, same receipts, so moving
// the approve action into the chat later changes the surface, not the model.

import { useCallback, useEffect, useState } from 'react';

import { D } from '../shared/design-tokens.js';
import {
  approveAndSendDraft,
  decideProspect,
  fetchMarketingOverview,
  fetchProspectsOverview,
  generateNurtureDrafts,
  decideSocialPost,
  generateSocialPosts,
  investigateProspects,
  markSocialPublished,
  rejectDraft,
  scanCompaniesHouse,
  triageInbound,
  uploadProspects
} from '../../lib/marketingApi.js';

const mono = { fontFamily: D.mono, textTransform: 'uppercase', letterSpacing: '0.12em' };

const card = {
  border: `1px solid ${D.rule}`,
  background: D.paper,
  padding: '1rem 1.25rem',
  marginTop: '0.75rem'
};

const button = (variant) => ({
  appearance: 'none',
  border: variant === 'primary' ? 'none' : `1px solid ${D.rule}`,
  background: variant === 'primary' ? D.accentWarmFlat : 'transparent',
  color: D.ink,
  fontFamily: D.mono,
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  padding: '0.55rem 0.9rem',
  cursor: 'pointer'
});

// ── Prospecting Lab (P0 — dossiers only, zero sends) ─────────────────────────

const chip = (active) => ({
  appearance: 'none',
  border: `1px solid ${D.rule}`,
  background: active ? D.ink : 'transparent',
  color: active ? D.paper : D.ink,
  fontFamily: D.mono,
  fontSize: 10,
  letterSpacing: '0.06em',
  padding: '0.3rem 0.5rem',
  cursor: 'pointer'
});

// One dossier review card, rendered in the §6 order that keeps review under
// two minutes: why-now → recommended action → main risk → rubric → evidence
// (incl. the negative block) → drafted message. Renders PERSISTED dossier
// state only.
function ProspectCard({ prospect, rejectReasons, busy, onDecide }) {
  const [rejecting, setRejecting] = useState(false);
  const [picked, setPicked] = useState([]);
  const dossier = prospect.dossier || {};
  const rubric = dossier.rubric || {};
  const signal = dossier.disorder_signal || {};
  const fit = dossier.fit || {};
  const contact = dossier.contact || {};

  const toggleReason = (reason) =>
    setPicked((prev) => (prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]));

  return (
    <div style={card}>
      <div style={{ ...mono, fontSize: 10, color: D.inkSoft }}>
        {prospect.company_name}
        {prospect.company_number ? ` · ${prospect.company_number}` : ''} · {prospect.jurisdiction} · tier {prospect.tier} ·{' '}
        {(Array.isArray(prospect.campaigns) ? prospect.campaigns : []).join(', ') || 'no campaign tags'} · {prospect.dossier_model}
      </div>

      <div style={{ fontWeight: 600, margin: '0.5rem 0 0.2rem' }}>{dossier.why_now}</div>
      <div style={{ ...mono, fontSize: 10, margin: '0.2rem 0' }}>
        Donna recommends: <strong>{String(dossier.recommended_action || '').replace('_', ' ')}</strong> · confidence {dossier.confidence}
      </div>
      <div style={{ fontSize: '0.88rem', margin: '0.3rem 0' }}>Main risk: {dossier.main_risk}</div>

      <div style={{ ...mono, fontSize: 10, color: D.inkSoft, margin: '0.5rem 0' }}>
        {Object.entries(rubric).map(([dim, score]) => `${dim.replace(/_/g, ' ')} ${score}`).join(' · ')}
      </div>

      <details style={{ fontSize: '0.88rem', margin: '0.4rem 0' }}>
        <summary style={{ cursor: 'pointer' }}>Evidence</summary>
        <p style={{ margin: '0.5rem 0 0.2rem' }}>
          <strong>Signal:</strong> {signal.summary} <em>({signal.citation})</em>
        </p>
        <p style={{ margin: '0.2rem 0' }}>
          <strong>Fit:</strong>{' '}
          {Object.entries(fit).map(([gate, verdict]) => `${gate.replace(/_/g, ' ')}: ${verdict}`).join(' · ')}
        </p>
        {dossier.fit_evidence && <p style={{ margin: '0.2rem 0', color: D.inkSoft }}>{dossier.fit_evidence}</p>}
        {dossier.jurisdiction_check?.basis && (
          <p style={{ margin: '0.2rem 0' }}><strong>Lawful basis:</strong> {dossier.jurisdiction_check.basis}</p>
        )}
        <p style={{ margin: '0.2rem 0' }}>
          <strong>Contact:</strong>{' '}
          {contact.email
            ? `${contact.email} — published at ${contact.published_where || 'unknown'}`
            : 'no business-published address found'}
        </p>
        <p style={{ margin: '0.4rem 0 0.2rem' }}><strong>Against (negative evidence):</strong></p>
        <ul style={{ margin: '0.2rem 0 0.2rem 1.1rem', padding: 0 }}>
          {(dossier.negative_evidence || []).map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
        {prospect.source_note && (
          <p style={{ margin: '0.4rem 0 0.2rem', color: D.inkSoft }}>Source hypothesis: {prospect.source_note}</p>
        )}
      </details>

      {dossier.message && (
        <details style={{ fontSize: '0.88rem', margin: '0.4rem 0' }}>
          <summary style={{ cursor: 'pointer' }}>Drafted message — {dossier.message.subject}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: D.body, fontSize: '0.88rem', lineHeight: 1.5, margin: '0.5rem 0 0' }}>
            {dossier.message.body}
          </pre>
        </details>
      )}

      {!rejecting && (
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.7rem', flexWrap: 'wrap' }}>
          <button type="button" style={button('primary')} disabled={busy} onClick={() => onDecide(prospect, { action: 'approve' })}>
            Approve
          </button>
          <button type="button" style={button('secondary')} disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </button>
          <button type="button" style={button('secondary')} disabled={busy} onClick={() => onDecide(prospect, { action: 'hold' })}>
            Hold
          </button>
          <button type="button" style={button('secondary')} disabled={busy} onClick={() => onDecide(prospect, { action: 'research_only' })}>
            Research only
          </button>
        </div>
      )}
      {rejecting && (
        <div style={{ marginTop: '0.7rem' }}>
          <div style={{ ...mono, fontSize: 10, color: D.inkSoft, marginBottom: '0.4rem' }}>Why? (pick at least one — this is the lab&apos;s learning signal)</div>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {rejectReasons.map((reason) => (
              <button key={reason} type="button" style={chip(picked.includes(reason))} onClick={() => toggleReason(reason)}>
                {reason.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.6rem' }}>
            <button
              type="button"
              style={button('primary')}
              disabled={busy || picked.length === 0}
              onClick={() => onDecide(prospect, { action: 'reject', rejectReasons: picked })}
            >
              Confirm reject
            </button>
            <button type="button" style={button('secondary')} disabled={busy} onClick={() => { setRejecting(false); setPicked([]); }}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MarketingDrafts() {
  const [overview, setOverview] = useState(null);
  const [prospectsView, setProspectsView] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [uploadText, setUploadText] = useState('');
  const [uploadCampaigns, setUploadCampaigns] = useState('');
  const [uploadTier, setUploadTier] = useState('green');
  const [scanMode, setScanMode] = useState('overdue');
  const [scanSic, setScanSic] = useState('');
  const [scanDryRun, setScanDryRun] = useState(true);

  const reload = useCallback(async () => {
    try {
      setError('');
      const [drafts, prospects] = await Promise.all([
        fetchMarketingOverview(),
        fetchProspectsOverview()
      ]);
      setOverview(drafts);
      setProspectsView(prospects);
    } catch (err) {
      setError(err.message || 'Could not load marketing state.');
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onGenerate = async () => {
    setBusyId('generate');
    setNotice('');
    try {
      const result = await generateNurtureDrafts();
      const refusals = (result.refused || []).length;
      setNotice(
        `${(result.minted || []).length} draft(s) proposed${refusals ? `, ${refusals} refused by the claim checklist` : ''}.`
      );
      await reload();
    } catch (err) {
      setError(err.message || 'Draft generation failed.');
    } finally {
      setBusyId('');
    }
  };

  const onGenerateSocial = async () => {
    setBusyId('social-generate');
    setNotice('');
    try {
      const result = await generateSocialPosts({});
      const refusals = (result.refused || []).length;
      setNotice(`${(result.minted || []).length} post(s) proposed${refusals ? `, ${refusals} refused by the validator` : ''}.`);
      await reload();
    } catch (err) {
      setError(err.message || 'Social generation failed.');
    } finally {
      setBusyId('');
    }
  };

  const onDecideSocial = async (post, action) => {
    setBusyId(post.id);
    setNotice('');
    try {
      await decideSocialPost(post.id, action);
      await reload();
    } catch (err) {
      setError(err.message || 'Decision failed.');
    } finally {
      setBusyId('');
    }
  };

  const onMarkPublished = async (post) => {
    const url = window.prompt('Paste the live post URL (the publish receipt):', 'https://x-com.example/your_handle_here/status/');
    if (!url) return;
    setBusyId(post.id);
    setNotice('');
    try {
      await markSocialPublished(post.id, url);
      setNotice('Published — receipt recorded.');
      await reload();
    } catch (err) {
      setError(err.message || 'Publish receipt failed.');
    } finally {
      setBusyId('');
    }
  };

  const onCopyPost = async (post) => {
    try {
      await navigator.clipboard.writeText(post.body);
      setNotice('Post copied — paste it on X, then mark it published with the URL.');
    } catch {
      setError('Clipboard blocked — select and copy the text manually.');
    }
  };

  const onTriage = async () => {
    setBusyId('triage');
    setNotice('');
    try {
      const result = await triageInbound();
      setNotice(
        result.considered === 0
          ? 'Nothing untriaged.'
          : `${result.triaged}/${result.considered} triaged · ${result.drafts_minted} draft(s) proposed${result.escalations ? ` · ${result.escalations} on you` : ''}${result.errors?.length ? ` · ${result.errors.length} error(s)` : ''}`
      );
      await reload();
    } catch (err) {
      setError(err.message || 'Reply triage failed.');
    } finally {
      setBusyId('');
    }
  };

  const onApprove = async (draft) => {
    const confirmed = window.confirm(
      `Send this email to ${draft.lead_email}?\n\nSubject: ${draft.subject}\n\nThis is an outbound send — it cannot be recalled.`
    );
    if (!confirmed) return;
    setBusyId(draft.id);
    setNotice('');
    try {
      const result = await approveAndSendDraft(draft.id);
      setNotice(`Sent to ${draft.lead_email} — receipt ${result.receipt_id}.`);
      await reload();
    } catch (err) {
      setError(err.violations ? `${err.message} (${err.violations.join('; ')})` : err.message || 'Send failed.');
    } finally {
      setBusyId('');
    }
  };

  const onReject = async (draft) => {
    setBusyId(draft.id);
    setNotice('');
    try {
      await rejectDraft(draft.id);
      await reload();
    } catch (err) {
      setError(err.message || 'Reject failed.');
    } finally {
      setBusyId('');
    }
  };

  const onUpload = async () => {
    setBusyId('upload');
    setNotice('');
    try {
      const result = await uploadProspects({ text: uploadText, campaigns: uploadCampaigns, tier: uploadTier });
      const parts = [`${(result.minted || []).length} candidate(s) minted`];
      if ((result.already_live || []).length) parts.push(`${result.already_live.length} already live`);
      if ((result.skipped || []).length) {
        parts.push(`${result.skipped.length} skipped: ${result.skipped.map((s) => `line ${s.line} (${s.reason})`).join('; ')}`);
      }
      setNotice(parts.join(' · '));
      setUploadText('');
      await reload();
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setBusyId('');
    }
  };

  const onInvestigate = async () => {
    setBusyId('investigate');
    setNotice('');
    try {
      const result = await investigateProspects();
      const refusals = (result.refused || []).length;
      setNotice(
        result.considered === 0
          ? 'No candidates to investigate.'
          : `${(result.on_kari || []).length} dossier(s) on you${refusals ? ` · ${refusals} refused: ${result.refused.map((r) => `${r.company_name} (${r.violations.join('; ')})`).join(' · ')}` : ''}`
      );
      await reload();
    } catch (err) {
      setError(err.message || 'Investigation failed.');
    } finally {
      setBusyId('');
    }
  };

  const onScan = async () => {
    setBusyId('scan');
    setNotice('');
    try {
      const result = await scanCompaniesHouse({
        mode: scanMode,
        sicCodes: scanSic,
        campaigns: uploadCampaigns,
        dryRun: scanDryRun
      });
      const parts = [
        `${result.searched} companies searched`,
        result.dry_run
          ? `${(result.candidates || []).length} WOULD mint (dry run): ${(result.candidates || []).map((c) => c.companyName).join(', ') || 'none'}`
          : `${(result.minted || []).length} candidate(s) minted`
      ];
      if ((result.already_live || []).length) parts.push(`${result.already_live.length} already live`);
      if ((result.skipped || []).length) parts.push(`${result.skipped.length} skipped (first: ${result.skipped[0].reason})`);
      setNotice(parts.join(' · '));
      await reload();
    } catch (err) {
      setError(err.message || 'Scan failed.');
    } finally {
      setBusyId('');
    }
  };

  const onDecideProspect = async (prospect, { action, rejectReasons }) => {
    setBusyId(prospect.id);
    setNotice('');
    try {
      await decideProspect(prospect.id, { action, rejectReasons });
      setNotice(`${prospect.company_name}: ${action.replace('_', ' ')} recorded.`);
      await reload();
    } catch (err) {
      setError(err.message || 'Decision failed.');
    } finally {
      setBusyId('');
    }
  };

  const leads = overview?.leads || [];
  const open = overview?.drafts_open || [];
  const settled = overview?.drafts_settled || [];
  const receipts = overview?.receipts || [];
  const prospects = prospectsView?.prospects || [];
  const onKariProspects = prospects.filter((p) => p.status === 'on_kari');
  const prospectCounts = prospects.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
  const rejectReasonVocab = prospectsView?.vocab?.reject_reasons || [];

  return (
    <div style={{ minHeight: '100vh', background: D.paper, color: D.ink, fontFamily: D.body, padding: 'clamp(1.5rem, 4vw, 3rem)' }}>
      <main style={{ maxWidth: 780, margin: '0 auto' }}>
        <a href="/firms" style={{ ...mono, fontSize: 10, color: D.inkSoft, textDecoration: 'none' }}>← Firms</a>
        <h1 style={{ fontFamily: D.display, fontWeight: 400, fontSize: 34, letterSpacing: '-0.04em', textTransform: 'uppercase', margin: '0.75rem 0 0.25rem' }}>
          Marketing
        </h1>
        <p style={{ fontSize: '0.92rem', color: D.inkSoft, margin: 0, maxWidth: '58ch' }}>
          Waitlist nurture — every send needs your per-send approval. Channel authority:{' '}
          {(overview?.authority || []).map((a) => `${a.channel} = ${a.stage}`).join(' · ') || '…'}
          {overview && !overview.email_enabled && ' — RESEND NOT CONFIGURED (sends will refuse)'}
        </p>

        {error && <p style={{ color: 'oklch(0.5 0.19 27)', fontSize: '0.9rem', marginTop: '1rem' }}>{error}</p>}
        {notice && <p style={{ color: 'oklch(0.45 0.11 150)', fontSize: '0.9rem', marginTop: '1rem' }}>{notice}</p>}

        <section style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={{ ...mono, fontSize: 12, margin: 0 }}>Proposed drafts · {open.length}</h2>
            <button type="button" style={button('secondary')} disabled={busyId === 'generate'} onClick={onGenerate}>
              {busyId === 'generate' ? 'Drafting…' : 'Draft for new leads'}
            </button>
          </div>
          {open.length === 0 && (
            <p style={{ fontSize: '0.88rem', color: D.inkSoft }}>Nothing awaiting you — every draft is settled.</p>
          )}
          {open.map((draft) => (
            <div key={draft.id} style={card}>
              <div style={{ ...mono, fontSize: 10, color: D.inkSoft }}>
                {draft.lead_email} · {draft.channel === 'reply' ? `reply · ${draft.segment}` : `segment ${draft.segment}`} · {draft.model} · {draft.status}
                {draft.send_error ? ` · last send failed: ${draft.send_error}` : ''}
              </div>
              <div style={{ fontWeight: 600, margin: '0.5rem 0' }}>{draft.subject}</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: D.body, fontSize: '0.9rem', lineHeight: 1.5, margin: '0 0 0.9rem' }}>
                {draft.body}
              </pre>
              <div style={{ display: 'flex', gap: '0.6rem' }}>
                <button type="button" style={button('primary')} disabled={busyId === draft.id} onClick={() => onApprove(draft)}>
                  {busyId === draft.id ? 'Sending…' : 'Approve & send'}
                </button>
                <button type="button" style={button('secondary')} disabled={busyId === draft.id} onClick={() => onReject(draft)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </section>

        <section style={{ marginTop: '2.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ ...mono, fontSize: 12, margin: 0 }}>Social · @your_handle_here · open: {(overview?.social_open || []).length}</h2>
            <button type="button" style={button('secondary')} disabled={busyId === 'social-generate'} onClick={onGenerateSocial}>
              {busyId === 'social-generate' ? 'Drafting…' : 'Draft posts'}
            </button>
          </div>
          <p style={{ fontSize: '0.85rem', color: D.inkSoft, margin: '0.4rem 0 0' }}>
            B1: Donna drafts, you approve per post, you paste on X, then record the live URL — the receipt. Nothing publishes itself.
          </p>
          {(overview?.social_open || []).map((post) => (
            <div key={post.id} style={card}>
              <div style={{ ...mono, fontSize: 10, color: D.inkSoft }}>
                {post.kind.replace(/_/g, ' ')} · {post.model} · {post.status}
                {post.source_context?.angle ? ` · ${post.source_context.angle}` : ''}
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: D.body, fontSize: '0.9rem', lineHeight: 1.5, margin: '0.5rem 0 0.9rem' }}>
                {post.body}
              </pre>
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                {post.status === 'proposed' && (
                  <>
                    <button type="button" style={button('primary')} disabled={busyId === post.id} onClick={() => onDecideSocial(post, 'approve')}>
                      Approve
                    </button>
                    <button type="button" style={button('secondary')} disabled={busyId === post.id} onClick={() => onDecideSocial(post, 'reject')}>
                      Reject
                    </button>
                  </>
                )}
                {post.status === 'approved' && (
                  <>
                    <button type="button" style={button('primary')} disabled={busyId === post.id} onClick={() => onCopyPost(post)}>
                      Copy post
                    </button>
                    <button type="button" style={button('secondary')} disabled={busyId === post.id} onClick={() => onMarkPublished(post)}>
                      Mark published…
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {(overview?.social_open || []).length === 0 && (
            <p style={{ fontSize: '0.88rem', color: D.inkSoft }}>No posts awaiting you.</p>
          )}
          {(overview?.social_settled || []).length > 0 && (
            <p style={{ ...mono, fontSize: 10, color: D.inkSoft, marginTop: '0.75rem' }}>
              Settled:{' '}
              {overview.social_settled
                .map((p) => `${p.status}${p.published_url ? ` (${p.published_url})` : ''}`)
                .join(' · ')}
            </p>
          )}
        </section>

        <section style={{ marginTop: '2.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ ...mono, fontSize: 12, margin: 0 }}>Prospecting lab · dossiers on you: {onKariProspects.length}</h2>
            <button type="button" style={button('secondary')} disabled={busyId === 'investigate'} onClick={onInvestigate}>
              {busyId === 'investigate' ? 'Investigating…' : 'Investigate candidates'}
            </button>
          </div>
          <p style={{ fontSize: '0.85rem', color: D.inkSoft, margin: '0.4rem 0 0' }}>
            P0: dossiers only — approving a prospect stages it for the (not yet built) send slice; nothing is emailed from here.
            {' '}
            {Object.entries(prospectCounts).map(([status, count]) => `${status.replace(/_/g, ' ')}: ${count}`).join(' · ') || 'No prospects yet.'}
          </p>

          {(prospectsView?.due?.due_total || 0) > 0 && (
            <div style={{ ...card, padding: '0.7rem 1rem', borderColor: D.accentWarmFlat }}>
              <div style={{ ...mono, fontSize: 10, marginBottom: '0.35rem' }}>
                Clock · {prospectsView.due.due_total} due —{' '}
                {Object.entries(prospectsView.due.counts)
                  .filter(([, n]) => n > 0)
                  .map(([kind, n]) => `${kind.replace(/_/g, ' ')}: ${n}`)
                  .join(' · ')}
              </div>
              {prospectsView.due.due.slice(0, 8).map((d) => (
                <div key={d.id} style={{ fontSize: '0.8rem', color: D.inkSoft }}>
                  {d.company_name} · {d.status.replace(/_/g, ' ')} · {d.due_kind.replace(/_/g, ' ')}
                  {d.due_since ? ` · since ${String(d.due_since).slice(0, 10)}` : ''}
                </div>
              ))}
              {prospectsView.due.due.length > 8 && (
                <div style={{ fontSize: '0.8rem', color: D.inkSoft }}>…and {prospectsView.due.due.length - 8} more.</div>
              )}
            </div>
          )}

          <div style={{ ...card, padding: '0.9rem 1rem' }}>
            <div style={{ ...mono, fontSize: 10, color: D.inkSoft, marginBottom: '0.5rem' }}>
              Manual upload — CSV (name, company_number, country, website, email, signal, campaigns, tier) or one company per line
            </div>
            <textarea
              value={uploadText}
              onChange={(e) => setUploadText(e.target.value)}
              rows={4}
              placeholder={'name,country,signal\nAcme Design Ltd,UK,hiring a part-time bookkeeper'}
              style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${D.rule}`, background: 'transparent', color: D.ink, fontFamily: D.mono, fontSize: 12, padding: '0.5rem' }}
            />
            <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={uploadCampaigns}
                onChange={(e) => setUploadCampaigns(e.target.value)}
                placeholder="campaign tags (e.g. micro_agencies)"
                style={{ border: `1px solid ${D.rule}`, background: 'transparent', color: D.ink, fontFamily: D.mono, fontSize: 11, padding: '0.45rem 0.6rem', minWidth: '16rem' }}
              />
              <select
                value={uploadTier}
                onChange={(e) => setUploadTier(e.target.value)}
                style={{ border: `1px solid ${D.rule}`, background: 'transparent', color: D.ink, fontFamily: D.mono, fontSize: 11, padding: '0.45rem 0.4rem' }}
              >
                {(prospectsView?.vocab?.tiers || ['green', 'yellow', 'red']).map((tier) => (
                  <option key={tier} value={tier}>tier: {tier}</option>
                ))}
              </select>
              <button type="button" style={button('primary')} disabled={busyId === 'upload' || !uploadText.trim()} onClick={onUpload}>
                {busyId === 'upload' ? 'Minting…' : 'Add candidates'}
              </button>
            </div>
          </div>

          <div style={{ ...card, padding: '0.9rem 1rem' }}>
            <div style={{ ...mono, fontSize: 10, color: D.inkSoft, marginBottom: '0.5rem' }}>
              Companies House scan — UK, SIC-filtered; reads the canonical accounts.next_accounts block. Campaign tags come from the field above. Start with a dry run.
            </div>
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={scanMode}
                onChange={(e) => setScanMode(e.target.value)}
                style={{ border: `1px solid ${D.rule}`, background: 'transparent', color: D.ink, fontFamily: D.mono, fontSize: 11, padding: '0.45rem 0.4rem' }}
              >
                <option value="overdue">overdue accounts</option>
                <option value="first_filing">first filing approaching</option>
              </select>
              <input
                value={scanSic}
                onChange={(e) => setScanSic(e.target.value)}
                placeholder="SIC codes (e.g. 70229, 73110)"
                style={{ border: `1px solid ${D.rule}`, background: 'transparent', color: D.ink, fontFamily: D.mono, fontSize: 11, padding: '0.45rem 0.6rem', minWidth: '14rem' }}
              />
              <label style={{ ...mono, fontSize: 10, color: D.inkSoft, display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={scanDryRun} onChange={(e) => setScanDryRun(e.target.checked)} />
                dry run
              </label>
              <button type="button" style={button('primary')} disabled={busyId === 'scan' || !scanSic.trim()} onClick={onScan}>
                {busyId === 'scan' ? 'Scanning…' : 'Scan'}
              </button>
            </div>
          </div>

          {onKariProspects.map((prospect) => (
            <ProspectCard
              key={prospect.id}
              prospect={prospect}
              rejectReasons={rejectReasonVocab}
              busy={busyId === prospect.id}
              onDecide={onDecideProspect}
            />
          ))}

          {(prospectsView?.source_runs || []).length > 0 && (
            <p style={{ ...mono, fontSize: 10, color: D.inkSoft, marginTop: '0.75rem' }}>
              Recent source runs:{' '}
              {prospectsView.source_runs
                .map((run) => `${run.source} ${run.started_at?.slice(0, 10) || ''} (${run.prospects_minted}/${run.candidates_found} minted${run.error ? `, error: ${run.error}` : ''})`)
                .join(' · ')}
            </p>
          )}
        </section>

        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={{ ...mono, fontSize: 12, margin: 0 }}>Waitlist leads · {leads.length}</h2>
          {leads.map((lead) => (
            <div key={lead.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.4rem 0', borderBottom: `1px solid ${D.rule}`, fontSize: '0.88rem' }}>
              <span>{lead.email}</span>
              <span style={{ ...mono, fontSize: 10, color: D.inkSoft }}>
                {lead.reason} · {lead.suppressed ? 'suppressed' : lead.status}
              </span>
            </div>
          ))}
        </section>

        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={{ ...mono, fontSize: 12, margin: 0 }}>Recent receipts · {receipts.length}</h2>
          {receipts.map((r) => (
            <div key={r.id} style={{ padding: '0.4rem 0', borderBottom: `1px solid ${D.rule}`, fontSize: '0.85rem', color: D.inkSoft }}>
              {r.sent_at} — {r.lead_email} · approved by {r.approved_by} · {r.authority} · {r.model}
              {r.transport_message_id ? ` · resend:${r.transport_message_id}` : ''}
            </div>
          ))}
          {settled.length > 0 && (
            <p style={{ ...mono, fontSize: 10, color: D.inkSoft, marginTop: '0.75rem' }}>
              Settled drafts: {settled.map((d) => `${d.lead_email} (${d.status})`).join(' · ')}
            </p>
          )}
        </section>

        <section style={{ marginTop: '2.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ ...mono, fontSize: 12, margin: 0 }}>Inbound · {(overview?.inbound || []).length}</h2>
            <button type="button" style={button('secondary')} disabled={busyId === 'triage'} onClick={onTriage}>
              {busyId === 'triage' ? 'Triaging…' : 'Triage replies'}
            </button>
          </div>
          <p style={{ fontSize: '0.85rem', color: D.inkSoft, margin: '0.4rem 0 0' }}>
            M3 classifies deterministically and receipts every event; M4&apos;s strong-model triage reads the persisted
            replies (hourly, or the button) and proposes response drafts above — nothing sends without your approval.
          </p>
          {(overview?.inbound || []).map((m) => (
            <div key={m.id} style={{ padding: '0.4rem 0', borderBottom: `1px solid ${D.rule}`, fontSize: '0.85rem', color: D.inkSoft }}>
              <div>
                {(m.received_at || m.created_at || '').slice(0, 16)} — {m.from_email || m.event_type} ·{' '}
                {String(m.classification).replace(/_/g, ' ')}
                {m.subject ? ` · ${m.subject}` : ''}
                {m.matched_lead_email ? ` · lead:${m.matched_lead_email}` : ''}
                {m.forwarded_to ? ' · forwarded' : ''}
                {m.error ? ` · ERROR: ${m.error}` : ''}
              </div>
              {m.triage_class && (
                <div style={{ ...mono, fontSize: 10, marginTop: '0.15rem', color: ['hostile_or_sensitive', 'investor_or_press'].includes(m.triage_class) ? 'oklch(0.5 0.19 27)' : D.inkSoft }}>
                  triage: {String(m.triage_class).replace(/_/g, ' ')} ({m.triage_confidence}) · {String(m.triage_recommended_action || '').replace(/_/g, ' ')}
                  {m.triage_draft_id ? ' · draft proposed' : ''}
                  {m.triage_model ? ` · ${m.triage_model}` : ''}
                  {m.triage_summary ? <span style={{ textTransform: 'none', letterSpacing: 0 }}> — {m.triage_summary}</span> : null}
                </div>
              )}
            </div>
          ))}
          {(overview?.inbound || []).length === 0 && (
            <p style={{ fontSize: '0.85rem', color: D.inkSoft }}>Nothing received yet.</p>
          )}
        </section>
      </main>
    </div>
  );
}
