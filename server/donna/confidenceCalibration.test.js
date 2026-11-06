import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrate,
  isGreen,
  isYellowOrAbove,
  isRed,
  __CALIBRATION_VERSION,
  __BAND_THRESHOLDS
} from './confidenceCalibration.js';

let passed = 0;
const track = () => passed++;

test('green band for confidence >= 0.8', () => {
  const result = calibrate(0.85, { model: 'gpt-5.4-nano', source: 'router' });
  assert.equal(result.decision_band, 'green');
  assert.equal(result.normalized_confidence, 0.85);
  assert.equal(result.raw_model_confidence, 0.85);
  assert.equal(result.model_id, 'gpt-5.4-nano');
  assert.equal(result.source, 'router');
  assert.equal(result.calibration_version, __CALIBRATION_VERSION);
  track();
});

test('yellow band for confidence 0.5-0.8', () => {
  const result = calibrate(0.65);
  assert.equal(result.decision_band, 'yellow');
  assert.equal(result.normalized_confidence, 0.65);
  track();
});

test('red band for confidence < 0.5', () => {
  const result = calibrate(0.3);
  assert.equal(result.decision_band, 'red');
  track();
});

test('exactly 0.8 is green', () => {
  assert.equal(calibrate(0.8).decision_band, 'green');
  track();
});

test('exactly 0.5 is yellow', () => {
  assert.equal(calibrate(0.5).decision_band, 'yellow');
  track();
});

test('0 confidence is red', () => {
  assert.equal(calibrate(0).decision_band, 'red');
  track();
});

test('1.0 confidence is green', () => {
  assert.equal(calibrate(1.0).decision_band, 'green');
  assert.equal(calibrate(1.0).normalized_confidence, 1.0);
  track();
});

test('confidence clamped to 0-1 range', () => {
  assert.equal(calibrate(1.5).normalized_confidence, 1.0);
  assert.equal(calibrate(-0.3).normalized_confidence, 0);
  assert.equal(calibrate(-0.3).decision_band, 'red');
  track();
});

test('non-finite confidence returns red band with 0 normalized', () => {
  const result = calibrate(NaN);
  assert.equal(result.decision_band, 'red');
  assert.equal(result.normalized_confidence, 0);
  assert.equal(result.raw_model_confidence, null);
  track();
});

test('null confidence returns red band', () => {
  assert.equal(calibrate(null).decision_band, 'red');
  track();
});

test('undefined confidence returns red band', () => {
  assert.equal(calibrate(undefined).decision_band, 'red');
  track();
});

test('string confidence returns red band', () => {
  assert.equal(calibrate('high').decision_band, 'red');
  track();
});

test('isGreen helper', () => {
  assert.equal(isGreen(calibrate(0.9)), true);
  assert.equal(isGreen(calibrate(0.6)), false);
  assert.equal(isGreen(calibrate(0.2)), false);
  assert.equal(isGreen(null), false);
  track();
});

test('isYellowOrAbove helper', () => {
  assert.equal(isYellowOrAbove(calibrate(0.9)), true);
  assert.equal(isYellowOrAbove(calibrate(0.6)), true);
  assert.equal(isYellowOrAbove(calibrate(0.2)), false);
  track();
});

test('isRed helper', () => {
  assert.equal(isRed(calibrate(0.2)), true);
  assert.equal(isRed(calibrate(0.6)), false);
  assert.equal(isRed(calibrate(0.9)), false);
  track();
});

test('default model and source', () => {
  const result = calibrate(0.5);
  assert.equal(result.model_id, 'unknown');
  assert.equal(result.source, 'unknown');
  track();
});

test('band thresholds are exported and correct', () => {
  assert.equal(__BAND_THRESHOLDS.green, 0.8);
  assert.equal(__BAND_THRESHOLDS.yellow, 0.5);
  track();
});

console.log(`confidenceCalibration: ${passed} passed, 0 failed.`);
