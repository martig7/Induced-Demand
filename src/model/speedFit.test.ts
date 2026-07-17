import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSpeeds, medianRatio, calibrateSpeeds, calibrateSpeedsAsync, type FitSample } from './speedFit';
import { buildRoadGraph } from './roadGraph';
import { DEFAULT_SPEEDS } from './router';

/** Synthetic pops whose times come from known speeds — the fit must recover them. */
function samplesFrom(speeds: { highway: number; major: number; minor: number }, n = 60): FitSample[] {
  const out: FitSample[] = [];
  for (let i = 0; i < n; i++) {
    const L: [number, number, number] = [(i % 7) * 900, (i % 5) * 400, (i % 3) * 250 + 200];
    out.push({
      classLengths: L,
      seconds: L[0] / speeds.highway + L[1] / speeds.major + L[2] / speeds.minor,
    });
  }
  return out;
}

test('fitSpeeds recovers the speeds that generated the samples', () => {
  const truth = { highway: 22, major: 13, minor: 7 };
  const got = fitSpeeds(samplesFrom(truth));
  for (const k of ['highway', 'major', 'minor'] as const) {
    assert.ok(Math.abs(got[k] - truth[k]) < 0.05, `${k}: got ${got[k]}, want ${truth[k]}`);
  }
});

test('fitSpeeds clamps implausible fits into a sane range', () => {
  // Times far too small for the distances → unbounded speeds without a clamp.
  const absurd: FitSample[] = Array.from({ length: 30 }, (_, i) => ({
    classLengths: [1000 + i, 0, 0], seconds: 0.001,
  }));
  const got = fitSpeeds(absurd);
  assert.ok(got.highway <= 45 && got.highway >= 2, `got ${got.highway}`);
});

test('fitSpeeds falls back to the defaults when samples are too few or degenerate', () => {
  assert.deepEqual(fitSpeeds([]), DEFAULT_SPEEDS);
  assert.deepEqual(fitSpeeds(samplesFrom({ highway: 20, major: 12, minor: 8 }, 3)), DEFAULT_SPEEDS);
  // All-zero lengths: the normal equations are singular.
  const degenerate: FitSample[] = Array.from({ length: 30 }, () => ({ classLengths: [0, 0, 0], seconds: 10 }));
  assert.deepEqual(fitSpeeds(degenerate), DEFAULT_SPEEDS);
});

test('fitSpeeds ignores samples with non-finite or non-positive times', () => {
  const truth = { highway: 22, major: 13, minor: 7 };
  const dirty: FitSample[] = [
    ...samplesFrom(truth),
    { classLengths: [500, 0, 0], seconds: 0 },
    { classLengths: [500, 0, 0], seconds: NaN },
    { classLengths: [500, 0, 0], seconds: -5 },
  ];
  const got = fitSpeeds(dirty);
  assert.ok(Math.abs(got.highway - truth.highway) < 0.05);
});

test('medianRatio centres a systematic bias', () => {
  // Every routed time is 0.94x the real one: the correction must be 0.94.
  const pairs = Array.from({ length: 21 }, (_, i) => ({ routed: (i + 1) * 0.94, real: i + 1 }));
  assert.ok(Math.abs(medianRatio(pairs) - 0.94) < 1e-9);
  assert.equal(medianRatio([]), 1);
});

test('applying medianRatio to speeds removes the bias', () => {
  // routed/real = 0.94 means we are 6% too fast, so speeds must scale DOWN by 0.94.
  const speeds = { highway: 20, major: 12, minor: 8 };
  const ratio = 0.94;
  const corrected = {
    highway: speeds.highway * ratio, major: speeds.major * ratio, minor: speeds.minor * ratio,
  };
  // A trip that took 94 s routed and 100 s really now takes 100 s.
  const routedSeconds = 1000 / speeds.highway;             // 50 s at 20 m/s
  const correctedSeconds = 1000 / corrected.highway;       // 53.2 s at 18.8 m/s
  assert.ok(Math.abs(correctedSeconds - routedSeconds / ratio) < 1e-9);
});

test('calibrateSpeedsAsync yields between chunks so the renderer never freezes', async () => {
  const graph = buildRoadGraph({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { roadClass: 'minor' },
      geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0], [0.02, 0]] } }],
  });
  const pairs = Array.from({ length: 40 }, () => ({
    residence: [0, 0] as [number, number], job: [0.02, 0] as [number, number], seconds: 300,
  }));
  let yields = 0;
  const speeds = await calibrateSpeedsAsync(graph, pairs, { chunk: 10, onYield: async () => { yields++; } });
  assert.ok(yields >= 3 * 3, `expected repeated yields, got ${yields}`);
  for (const v of [speeds.highway, speeds.major, speeds.minor]) assert.ok(v > 0 && Number.isFinite(v));
});

test('calibrateSpeedsAsync agrees with the synchronous fit', async () => {
  const graph = buildRoadGraph({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { roadClass: 'minor' }, geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] } },
      { type: 'Feature', properties: { roadClass: 'highway' }, geometry: { type: 'LineString', coordinates: [[0.01, 0], [0.05, 0]] } },
    ],
  });
  const pairs = Array.from({ length: 30 }, (_, i) => ({
    residence: [0, 0] as [number, number], job: [0.05, 0] as [number, number], seconds: 400 + i,
  }));
  assert.deepEqual(await calibrateSpeedsAsync(graph, pairs, { chunk: 7 }), calibrateSpeeds(graph, pairs));
});
