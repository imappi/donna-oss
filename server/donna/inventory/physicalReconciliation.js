// Pure physical-observation contract. A proposal is evidence, never a stock write.
import { createHash } from 'node:crypto';
import { decimal } from './core.js';

export const PHYSICAL_RECONCILIATION_FLAG_KEY = 'PHYSICAL_RECONCILIATION';
export const PHYSICAL_TERMINAL_STATES = ['matched', 'dismissed', 'applied'];
export const PHYSICAL_RESOLUTIONS = ['matched', 'dismissed', 'recount_required', 'uncertain', 'confirmed_shortage', 'confirmed_found_stock'];
export const physicalRefusal = (reason, detail = {}) => ({ applied: false, reason, detail });
export const physicalHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Delivery belongs to the current recipient; an old send survives escalation
// for audit but cannot acknowledge the newly assigned obligation.
export const physicalAskAcknowledged = (ask) => {
  if (ask?.status === 'draft' || !(Number(ask?.send_count) > 0)) return false;
  const escalatedAt = ask?.request_payload?.physical_escalation?.escalated_at;
  return !escalatedAt || new Date(ask.last_sent_at).getTime() >= new Date(escalatedAt).getTime();
};

export const proposePhysicalObservation = ({ expectedQuantity, observedQuantity, evidenceRefs, observedAt, cutoff, asOf,
  confidence = null, uncertain = false, humanConfirmed = false, notes = {}, modelReceipt = null, actorId } = {}) => {
  const unknown = observedQuantity == null && uncertain === true;
  if (!unknown && (observedQuantity == null || observedQuantity === '' || typeof observedQuantity === 'boolean'
    || !Number.isFinite(Number(observedQuantity)) || Number(observedQuantity) < 0 || Number(observedQuantity) > 1e12)) return physicalRefusal('invalid_quantity');
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length < 1 || evidenceRefs.length > 10) return physicalRefusal('evidence_required');
  if (confidence !== null && (!Number.isFinite(Number(confidence)) || Number(confidence) < 0 || Number(confidence) > 1)) return physicalRefusal('invalid_confidence');
  const captured = Date.parse(observedAt), basisTime = Date.parse(cutoff), now = Date.parse(asOf);
  if (!Number.isFinite(captured) || !Number.isFinite(basisTime) || captured < basisTime || captured > now) return physicalRefusal('observation_outside_basis');
  if (!notes || typeof notes !== 'object' || Array.isArray(notes) || JSON.stringify(notes).length > 10000
    || (modelReceipt !== null && (typeof modelReceipt !== 'object' || Array.isArray(modelReceipt) || JSON.stringify(modelReceipt).length > 10000))) return physicalRefusal('invalid_notes');
  const quantity = unknown ? null : decimal(observedQuantity), variance = unknown ? null : decimal(quantity - decimal(expectedQuantity));
  const needsHuman = unknown || uncertain === true || humanConfirmed !== true;
  return { applied: true, observation: { quantity, variance, evidenceRefs, observedAt: new Date(captured).toISOString(),
    actorId, source: modelReceipt ? 'human_confirmed_model_proposal' : 'human_count', confidence: confidence === null ? null : Number(confidence),
    uncertain: needsHuman, humanConfirmed: humanConfirmed === true, notes, modelReceipt },
  status: needsHuman ? 'uncertain' : variance === 0 ? 'matched' : 'variance' };
};

export const validatePhysicalResolution = ({ line, action, reason, countCause } = {}) => {
  if (!PHYSICAL_RESOLUTIONS.includes(action)) return physicalRefusal('invalid_resolution');
  if (PHYSICAL_TERMINAL_STATES.includes(line.physical_status)) return physicalRefusal('line_already_resolved');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000) return physicalRefusal('resolution_reason_required');
  if (['dismissed', 'recount_required', 'uncertain'].includes(action)) return { applied: true };
  const observation = line.physical_observation;
  if (line.physical_status === 'uncertain' || !observation || observation.humanConfirmed !== true || observation.uncertain) return physicalRefusal('human_confirmation_required');
  if (action === 'matched' && observation.variance !== 0) return physicalRefusal('variance_requires_resolution');
  if (action === 'confirmed_shortage' && !(observation.variance < 0)) return physicalRefusal('not_a_shortage');
  if (action === 'confirmed_found_stock' && !(observation.variance > 0)) return physicalRefusal('not_found_stock');
  // This is the existing posting builder's only supported positive-stock cause.
  if (action === 'confirmed_found_stock' && countCause !== 'reversal_of_shrinkage') return physicalRefusal('found_stock_requires_cause_review');
  return { applied: true };
};
