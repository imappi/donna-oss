import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import { inspectFirmAccountingImport } from '../../lib/firmApi.js';
import { D } from '../shared/design-tokens.js';
import { btnChip, btnPrimary } from '../shared/buttons.js';
import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const ACCEPTED_FORMATS = '.csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';

const fieldSelectStyle = {
  font: 'inherit',
  fontSize: 14,
  color: D.ink,
  background: D.card,
  border: `1px solid ${D.rule}`,
  borderRadius: 8,
  paddingBlock: 7,
  paddingInlineStart: 10,
  paddingInlineEnd: 28,
  minWidth: 190
};

const statusCopy = {
  needs_kind: ['mounted.import.state.needsKind.title', 'mounted.import.state.needsKind.body'],
  needs_mapping: ['mounted.import.state.needsMapping.title', 'mounted.import.state.needsMapping.body'],
  needs_correction: ['mounted.import.state.needsCorrection.title', 'mounted.import.state.needsCorrection.body'],
  ready_to_apply: ['mounted.import.state.ready.title', 'mounted.import.state.ready.body']
};

const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
};

const Notice = ({ tone = 'quiet', children }) => (
  <div
    style={{
      borderRadius: 10,
      padding: '10px 12px',
      fontSize: 14,
      lineHeight: 1.45,
      color: tone === 'attention' ? D.alert : D.inkSoft,
      background: tone === 'attention' ? 'oklch(0.72 0.12 55 / 0.09)' : 'oklch(0.08 0 0 / 0.035)'
    }}
  >
    {children}
  </div>
);

const AccountingImportCard = ({
  firm,
  clients = [],
  initialClientId = '',
  dataSource,
  accountingImportRequest = null,
  onAccountingImportRequestConsumed = null
}) => {
  const intl = useIntl();
  const fileInputRef = useRef(null);
  const requestRef = useRef(null);
  const [clientId, setClientId] = useState(initialClientId || clients[0]?.id || '');
  const [file, setFile] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [importKind, setImportKind] = useState('');
  const [sheetHandle, setSheetHandle] = useState('');
  const [mapping, setMapping] = useState({});
  const [dateConvention, setDateConvention] = useState('safe');
  const [numberConvention, setNumberConvention] = useState('safe');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialClientId && clients.some((client) => client.id === initialClientId)) {
      setClientId(initialClientId);
    } else if (!clients.some((client) => client.id === clientId)) {
      setClientId(clients[0]?.id || '');
    }
  }, [clients, clientId, initialClientId]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const syncResultState = (result) => {
    setInspection(result);
    setSheetHandle(result?.selected_sheet_handle || '');
    if (result?.plan?.import_kind) setImportKind(result.plan.import_kind);
    setMapping(Object.fromEntries((result?.plan?.mapping || []).map((entry) => [entry.field, entry.column_handle || ''])));
    if (result?.plan?.conventions?.date) setDateConvention(result.plan.conventions.date);
    if (result?.plan?.conventions?.number) setNumberConvention(result.plan.conventions.number);
  };

  const inspect = async ({
    nextFile = file,
    nextImportKind = importKind,
    nextSheetHandle = sheetHandle,
    nextMapping = mapping,
    nextDateConvention = dateConvention,
    nextNumberConvention = numberConvention,
    nextClientId = clientId
  } = {}) => {
    if (!nextFile || !nextClientId) return;
    if (nextFile.size > MAX_FILE_BYTES) {
      setError(intl.formatMessage({ id: 'mounted.import.smaller' }, { size: formatBytes(MAX_FILE_BYTES) }));
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await inspectFirmAccountingImport({
        file: nextFile,
        firmId: firm?.id || null,
        clientId: nextClientId,
        importKind: nextImportKind || null,
        sheetHandle: nextSheetHandle || null,
        mapping: nextImportKind ? nextMapping : null,
        dateConvention: nextDateConvention,
        numberConvention: nextNumberConvention,
        signal: controller.signal
      });
      syncResultState(result);
    } catch (nextError) {
      if (nextError?.name !== 'AbortError') {
        setError(nextError?.message || intl.formatMessage({ id: 'mounted.import.inspectError' }));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  };

  const chooseFile = (selected, nextClientId = clientId) => {
    if (!selected) return;
    setClientId(nextClientId);
    setFile(selected);
    setInspection(null);
    setImportKind('');
    setSheetHandle('');
    setMapping({});
    setDateConvention('safe');
    setNumberConvention('safe');
    inspect({
      nextFile: selected,
      nextImportKind: '',
      nextSheetHandle: '',
      nextMapping: {},
      nextDateConvention: 'safe',
      nextNumberConvention: 'safe',
      nextClientId
    });
  };

  useEffect(() => {
    const selected = accountingImportRequest?.file || null;
    const targetClientId = accountingImportRequest?.clientId || '';
    if (!selected || !targetClientId) return;
    if (!clients.some((client) => client.id === targetClientId)) {
      setError(intl.formatMessage({ id: 'mounted.import.ventureMissing' }));
      onAccountingImportRequestConsumed?.();
      return;
    }
    chooseFile(selected, targetClientId);
    onAccountingImportRequestConsumed?.();
    // The request object is a one-shot handoff. Its consumer clears it after
    // inspection starts, so helper identities must not retrigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountingImportRequest]);

  const changeClient = (nextClientId) => {
    requestRef.current?.abort();
    setClientId(nextClientId);
    setFile(null);
    setInspection(null);
    setImportKind('');
    setSheetHandle('');
    setMapping({});
    setDateConvention('safe');
    setNumberConvention('safe');
    setBusy(false);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const changeKind = (nextKind) => {
    setImportKind(nextKind);
    setMapping({});
    if (nextKind) inspect({ nextImportKind: nextKind, nextMapping: {} });
    else {
      setInspection((current) => current ? { ...current, state: 'needs_kind', plan: null } : current);
    }
  };

  const changeSheet = (nextSheet) => {
    setSheetHandle(nextSheet);
    setMapping({});
    inspect({ nextSheetHandle: nextSheet, nextMapping: {} });
  };

  const selectedSheet = inspection?.sheets?.find((sheet) => sheet.handle === inspection.selected_sheet_handle)
    || inspection?.sheets?.[0]
    || null;
  const [statusTitleId, statusDescriptionId] = statusCopy[inspection?.state] || [];
  const inspectionIssues = inspection?.plan?.validation?.issues || [];
  const rowIssueNumbers = new Set(inspectionIssues.flatMap((issue) => [
    issue.source_row_number,
    ...(Array.isArray(issue.source_row_numbers) ? issue.source_row_numbers : [])
  ]).filter(Boolean));
  const live = dataSource === 'database';

  return (
    <div
      style={{
        background: D.paperDeep,
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 16
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 650 }}>
          <div style={{ fontSize: 17, fontWeight: 650, color: D.ink }}>{intl.formatMessage({ id: 'mounted.import.title' })}</div>
          <div style={{ fontSize: 14.5, color: D.inkSoft, lineHeight: 1.5, marginTop: 3 }}>
            {intl.formatMessage({ id: 'mounted.import.description' })}
          </div>
        </div>
        <span style={{ fontFamily: D.mono, fontSize: 11, color: D.inkMute, letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
          {intl.formatMessage({ id: 'mounted.import.previewOnly' })}
        </span>
      </div>

      <div className="accounting-import-card__fields" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(220px, 1fr)', gap: 12, marginTop: 18 }}>
        <label style={{ display: 'grid', minWidth: 0, gap: 5, fontSize: 13, color: D.inkMute }}>
          {intl.formatMessage({ id: 'mounted.import.venture' })}
          <select
            value={clientId}
            onChange={(event) => changeClient(event.target.value)}
            disabled={busy || !live || clients.length === 0}
            style={{ ...fieldSelectStyle, width: '100%' }}
          >
            {clients.length === 0 && <option value="">{intl.formatMessage({ id: 'mounted.import.noVentures' })}</option>}
            {clients.map((client) => (
              <option key={client.id} value={client.id}>{client.companyName || client.name || client.id}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', minWidth: 0, gap: 5, fontSize: 13, color: D.inkMute }}>
          {intl.formatMessage({ id: 'mounted.import.file' })}
          <div className="accounting-import-card__file-control" style={{ display: 'flex', minWidth: 0, gap: 10, alignItems: 'center', minHeight: 39 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FORMATS}
              disabled={busy || !live || !clientId}
              onChange={(event) => chooseFile(event.target.files?.[0] || null)}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              style={btnChip}
              disabled={busy || !live || !clientId}
              onClick={() => fileInputRef.current?.click()}
            >
              {intl.formatMessage({ id: file ? 'mounted.import.chooseAnother' : 'mounted.import.chooseFile' })}
            </button>
            <span style={{ flex: '1 1 0', minWidth: 0, fontSize: 14, color: file ? D.ink : D.inkMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file ? <><BidiText direction="auto">{file.name}</BidiText> · <FormattedValue>{formatBytes(file.size)}</FormattedValue></> : intl.formatMessage({ id: 'mounted.import.formats' })}
            </span>
          </div>
        </label>
      </div>

      {!live && <div style={{ marginTop: 14 }}><Notice>{intl.formatMessage({ id: 'mounted.import.liveRequired' })}</Notice></div>}
      {busy && <div style={{ marginTop: 14 }}><Notice>{intl.formatMessage({ id: 'mounted.import.inspectingLocal' })}</Notice></div>}
      {error && <div style={{ marginTop: 14 }}><Notice tone="attention">{error}</Notice></div>}

      {inspection && !busy && (
        <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
          <Notice>
            <strong style={{ color: D.ink }}>{inspection.source.detected_format.toUpperCase()}</strong>
            {' · '}{intl.formatMessage({ id: 'mounted.import.sheetCount' }, { count: inspection.sheets.length })}
            {' · SHA-256 '}<IdentifierText>{inspection.source.checksum_sha256.slice(0, 12)}…</IdentifierText>
            {inspection.source.encoding ? ` · ${inspection.source.encoding.toUpperCase()}` : ''}
            {inspection.source.delimiter ? <> · {intl.formatMessage({ id: 'mounted.import.delimiter' }, { delimiter: inspection.source.delimiter })}</> : ''}
          </Notice>

          {(inspection.blockers || []).map((item) => (
            <Notice key={item.code} tone="attention"><strong><IdentifierText>{item.code}</IdentifierText></strong> — <BidiText direction="auto">{item.message}</BidiText></Notice>
          ))}
          {(inspection.warnings || []).map((item) => (
            <Notice key={item.code}><strong><IdentifierText>{item.code}</IdentifierText></strong> — <BidiText direction="auto">{item.message}</BidiText></Notice>
          ))}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(220px, 1fr)', gap: 12 }}>
            <label style={{ display: 'grid', gap: 5, fontSize: 13, color: D.inkMute }}>
              {intl.formatMessage({ id: 'mounted.import.contains' })}
              <select value={importKind} onChange={(event) => changeKind(event.target.value)} style={{ ...fieldSelectStyle, width: '100%' }}>
                <option value="">{intl.formatMessage({ id: 'mounted.import.chooseType' })}</option>
                {(inspection.available_import_kinds || []).map((kind) => (
                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                ))}
              </select>
              {!importKind && inspection.suggested_import_kind && (
                <span style={{ fontSize: 12.5, color: D.inkSoft }}>
                  {intl.formatMessage({ id: 'mounted.import.likely' }, { kind: inspection.suggested_import_kind.label })}
                </span>
              )}
            </label>
            <label style={{ display: 'grid', gap: 5, fontSize: 13, color: D.inkMute }}>
              {intl.formatMessage({ id: 'mounted.import.worksheet' })}
              <select value={inspection.selected_sheet_handle || ''} onChange={(event) => changeSheet(event.target.value)} style={{ ...fieldSelectStyle, width: '100%' }}>
                {(inspection.sheets || []).map((sheet) => (
                  <option key={sheet.handle} value={sheet.handle}>
                    {sheet.name}{sheet.hidden !== 'visible' ? ` · ${sheet.hidden.replace('_', ' ')}` : ''}
                  </option>
                ))}
              </select>
              {selectedSheet && (
                <span style={{ fontSize: 12.5, color: D.inkSoft }}>
                  {intl.formatMessage({ id: 'mounted.import.sheetSummary' }, {
                    header: selectedSheet.header_row_number,
                    rows: selectedSheet.row_count,
                    columns: selectedSheet.column_count
                  })}
                </span>
              )}
            </label>
          </div>

          {inspection.plan && (
            <>
              <div>
                <div style={{ fontSize: 15, fontWeight: 650, color: D.ink, marginBottom: 8 }}>{intl.formatMessage({ id: 'mounted.import.mapping' })}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                  {inspection.plan.mapping.map((entry) => (
                    <label key={entry.field} style={{ display: 'grid', gap: 4, fontSize: 13, color: D.inkMute }}>
                      <BidiText direction="auto">{entry.label}</BidiText>{entry.required ? <> · {intl.formatMessage({ id: 'mounted.import.required' })}</> : ''}
                      <select
                        value={mapping[entry.field] || ''}
                        onChange={(event) => setMapping((current) => ({ ...current, [entry.field]: event.target.value }))}
                        style={{ ...fieldSelectStyle, width: '100%' }}
                      >
                        <option value="">{intl.formatMessage({ id: 'mounted.import.notMapped' })}</option>
                        {(selectedSheet?.columns || []).map((column) => (
                          <option key={column.handle} value={column.handle}>{column.source_letter} · {column.label}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginTop: 12 }}>
                  <label style={{ display: 'grid', gap: 4, fontSize: 13, color: D.inkMute }}>
                    {intl.formatMessage({ id: 'mounted.import.dateOrder' })}
                    <select value={dateConvention} onChange={(event) => setDateConvention(event.target.value)} style={{ ...fieldSelectStyle, width: '100%' }}>
                      <option value="safe">{intl.formatMessage({ id: 'mounted.import.date.safe' })}</option>
                      <option value="dmy">{intl.formatMessage({ id: 'mounted.import.date.dmy' })}</option>
                      <option value="mdy">{intl.formatMessage({ id: 'mounted.import.date.mdy' })}</option>
                    </select>
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 13, color: D.inkMute }}>
                    {intl.formatMessage({ id: 'mounted.import.numberFormat' })}
                    <select value={numberConvention} onChange={(event) => setNumberConvention(event.target.value)} style={{ ...fieldSelectStyle, width: '100%' }}>
                      <option value="safe">{intl.formatMessage({ id: 'mounted.import.number.safe' })}</option>
                      <option value="dot_decimal">1,234.56</option>
                      <option value="comma_decimal">1.234,56</option>
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  style={{ ...btnPrimary, marginTop: 12 }}
                  disabled={busy}
                  onClick={() => inspect({ nextMapping: mapping })}
                >
                  {intl.formatMessage({ id: 'mounted.import.check' })}
                </button>
              </div>

              <Notice tone={inspection.state === 'needs_correction' || inspection.state === 'needs_mapping' ? 'attention' : 'quiet'}>
                <strong style={{ color: D.ink }}>{statusTitleId ? intl.formatMessage({ id: statusTitleId }) : ''}</strong> — {statusDescriptionId ? intl.formatMessage({ id: statusDescriptionId }) : ''}
                <div style={{ marginTop: 4 }}>
                  {intl.formatMessage({ id: 'mounted.import.validationSummary' }, {
                    valid: intl.formatMessage({ id: 'mounted.import.validRows' }, { count: inspection.plan.validation.valid_rows }),
                    blocked: intl.formatMessage({ id: 'mounted.import.blockedRows' }, { count: inspection.plan.validation.blocked_rows }),
                    issues: intl.formatMessage({ id: 'mounted.import.issueCount' }, { count: inspection.plan.validation.issue_count })
                  })}
                </div>
              </Notice>

              {inspectionIssues.length > 0 && (
                <div style={{ display: 'grid', gap: 6 }}>
                  {inspectionIssues.slice(0, 20).map((issue, index) => (
                    <div key={`${issue.code}-${issue.source_row_number || 'mapping'}-${index}`} style={{ fontSize: 13.5, color: D.alert }}>
                      {issue.source_row_number ? <>{intl.formatMessage({ id: 'mounted.import.row' })} <FormattedValue>{issue.source_row_number}</FormattedValue>: </> : ''}<BidiText direction="auto">{issue.message}</BidiText>
                    </div>
                  ))}
                  {inspection.plan.validation.issues_truncated && (
                    <div style={{ fontSize: 13.5, color: D.inkMute }}>{intl.formatMessage({ id: 'mounted.import.moreIssues' })}</div>
                  )}
                </div>
              )}
            </>
          )}

          {selectedSheet?.preview_rows?.length > 0 && (
            <div style={{ overflowX: 'auto', border: `1px solid ${D.ruleSoft}`, borderRadius: 10, background: D.card }}>
              <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 13.5 }}>
                <thead>
                  <tr>
                    <th style={{ padding: '9px 10px', textAlign: 'start', color: D.inkMute, borderBottom: `1px solid ${D.ruleSoft}` }}>{intl.formatMessage({ id: 'mounted.import.row' })}</th>
                    {selectedSheet.columns.map((column) => (
                      <th key={column.handle} style={{ padding: '9px 10px', textAlign: 'start', color: D.ink, borderBottom: `1px solid ${D.ruleSoft}`, whiteSpace: 'nowrap' }}>
                        {column.source_letter} · {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedSheet.preview_rows.map((row) => (
                    <tr key={row.source_row_number} style={{ background: rowIssueNumbers.has(row.source_row_number) ? 'oklch(0.72 0.12 55 / 0.07)' : 'transparent' }}>
                      <td style={{ padding: '8px 10px', color: D.inkMute, borderBottom: `1px solid ${D.ruleSoft}`, fontFamily: D.mono }}>{row.source_row_number}</td>
                      {row.values.map((value, index) => (
                        <td key={`${row.source_row_number}-${selectedSheet.columns[index]?.handle || index}`} style={{ padding: '8px 10px', color: D.inkSoft, borderBottom: `1px solid ${D.ruleSoft}`, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {value === '' ? '—' : <BidiText direction="auto">{value}</BidiText>}
                          {row.formula_columns.includes(selectedSheet.columns[index]?.handle) ? <> · {intl.formatMessage({ id: 'mounted.import.cachedFormula' })}</> : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AccountingImportCard;
