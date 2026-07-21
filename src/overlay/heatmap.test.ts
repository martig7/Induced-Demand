import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '../model/field';
import { buildHeatFeatures } from './heatmap';
import { newLedger } from '../model/ledger';
import { DEFAULT_CONFIG } from './../model/config';

const sites: Site[] = [
  { id: 'a', pointId: 'a', location: [0, 0], accessRes: 0.9, accessCom: 0.2 },
  { id: 'b', pointId: 'b', location: [1, 1], accessRes: 0.4, accessCom: 0.7 },
  { id: 'c', pointId: 'c', location: [2, 2], accessRes: 0.001, accessCom: 0.001 },
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
    { id: 'x', pointId: 'x', location: [0, 0], accessRes: 0.5, accessCom: 0 },
    { id: 'y', pointId: 'y', location: [1, 1], accessRes: 0.9, accessCom: 0 },
  ];
  const alone: Site[] = [withBright[0]];
  const tx = (fc: ReturnType<typeof buildHeatFeatures>) =>
    fc.features.find((f) => f.properties.id === 'x')!.properties.t;
  assert.equal(tx(buildHeatFeatures(withBright, newLedger(), 'accessRes', DEFAULT_CONFIG)), 0.5);
  assert.equal(tx(buildHeatFeatures(alone, newLedger(), 'accessRes', DEFAULT_CONFIG)), 0.5);
});

test('pressure view: t = min(1, accum / POP_SIZE), absolute', () => {
  const led = newLedger();
  led.points.b = { baselineResidents: 0, baselineJobs: 0, resAccum: DEFAULT_CONFIG.POP_SIZE * 2, jobAccum: 0 };
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

// --- rasterization -----------------------------------------------------------

import { rampColor, rasterizeField, type HeatFeature } from './heatmap';

const feat = (id: string, lon: number, lat: number, t: number): HeatFeature => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id, t },
});

test('rampColor: endpoints and midpoint match the palette', () => {
  assert.deepEqual(rampColor(0), [237, 248, 251]);   // RAMP_LOW #edf8fb
  assert.deepEqual(rampColor(1), [129, 15, 124]);    // RAMP_HIGH #810f7c
  assert.deepEqual(rampColor(0.5), [140, 150, 198]); // RAMP_MID #8c96c6
  assert.deepEqual(rampColor(-5), rampColor(0));     // clamped
  assert.deepEqual(rampColor(5), rampColor(1));
});

test('rasterizeField: empty → 1x1 transparent pixel', () => {
  const r = rasterizeField([]);
  assert.equal(r.width, 1);
  assert.equal(r.height, 1);
  assert.equal(r.data[3], 0); // alpha 0
});

test('rasterizeField: a single site is hot at its center and transparent far away', () => {
  const r = rasterizeField([feat('a', -74, 40.7, 1)], { gridMax: 41, kernelMeters: 700 });
  assert.ok(r.width >= 1 && r.height >= 1);
  // bbox brackets the site (padded by the kernel).
  assert.ok(r.bbox[0] < -74 && r.bbox[2] > -74 && r.bbox[1] < 40.7 && r.bbox[3] > 40.7);
  // Locate the site's pixel and assert it is opaque with a hot (RAMP_HIGH-ish) color.
  const [w, s, e, n] = r.bbox;
  const cx = Math.floor(((-74 - w) / (e - w)) * r.width);
  const cy = Math.floor(((n - 40.7) / (n - s)) * r.height);
  const o = (cy * r.width + cx) * 4;
  assert.ok(r.data[o + 3] > 200, `center alpha ${r.data[o + 3]}`);
  assert.ok(r.data[o] < 180 && r.data[o + 2] > 80, 'center trends toward the hot ramp end');
  // A corner well outside the kernel is fully transparent.
  const corner = 3; // top-left pixel's alpha
  assert.equal(r.data[corner], 0);
});

test('rasterizeField: max-combine, not sum — two coincident sites do not exceed t=1 color', () => {
  const one = rasterizeField([feat('a', 0, 0, 0.6)], { gridMax: 21, kernelMeters: 700 });
  const two = rasterizeField([feat('a', 0, 0, 0.6), feat('b', 0, 0, 0.6)], { gridMax: 21, kernelMeters: 700 });
  // Same center pixel color: overlapping identical sites take the max (0.6), never sum to a hotter value.
  const center = (r: typeof one) => {
    const [w, s, e, n] = r.bbox;
    const cx = Math.floor(((0 - w) / (e - w)) * r.width);
    const cy = Math.floor(((n - 0) / (n - s)) * r.height);
    const o = (cy * r.width + cx) * 4;
    return [r.data[o], r.data[o + 1], r.data[o + 2]];
  };
  assert.deepEqual(center(two), center(one));
});

// --- prospective cuts (Voronoi subdivision) ----------------------------------

test('pressure view: prospective cuts render with t = pressure/threshold', () => {
  const led = newLedger();
  led.points.a = { baselineResidents: 0, baselineJobs: 0, resAccum: 100, jobAccum: 0 };
  const cuts = [{ location: [3, 3] as [number, number], t: 0.6 }];
  const fc = buildHeatFeatures(sites, led, 'pressure', DEFAULT_CONFIG, cuts);
  const cut = fc.features.find((f) => f.properties.id === 'cut:0');
  assert.ok(cut, 'cut feature present');
  assert.equal(cut!.properties.t, 0.6);
  assert.deepEqual(cut!.geometry.coordinates, [3, 3]);
});

test('access views ignore cuts; negligible cut pressure dropped', () => {
  const cuts = [
    { location: [3, 3] as [number, number], t: 0.6 },
    { location: [4, 4] as [number, number], t: 0.001 },
  ];
  const accessFc = buildHeatFeatures(sites, newLedger(), 'accessRes', DEFAULT_CONFIG, cuts);
  assert.ok(!accessFc.features.some((f) => f.properties.id.startsWith('cut:')));
  const pressureFc = buildHeatFeatures(sites, newLedger(), 'pressure', DEFAULT_CONFIG, cuts);
  assert.equal(pressureFc.features.filter((f) => f.properties.id.startsWith('cut:')).length, 1);
});

// --- continuous access field -------------------------------------------------

import { rasterizeAccessField } from './heatmap';

test('rasterizeAccessField: paints the continuous field where access is positive', () => {
  // High access only in the eastern half of the bbox → west transparent, east hot.
  const r = rasterizeAccessField([0, 0, 1, 1], (lon) => (lon > 0.5 ? 0.9 : 0), { gridMax: 20 });
  assert.equal(r.empty, false);
  const px = (fx: number, fy: number) => {
    const x = Math.floor(fx * r.width), y = Math.floor(fy * r.height);
    return r.data[(y * r.width + x) * 4 + 3]; // alpha
  };
  assert.ok(px(0.8, 0.5) > 200, 'east is opaque (high access)');
  assert.equal(px(0.2, 0.5), 0, 'west is transparent (no access)');
  assert.deepEqual(r.bbox, [0, 0, 1, 1]); // domain is honored exactly (no kernel padding)
});

test('rasterizeAccessField: all-zero field is empty; degenerate bbox is empty', () => {
  assert.equal(rasterizeAccessField([0, 0, 1, 1], () => 0, { gridMax: 8 }).empty, true);
  assert.equal(rasterizeAccessField([0, 0, 0, 0], () => 0.9, { gridMax: 8 }).empty, true);
});

test('rasterizeAccessField: hatchAt punches transparent diagonal stripes into a solid fill', () => {
  const solid = rasterizeAccessField([0, 0, 1, 1], () => 0.9, { gridMax: 20 });
  const hatched = rasterizeAccessField([0, 0, 1, 1], () => 0.9, { gridMax: 20, hatchAt: () => true });
  const opaque = (r: ReturnType<typeof rasterizeAccessField>) => {
    let count = 0;
    for (let i = 3; i < r.data.length; i += 4) if (r.data[i] > 0) count++;
    return count;
  };
  assert.equal(opaque(solid), solid.width * solid.height, 'solid fills every pixel');
  const h = opaque(hatched);
  assert.ok(h > 0 && h < opaque(solid), `hatch drops ~half the pixels (got ${h})`);
  assert.equal(hatched.empty, false);
});

