import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '../model/field';
import { buildHeatFeatures } from './heatmap';
import { newLedger } from '../model/ledger';
import { DEFAULT_CONFIG } from './../model/config';

const sites: Site[] = [
  { id: 'a', pointId: 'a', location: [0, 0], accessRes: 0.9, accessCom: 0.2 },
  { id: 'b', pointId: null, location: [1, 1], accessRes: 0.4, accessCom: 0.7 },
  { id: 'c', pointId: null, location: [2, 2], accessRes: 0.001, accessCom: 0.001 },
];

test('accessRes view: weight = accessRes, near-zero sites dropped', () => {
  const fc = buildHeatFeatures(sites, newLedger(), 'accessRes', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0].properties.w, 0.9);
});

test('pressure view: weight = accum / POP_SIZE clamped to 1', () => {
  const led = newLedger();
  led.sites = { b: [DEFAULT_CONFIG.POP_SIZE * 2, 0] };
  led.points.a = { baselineResidents: 0, baselineJobs: 0, resAccum: 100, jobAccum: 0 };
  const fc = buildHeatFeatures(sites, led, 'pressure', DEFAULT_CONFIG);
  const wa = fc.features.find((f) => f.properties.id === 'a')!.properties.w;
  const wb = fc.features.find((f) => f.properties.id === 'b')!.properties.w;
  assert.ok(Math.abs(wa - 100 / DEFAULT_CONFIG.POP_SIZE) < 1e-9);
  assert.equal(wb, 1); // clamped
});
