export const SUPPORTED_SELF_SERVE_JURISDICTIONS = new Set(['FI', 'GB']);

export const qualificationDecision = ({ businessEligible, bandId, volumeReason, businessReason, jurisdiction, switching }) => {
  const normalizedJurisdiction = String(jurisdiction || '').trim().toUpperCase();
  const jurisdictionAnswered = Boolean(normalizedJurisdiction);
  const jurisdictionEligible = SUPPORTED_SELF_SERVE_JURISDICTIONS.has(normalizedJurisdiction);
  const switcher = switching === 'yes';
  const unfit = (jurisdictionAnswered && !jurisdictionEligible) || switcher || businessEligible === false || Boolean(volumeReason);

  return {
    eligible: Boolean(!unfit && businessEligible && bandId && jurisdictionEligible && switching === 'no'),
    unfit,
    disqualifyReason: jurisdictionAnswered && !jurisdictionEligible
      ? 'jurisdiction'
      : switcher
        ? 'switcher'
        : volumeReason || businessReason || 'other'
  };
};
