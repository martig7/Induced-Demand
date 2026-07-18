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

test('accessRes view: t is the ABSOLUTE value; negligible dropped', () => {
  const fc = buildHeatFeatures(sites, newLedger(), 'accessRes', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 2); // c (0.001) below MIN_T
  const a = fc.features.find((f) => f.properties.id === 'a')!;
  const b = fc.features.find((f) => f.properties.id === 'b')!;
  assert.equal(a.properties.t, 0.9); // absolute, NOT normalized to any max
  assert.equal(b.properties.t, 0.4);
  assert.equal(fc.maxValue, 0.9);
});

test('absolute scale: a site\'s color is independent of the rest of the field', () => {
  // 0.5 must map to t=0.5 whether or not a brighter 0.9 site is present.
  const withBright: Site[] = [
    { id: 'x', pointId: null, location: [0, 0], accessRes: 0.5, accessCom: 0 },
    { id: 'y', pointId: null, location: [1, 1], accessRes: 0.9, accessCom: 0 },
  ];
  const alone: Site[] = [withBright[0]];
  const tx = (fc: ReturnType<typeof buildHeatFeatures>) =>
    fc.features.find((f) => f.properties.id === 'x')!.properties.t;
  assert.equal(tx(buildHeatFeatures(withBright, newLedger(), 'accessRes', DEFAULT_CONFIG)), 0.5);
  assert.equal(tx(buildHeatFeatures(alone, newLedger(), 'accessRes', DEFAULT_CONFIG)), 0.5);
});

test('pressure view: t = min(1, accum / POP_SIZE), absolute', () => {
  const led = newLedger();
  led.sites = { b: [DEFAULT_CONFIG.POP_SIZE * 2, 0] };
  led.points.a = { baselineResidents: 0, baselineJobs: 0, resAccum: 100, jobAccum: 0 };
  const fc = buildHeatFeatures(sites, led, 'pressure', DEFAULT_CONFIG);
  const a = fc.features.find((f) => f.properties.id === 'a')!;
  const b = fc.features.find((f) => f.properties.id === 'b')!;
  assert.equal(b.properties.t, 1); // 2*POP_SIZE clamped
  assert.ok(Math.abs(a.properties.t - 100 / DEFAULT_CONFIG.POP_SIZE) < 1e-9);
});

test('empty field: no features, maxValue 0, no throw', () => {
  const fc = buildHeatFeatures(sites, newLedger(), 'pressure', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 0);
  assert.equal(fc.maxValue, 0);
});
