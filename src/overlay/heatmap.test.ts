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

test('accessRes view: t is value / citywide-max; max site is 1; negligible dropped', () => {
  const fc = buildHeatFeatures(sites, newLedger(), 'accessRes', DEFAULT_CONFIG);
  assert.equal(fc.maxValue, 0.9); // citywide max of accessRes
  assert.equal(fc.features.length, 2); // c (0.001/0.9 ≈ 0.001) below MIN_T
  const a = fc.features.find((f) => f.properties.id === 'a')!;
  const b = fc.features.find((f) => f.properties.id === 'b')!;
  assert.equal(a.properties.t, 1); // the citywide-max site is always the hot end
  assert.ok(Math.abs(b.properties.t - 0.4 / 0.9) < 1e-9);
});

test('t depends only on the value ratio, so scaling all values leaves colors unchanged', () => {
  // Halving every access value halves the max too → identical normalized t.
  const scaled = sites.map((s) => ({ ...s, accessRes: s.accessRes / 2 }));
  const base = buildHeatFeatures(sites, newLedger(), 'accessRes', DEFAULT_CONFIG);
  const half = buildHeatFeatures(scaled, newLedger(), 'accessRes', DEFAULT_CONFIG);
  assert.deepEqual(half.features.map((f) => f.properties.t), base.features.map((f) => f.properties.t));
  assert.equal(half.maxValue, base.maxValue / 2);
});

test('pressure view: normalized to the citywide-max accumulator', () => {
  const led = newLedger();
  led.sites = { b: [DEFAULT_CONFIG.POP_SIZE * 2, 0] };
  led.points.a = { baselineResidents: 0, baselineJobs: 0, resAccum: 100, jobAccum: 0 };
  const fc = buildHeatFeatures(sites, led, 'pressure', DEFAULT_CONFIG);
  assert.equal(fc.maxValue, 2); // b: 2*POP_SIZE / POP_SIZE
  const a = fc.features.find((f) => f.properties.id === 'a')!;
  const b = fc.features.find((f) => f.properties.id === 'b')!;
  assert.equal(b.properties.t, 1);
  assert.ok(Math.abs(a.properties.t - (100 / DEFAULT_CONFIG.POP_SIZE) / 2) < 1e-9);
});

test('empty field: no features, maxValue 0, no divide-by-zero', () => {
  const fc = buildHeatFeatures(sites, newLedger(), 'pressure', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 0);
  assert.equal(fc.maxValue, 0);
});
