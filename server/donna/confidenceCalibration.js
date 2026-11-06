// Confidence calibration contract — shared across all components.
//
// Every confidence score in the system flows through this module:
//   raw_model_confidence → normalized_confidence → decision_band
//
// Downstream decisions consume only normalized confidence and decision
// bands, never raw model scores. When a new model ships, recalibrate
// the function on the eval set before enabling it in production.

const CALIBRATION_VERSION = 'v1';

const BAND_THRESHOLDS = Object.freeze({
  green: 0.8,
  yellow: 0.5
});

export const calibrate = (rawConfidence, { model = 'unknown', source = 'unknown' } = {}) => {
  const raw = Number(rawConfidence);
  if (!Number.isFinite(raw)) {
    return {
      raw_model_confidence: null,
      normalized_confidence: 0,
      decision_band: 'red',
      calibration_version: CALIBRATION_VERSION,
      model_id: model,
      source
    };
  }

  const clamped = Math.max(0, Math.min(1, raw));

  // v1 calibration: identity function. Recalibrate when model
  // evaluation data shows systematic bias in raw scores.
  const normalized = clamped;

  const band = normalized >= BAND_THRESHOLDS.green
    ? 'green'
    : normalized >= BAND_THRESHOLDS.yellow
      ? 'yellow'
      : 'red';

  return {
    raw_model_confidence: clamped,
    normalized_confidence: normalized,
    decision_band: band,
    calibration_version: CALIBRATION_VERSION,
    model_id: model,
    source
  };
};

export const isGreen = (envelope) =>
  envelope?.decision_band === 'green';

export const isYellowOrAbove = (envelope) =>
  envelope?.decision_band === 'green' || envelope?.decision_band === 'yellow';

export const isRed = (envelope) =>
  envelope?.decision_band === 'red';

export const __CALIBRATION_VERSION = CALIBRATION_VERSION;
export const __BAND_THRESHOLDS = BAND_THRESHOLDS;
