import { useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Badge } from './Badge.jsx';
import {
  buildProfileFromIntakeDraft,
  buildQueueFromIntakeProfile,
  DOCUMENT_KIND_MESSAGE_IDS,
  documentKindLabel,
  formatDraftAddress
} from '../lib/intakeDraft.js';
import { routeIntakeDocumentToPipeline } from '../lib/intakeUpload.js';
import { withAccessHeaders } from '../lib/accessToken.js';
import { BidiText } from '../i18n/BidiText.jsx';
import { legalFormCompatibility } from '../lib/legalForms.js';

// "Drop anything" venture intake. One strong-LLM call
// (/api/donna/bizfile/intake-draft) turns any identity-bearing document
// — a registry extract from any jurisdiction, a bank statement, a tax
// notice, an invoice — into a draft profile. The draft renders as
// EDITABLE fields: the bookkeeper corrects what the model got wrong and
// clicks Create. Multi-party documents (invoices, contracts) surface
// every other named party one click away — picking the wrong party is
// the one real ambiguity class, so the correction is a button, not a
// re-upload.

const fileToBase64 = (file, readError) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() : result);
    };
    reader.onerror = () => reject(new Error(readError));
    reader.readAsDataURL(file);
  });

const requestIntakeDraft = async (payload, messages) => {
  const response = await fetch('/api/donna/bizfile/intake-draft', {
    method: 'POST',
    headers: withAccessHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body?.code === 'REQUEST_BODY_TOO_LARGE') {
      throw new Error(messages.tooLarge);
    }
    // A body without our `error` key means the response never came from
    // the intake handler (platform 404/413/504) — surface the status so
    // the failure self-identifies instead of hiding behind a generic
    // string. When the handler DID answer, it also names code + reason
    // (openai_not_configured, timeout, openai_401, …); render them so the
    // error on screen is its own receipt instead of a guess prompt.
    const detail = [body?.code, body?.reason].filter(Boolean).join(': ');
    const message = body?.error || messages.httpError(response.status);
    throw new Error(detail ? `${message} (${detail})` : message);
  }
  return { draft: body.draft, processingReview: body.processing_review || { available: false } };
};

const TEXT_EXTENSIONS = /\.(txt|text|csv|md)$/i;

const FirmNewEntity = ({ onCreateEntity, onCancel, dataSource = 'local' }) => {
  const intl = useIntl();
  const fileInputRef = useRef(null);
  const [sourceFile, setSourceFile] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [draft, setDraft] = useState(null);
  const [processingAvailability, setProcessingAvailability] = useState({ available: false });
  const [bookkeepingStartDate, setBookkeepingStartDate] = useState('');
  const [processingFactsConfirmed, setProcessingFactsConfirmed] = useState(false);
  // The dropped file, held as base64 so it can become the client's
  // first pipeline document after Create. Null for paste/text intake
  // (no storage path for those) and kept in lockstep with the draft —
  // a stale file must never ride along with a draft from a different
  // source.
  const [intakeFile, setIntakeFile] = useState(null);
  const [billingEmail, setBillingEmail] = useState('');
  const [xeroConnected, setXeroConnected] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [creating, setCreating] = useState(false);
  const message = (id, values) => intl.formatMessage({ id }, values);
  const kindLabel = (kind) => message(
    DOCUMENT_KIND_MESSAGE_IDS[kind] || 'mounted.venture.kind.document'
  );

  // The draft is the single editable state: field edits merge straight
  // into it, so the preview/profile builder always sees the corrected
  // values.
  const patchDraft = (patch) => {
    setProcessingFactsConfirmed(false);
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  const nativeProcessingAvailable = dataSource === 'database' && processingAvailability.available === true
    && draft?.jurisdiction?.toUpperCase() === 'SG';
  const processingReview = useMemo(() => nativeProcessingAvailable ? {
    selection_id: processingAvailability.selection_id,
    bookkeeping_start_date: bookkeepingStartDate,
    currency: draft.default_currency,
    accounting_view: 'management_books', accounting_system: 'none'
  } : null, [nativeProcessingAvailable, processingAvailability.selection_id, bookkeepingStartDate, draft?.default_currency]);

  // FI-14: the hosted company birth accepts a Finnish company only as an
  // osakeyhtiö (server FI_HOSTED_LEGAL_FORM_UNSUPPORTED, hostedFirmIntake.js).
  // Read the draft through the same shared normalizer the server uses, so an
  // unsupported or missing form is explained here and Create stays closed —
  // the server refusal is never the first time the firm hears of it.
  const hostedFinnish = dataSource === 'database' && draft?.jurisdiction?.trim().toUpperCase() === 'FI';
  const finnishForm = hostedFinnish
    ? legalFormCompatibility({ jurisdiction: 'FI', entityType: draft.entity_type }).canonical
    : null;
  const finnishFormRefusal = !hostedFinnish || finnishForm === 'fi-oy'
    ? null
    : (draft.entity_type?.trim() ? 'mounted.venture.fiFormUnsupported' : 'mounted.venture.fiFormMissing');

  // A US company created in database mode without an accounting-system
  // connection keeps its books on Donna's own ledger; say so on the profile.
  const donnaLedger = dataSource === 'database' && !xeroConnected && !processingReview
    && draft?.jurisdiction?.toUpperCase() === 'US';

  const previewProfile = useMemo(
    () =>
      draft?.company_name
        ? buildProfileFromIntakeDraft(draft, { billingEmail, xeroConnected, sourceFile, processingReview, donnaLedger })
        : null,
    [billingEmail, draft, sourceFile, xeroConnected, processingReview, donnaLedger]
  );
  const previewQueue = useMemo(
    () =>
      previewProfile
        ? buildQueueFromIntakeProfile(previewProfile, {
            sourceFile,
            processingReview,
            sourceKindLabel: documentKindLabel(draft?.document_kind)
          })
        : [],
    [draft, previewProfile, sourceFile, processingReview]
  );

  const runIntake = async (payload, sourceLabel, fileForPipeline = null) => {
    setReading(true);
    setStatus(message('mounted.venture.reading'));
    setError('');
    setProcessingFactsConfirmed(false);
    setBookkeepingStartDate('');
    try {
      const result = await requestIntakeDraft(payload, {
        tooLarge: message('mounted.venture.tooLarge'),
        httpError: (httpStatus) => message('mounted.venture.readHttpError', { status: httpStatus })
      });
      const nextDraft = result.draft;
      setProcessingAvailability(result.processingReview);
      if (result.processingReview.available) setXeroConnected(false);
      setDraft(nextDraft);
      setSourceFile(sourceLabel);
      setIntakeFile(fileForPipeline);
      setStatus(message('mounted.venture.kindRead', { kind: kindLabel(nextDraft.document_kind) }));
    } catch (err) {
      setError(err.message || message('mounted.venture.readError'));
      setStatus('');
    } finally {
      setReading(false);
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type.startsWith('text/') || TEXT_EXTENSIONS.test(file.name)) {
      const text = await file.text();
      await runIntake({ text, filename: file.name }, file.name);
      return;
    }
    try {
      const base64 = await fileToBase64(file, message('mounted.venture.fileReadError'));
      await runIntake(
        { filename: file.name, data_base64: base64, mime_type: file.type || 'application/pdf' },
        file.name,
        { filename: file.name, base64, mimeType: file.type || 'application/pdf' }
      );
    } catch (err) {
      setError(err.message || message('mounted.venture.fileReadError'));
      setStatus('');
    }
  };

  const handlePastedText = async () => {
    if (!pastedText.trim()) return;
    await runIntake({ text: pastedText }, sourceFile || message('mounted.venture.pastedText'));
  };

  // Flip the client to another party named on the document. The old
  // pick joins other_parties so the flip is reversible.
  const choosePartyAs = (party) => {
    if (!draft) return;
    const remaining = (draft.other_parties || []).filter((name) => name !== party);
    if (draft.company_name) remaining.push(draft.company_name);
    patchDraft({
      company_name: party,
      legal_names: [],
      other_parties: remaining,
      chosen_party_reasoning: 'Party chosen by the bookkeeper at intake.'
    });
  };

  const handleCreate = async () => {
    if (!previewProfile || finnishFormRefusal) return;
    if (nativeProcessingAvailable && (!processingFactsConfirmed || !bookkeepingStartDate || draft.default_currency !== 'SGD')) return;
    setCreating(true);
    setError('');
    try {
      const clientId = await onCreateEntity(previewProfile, previewQueue, processingReview);
      // Route the intake document into the new client's pipeline as its
      // first upload — a bank statement carries the whole feed, so
      // onboarding ends with reconciliation already started. Fire and
      // forget: the client exists either way, onCreateEntity has already
      // navigated to the workspace, and the UploadTray is the surface
      // for progress/failure (including the orphan-retry path).
      if (dataSource === 'database' && intakeFile) {
        routeIntakeDocumentToPipeline({
          clientId: clientId || previewProfile.id,
          filename: intakeFile.filename,
          base64: intakeFile.base64,
          mimeType: intakeFile.mimeType,
          documentKind: draft?.document_kind
        }).catch(() => {});
      }
    } catch (err) {
      setError(err.message || message('mounted.venture.createError'));
      setCreating(false);
    }
  };

  const addressText = draft ? formatDraftAddress(draft.registered_address || {}) : '';
  const confidencePct = draft ? Math.round((draft.extraction_confidence || 0) * 100) : 0;

  return (
    <section className="firm-new-entity" aria-label={message('mounted.sidebar.addVenture')}>
      <div className="firm-new-entity__header">
        <div>
          <div className="firm-workspace__eyebrow">{message('mounted.sidebar.addVenture')}</div>
          <h1>{message('mounted.venture.title')}</h1>
        </div>
        <button className="btn btn-outline" type="button" onClick={onCancel}>
          {message('mounted.venture.cancel')}
        </button>
      </div>

      <div className="firm-new-entity__grid">
        <section className="firm-panel">
          <div className="firm-panel__top">
            <h2>{message('mounted.venture.source')}</h2>
            {status && <span><BidiText direction="auto">{status}</BidiText></span>}
          </div>
          <div className="firm-form">
            {reading && (
              <div
                className="firm-intake-progress"
                role="progressbar"
                aria-busy="true"
                aria-label={status || message('mounted.venture.reading')}
              >
                <span className="firm-intake-progress__bar" />
              </div>
            )}
            <div className="firm-field">
              <span>
                {message('mounted.venture.sourceHint')}
              </span>
              {dataSource === 'database' && (
                <span data-testid="fi-oy-only">{message('mounted.venture.fiOyOnly')}</span>
              )}
              <div className="firm-file-picker">
              <input
                ref={fileInputRef}
                className="firm-file-picker__input"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.text,.csv,application/pdf,image/*,text/plain"
                onChange={handleFileChange}
                disabled={reading}
                aria-label={message('mounted.venture.chooseFile')}
                aria-hidden="true"
                tabIndex={-1}
                hidden
              />
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={reading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {message('mounted.venture.chooseFile')}
                </button>
                <span className="firm-file-picker__name">
                  {sourceFile
                    ? <BidiText direction="auto">{sourceFile}</BidiText>
                    : message('mounted.venture.noFile')}
                </span>
              </div>
            </div>
            <label className="firm-field">
              <span>{message('mounted.venture.paste')}</span>
              <textarea
                value={pastedText}
                onChange={(event) => setPastedText(event.target.value)}
                rows={8}
              />
            </label>
            <button
              className="btn btn-outline"
              type="button"
              disabled={!pastedText.trim() || reading}
              onClick={handlePastedText}
            >
              {message(reading ? 'mounted.venture.readingEllipsis' : 'mounted.venture.readPaste')}
            </button>
            {error && <div className="firm-form__error"><BidiText direction="auto">{error}</BidiText></div>}
          </div>
        </section>

        <section className="firm-panel">
          <div className="firm-panel__top">
            <h2>{message('mounted.venture.handoff')}</h2>
          </div>
          <div className="firm-form">
            <label className="firm-field">
              <span>{message('mounted.venture.billingEmail')}</span>
              <input
                type="email"
                value={billingEmail}
                onChange={(event) => setBillingEmail(event.target.value)}
              />
            </label>
            <label className="firm-check">
              <input
                type="checkbox"
                checked={xeroConnected}
                disabled={nativeProcessingAvailable}
                onChange={(event) => setXeroConnected(event.target.checked)}
              />
              <span>{message('mounted.venture.tenant')}</span>
            </label>
          </div>
        </section>

        {draft && (
          <section className="firm-panel firm-panel--wide">
            <div className="firm-panel__top">
              <h2><BidiText direction="auto">{draft.company_name || message('mounted.venture.unnamed')}</BidiText></h2>
              <span>
                {message('mounted.venture.confidence', { kind: kindLabel(draft.document_kind), percent: confidencePct })}
              </span>
            </div>

            {draft.other_parties?.length > 0 && (
              <div className="firm-form__warning" role="status">
                <strong>{message('mounted.venture.multiple')}</strong>{' '}
                <BidiText direction="auto">{draft.chosen_party_reasoning || message('mounted.venture.multipleFallback')}</BidiText>{' '}
                {message('mounted.venture.multipleAction')}
                <div className="firm-new-entity__actions">
                  {draft.other_parties.map((party) => (
                    <button
                      key={party}
                      className="btn btn-outline"
                      type="button"
                      onClick={() => choosePartyAs(party)}
                    >
                      {message('mounted.venture.useParty', { party })}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {draft.warnings?.length > 0 && (
              <div className="firm-form__warning" role="status">
                <BidiText direction="auto">{draft.warnings.join(' ')}</BidiText>
              </div>
            )}

            <div className="firm-form">
              <label className="firm-field">
                <span>{message('mounted.venture.company')}</span>
                <input
                  type="text"
                  value={draft.company_name || ''}
                  onChange={(event) => patchDraft({ company_name: event.target.value })}
                />
              </label>
              <label className="firm-field">
                <span>{message('mounted.venture.aliases')}</span>
                <input
                  type="text"
                  value={(draft.legal_names || []).join(', ')}
                  onChange={(event) =>
                    patchDraft({
                      legal_names: event.target.value
                        .split(',')
                        .map((name) => name.trim())
                        .filter(Boolean)
                    })
                  }
                />
              </label>
              <label className="firm-field">
                <span>{message(
                  draft.jurisdiction_basis ? 'mounted.venture.jurisdictionBasis' : 'mounted.venture.jurisdiction',
                  { basis: draft.jurisdiction_basis || '' }
                )}</span>
                <input
                  type="text"
                  maxLength={2}
                  value={draft.jurisdiction || ''}
                  onChange={(event) => patchDraft({ jurisdiction: event.target.value.toUpperCase() })}
                />
              </label>
              <label className="firm-field">
                <span>{message('mounted.venture.currency')}</span>
                <input
                  type="text"
                  maxLength={3}
                  value={draft.default_currency || ''}
                  onChange={(event) => patchDraft({ default_currency: event.target.value.toUpperCase() })}
                />
              </label>
              <label className="firm-field">
                <span><BidiText direction="auto">{draft.registration_number_kind || message('mounted.venture.registration')}</BidiText></span>
                <input
                  type="text"
                  value={draft.registration_number || ''}
                  onChange={(event) => patchDraft({ registration_number: event.target.value })}
                />
              </label>
              <label className="firm-field">
                <span>{message('mounted.venture.entityType')}</span>
                <input
                  type="text"
                  value={draft.entity_type || ''}
                  onChange={(event) => patchDraft({ entity_type: event.target.value })}
                />
              </label>
            </div>

            {finnishFormRefusal && (
              <div className="firm-form__warning" role="alert" data-testid="fi-form-refusal">
                {message(finnishFormRefusal)}
              </div>
            )}

            {nativeProcessingAvailable && (
              <fieldset className="firm-form">
                <legend>{message('mounted.venture.processingTitle')}</legend>
                <p>{message('mounted.venture.processingLimit')}</p>
                <label className="firm-field">
                  <span>{message('mounted.venture.bookkeepingStart')}</span>
                  <input type="date" value={bookkeepingStartDate} required
                    onChange={event => { setBookkeepingStartDate(event.target.value); setProcessingFactsConfirmed(false); }} />
                </label>
                <label className="firm-check">
                  <input type="checkbox" checked={processingFactsConfirmed}
                    disabled={!bookkeepingStartDate || draft.default_currency !== 'SGD'}
                    onChange={event => setProcessingFactsConfirmed(event.target.checked)} />
                  <span>{message('mounted.venture.processingConfirm')}</span>
                </label>
                <p>{message('mounted.venture.processingGstUnknown')}</p>
              </fieldset>
            )}

            <div className="firm-import-preview">
              <div className="firm-import-preview__facts">
                {addressText && (
                  <div>
                    <span>{message('mounted.venture.address')}</span>
                    <strong><BidiText direction="auto">{addressText}</BidiText></strong>
                  </div>
                )}
                {(draft.facts || []).slice(0, 6).map((fact) => (
                  <div key={fact.label}>
                    <span><BidiText direction="auto">{fact.label}</BidiText></span>
                    <strong><BidiText direction="auto">{fact.value}</BidiText></strong>
                  </div>
                ))}
              </div>
              <div className="firm-import-preview__actions">
                {previewQueue.map((item) => (
                  <article key={item.id}>
                    <Badge variant={item.queue_label === 'expert_review' ? 'red' : item.queue_label === 'execution_queue' ? 'blue' : 'amber'}>
                      {item.queue_label === 'expert_review'
                        ? message('mounted.venture.compliance')
                        : item.queue_label === 'execution_queue'
                          ? message('mounted.venture.xero')
                          : message('mounted.venture.intake')}
                    </Badge>
                    <strong><BidiText direction="auto">{item.problem_summary}</BidiText></strong>
                  </article>
                ))}
              </div>
            </div>
            <div className="firm-new-entity__actions">
              <button
                className="btn btn-primary"
                type="button"
                disabled={!draft.company_name?.trim() || creating || reading || Boolean(finnishFormRefusal)
                  || (nativeProcessingAvailable && (!processingFactsConfirmed || !bookkeepingStartDate || draft.default_currency !== 'SGD'))}
                onClick={handleCreate}
              >
                {message(creating ? 'mounted.venture.creating' : 'mounted.venture.create')}
              </button>
            </div>
          </section>
        )}
      </div>
    </section>
  );
};

export default FirmNewEntity;
