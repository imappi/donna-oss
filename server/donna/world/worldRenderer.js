import { createHash } from 'node:crypto';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { buildObservationSchedule } from './observationSchedule.js';
import { validateCausalWorld } from './worldValidity.js';
import { validateWorldSpec } from './worldSchema.js';

export const WORLD_RENDERER_VERSION = 'proof0.worldRenderer.v1';
export const PDF_FROZEN_DATE = new Date('2026-06-08T00:00:00.000Z');

export async function renderWorldArtifacts(worldSpec) {
  const errors = validateRendererInputs(worldSpec);
  if (errors.length > 0) {
    return renderResult(errors);
  }

  const schedule = buildObservationSchedule(worldSpec);
  if (!schedule.ok) {
    return renderResult(schedule.errors.map((error) => `schedule.${error}`));
  }

  const renderedArtifacts = [];
  for (const artifact of [...worldSpec.artifacts].sort(compareById)) {
    renderedArtifacts.push(await renderArtifact(artifact, worldSpec, schedule));
  }

  return {
    ok: true,
    version: WORLD_RENDERER_VERSION,
    errors: [],
    artifacts: renderedArtifacts,
    receipts: renderedArtifacts.map(renderReceipt),
  };
}

function validateRendererInputs(worldSpec) {
  const shape = validateWorldSpec(worldSpec);
  if (!shape.ok) return shape.errors;

  const validity = validateCausalWorld(worldSpec);
  if (!validity.ok) return validity.errors.map((error) => `validity.${error}`);

  const errors = [];
  for (const artifact of worldSpec.artifacts) {
    if (!isPlainObject(artifact) || typeof artifact.id !== 'string') continue;
    if (typeof artifact.kind !== 'string' || artifact.kind.trim() === '') {
      errors.push(`artifacts.${artifact.id}.kind must be a non-empty string`);
    }
    if (artifact.format !== undefined && !['pdf', 'json'].includes(artifact.format)) {
      errors.push(`artifacts.${artifact.id}.format must be pdf or json when present`);
    }
  }
  return errors;
}

async function renderArtifact(artifact, worldSpec, schedule) {
  const format = artifact.format ?? (artifact.kind.endsWith('_pdf') || artifact.kind === 'invoice' || artifact.kind === 'receipt_pdf' ? 'pdf' : 'json');
  const trustClass = artifact.trusted === false || artifact.trustClass === 'untrusted_artifact' ? 'untrusted_artifact' : 'trusted_artifact';
  const authority = trustClass === 'untrusted_artifact' ? 'evidence_only_no_instruction_authority' : 'evidence_source';
  const visibleObservations = schedule.observations.filter(({ artifactId }) => artifactId === artifact.id).map(({ observationId, observedAt }) => ({ observationId, observedAt }));

  const payload = {
    artifactId: artifact.id,
    worldId: worldSpec.worldId,
    kind: artifact.kind,
    trustClass,
    authority,
    visibleObservations,
    fields: artifact.fields ?? {},
    textLines: artifact.textLines ?? buildDefaultArtifactLines(artifact),
  };

  const contentBase64 = format === 'pdf'
    ? await renderPdf(payload.textLines)
    : Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8').toString('base64');
  const digest = sha256Base64(contentBase64);

  return {
    id: artifact.id,
    kind: artifact.kind,
    format,
    trustClass,
    authority,
    contentBase64,
    sha256: digest,
    rendererVersion: WORLD_RENDERER_VERSION,
    frozenDate: PDF_FROZEN_DATE.toISOString(),
    observationIds: visibleObservations.map(({ observationId }) => observationId),
  };
}

async function renderPdf(lines) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setCreationDate(PDF_FROZEN_DATE);
  pdfDoc.setModificationDate(PDF_FROZEN_DATE);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([595, 842]);
  const fontSize = 11;
  const lineHeight = 16;
  const marginLeft = 50;
  const startY = 800;
  const black = rgb(0, 0, 0);

  for (let index = 0; index < lines.length; index += 1) {
    const y = startY - index * lineHeight;
    if (y < 50) break;
    page.drawText(String(lines[index] ?? ''), { x: marginLeft, y, size: fontSize, font, color: black });
  }

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  return Buffer.from(bytes).toString('base64');
}

export function buildDefaultArtifactLines(artifact) {
  const declaredFieldLines = flattenDeclaredFields(artifact.fields ?? {});
  return [
    artifact.title || 'Business Document',
    ...declaredFieldLines,
    ...(artifact.embeddedInstruction ? [artifact.embeddedInstruction] : []),
  ];
}

function flattenDeclaredFields(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenDeclaredFields(item, [...path, String(index + 1)]));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => flattenDeclaredFields(item, [...path, key]));
  }
  if (value === undefined || value === null) return [];
  return [`${path.map(humanizeFieldName).join(' ')}: ${String(value)}`];
}

function humanizeFieldName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

function renderReceipt(artifact) {
  return {
    id: `render-receipt/${artifact.id}`,
    artifactId: artifact.id,
    rendererVersion: artifact.rendererVersion,
    format: artifact.format,
    sha256: artifact.sha256,
    trustClass: artifact.trustClass,
    authority: artifact.authority,
    frozenDate: artifact.frozenDate,
  };
}

function renderResult(errors) {
  return { ok: false, version: WORLD_RENDERER_VERSION, errors, artifacts: [], receipts: [] };
}

function sha256Base64(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareById(left, right) {
  return left.id.localeCompare(right.id);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
