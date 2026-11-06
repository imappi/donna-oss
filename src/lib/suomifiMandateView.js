// G-3 follow-up (FI-15) — pure view model for the Suomi.fi mandate status
// envelope (`GET /reports/finland-suomifi-mandate`). The follow-up named on the
// G-3 row of docs/design-donna-finland-production-readiness.md: surface the
// mandate status on the financials panel now that the ALV filing surface is
// built.
//
// Render-the-persisted-verdict: the server evaluates validity at read time
// (evaluateSuomifiMandate — the SAME verdict the filing gate uses) and the
// envelope carries it; everything here is labelling. NO client-side
// re-derivation of validity, no date math beyond display formatting.

const fiDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])}.${Number(m[2])}.${Number(m[1])}` : String(iso || '');
};

// Suomi.fi's own catalog vocabulary → display label. Unknown scopes render
// as themselves — surfacing beats prettiness.
const SCOPE_LABELS = {
  veroasioiden_hoito: 'veroasioiden hoito'
};

// The evaluator's CLOSED reason vocabulary (SUOMIFI_MANDATE_REASONS,
// server/donna/finland/suomifiMandate.js). The status GET reads the ACTIVE row
// only, so wrong_scope/revoked cannot practically reach this surface — mapped
// anyway so a closed-vocab drift renders honestly instead of blankly.
const REASON_VIEWS = {
  valid: { tone: 'ok', label: 'Voimassa', hint: null },
  no_mandate: {
    tone: 'amber',
    label: 'Ei valtuutusta',
    hint: 'ALV-ilmoitusta ei voi lähettää ilman Suomi.fi-valtuutusta (veroasioiden hoito) — omistajan on myönnettävä valtuutus Suomi.fi:ssä.'
  },
  not_yet_effective: {
    tone: 'amber',
    label: 'Ei vielä voimassa',
    hint: 'Kirjattu valtuutus alkaa vasta myöntämispäivästä — ilmoitusta ei voi lähettää ennen sitä.'
  },
  expired: {
    tone: 'amber',
    label: 'Vanhentunut',
    hint: 'Kirjattu valtuutus on päättynyt — omistajan on uusittava valtuutus Suomi.fi:ssä ennen seuraavaa ilmoitusta.'
  },
  revoked: {
    tone: 'amber',
    label: 'Peruttu',
    hint: 'Kirjattu valtuutus on peruttu — omistajan on myönnettävä uusi valtuutus Suomi.fi:ssä ennen seuraavaa ilmoitusta.'
  },
  wrong_scope: {
    tone: 'amber',
    label: 'Väärä valtuusasia',
    hint: 'Kirjattu valtuutus ei kata veroasioiden hoitoa — ilmoittaminen vaatii veroasioiden hoito -valtuuden.'
  }
};

// buildSuomifiMandateViewModel(envelope) → what the panel renders, or null for
// a shape that is not a mandate-status envelope (callers hide the strip).
export const buildSuomifiMandateViewModel = (envelope) => {
  if (!envelope || typeof envelope !== 'object' || !envelope.evaluation || typeof envelope.evaluation !== 'object') return null;
  const evaluation = envelope.evaluation;
  const reason = String(evaluation.reason || '');
  const view = REASON_VIEWS[reason] || { tone: 'amber', label: reason || 'unknown', hint: null };
  const mandate = envelope.mandate && typeof envelope.mandate === 'object' ? envelope.mandate : null;

  const detailParts = [];
  if (mandate?.granted_on) detailParts.push(`Myönnetty ${fiDate(mandate.granted_on)}`);
  if (mandate?.expires_on) detailParts.push(`päättyy ${fiDate(mandate.expires_on)}`);
  if (mandate?.reference) detailParts.push(`viite ${mandate.reference}`);

  return {
    valid: evaluation.valid === true,
    reason,
    tone: view.tone,
    label: view.label,
    scopeLabel: SCOPE_LABELS[String(envelope.scope || '')] || String(envelope.scope || ''),
    detail: detailParts.length ? detailParts.join(' · ') : null,
    hint: view.hint
  };
};
