import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitDensity, spacingAt, massAt, massResAt, massJobAt, targetSpacingAt, type FitInputPoint,
} from './densityFit';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

test('targetSpacingAt: absolute curve — R_MAX at access 0, TARGET_SPACING_FULL_M at 1, clamped, monotone', () => {
  assert.equal(targetSpacingAt(0, cfg), cfg.R_MAX);
  assert.equal(targetSpacingAt(1, cfg), cfg.TARGET_SPACING_FULL_M);
  // Monotone non-increasing with access (denser as access rises).
  assert.ok(targetSpacingAt(0.3, cfg) > targetSpacingAt(0.7, cfg));
  // Clamped to [R_MIN, R_MAX] regardless of input.
  assert.equal(targetSpacingAt(-5, cfg), cfg.R_MAX);
  const tiny = { ...cfg, TARGET_SPACING_FULL_M: 10 }; // below R_MIN
  assert.equal(targetSpacingAt(1, tiny), cfg.R_MIN);
  // Independent of the city: same value whatever the fixture density.
  assert.equal(targetSpacingAt(0.5, cfg), cfg.R_MAX - (cfg.R_MAX - cfg.TARGET_SPACING_FULL_M) * 0.5);
});

/** Synthetic city: dense high-access core (tight spacing, heavy mass), sparse low-access edge. */
function city(): FitInputPoint[] {
  const pts: FitInputPoint[] = [];
  // core: 10×10 grid at ~200 m pitch (0.0018°), access 0.9, mass 3000
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      pts.push({ location: [i * 0.0018, j * 0.0018], residents: 1500, jobs: 1500, access: 0.9 });
    }
  }
  // edge: 5×5 grid at ~1 km pitch, access 0.1, mass 300
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      pts.push({ location: [0.5 + i * 0.009, 0.5 + j * 0.009], residents: 200, jobs: 100, access: 0.1 });
    }
  }
  return pts;
}

test('fit: high access → tighter spacing and higher mass than low access', () => {
  const fit = fitDensity(city(), cfg);
  assert.ok(spacingAt(fit, 0.9) < spacingAt(fit, 0.1),
    `${spacingAt(fit, 0.9)} < ${spacingAt(fit, 0.1)}`);
  assert.ok(massAt(fit, 0.9) > massAt(fit, 0.1));
});

test('fit: drawn caps inherit each side\'s shape — even residents, skewed jobs; upper-half', () => {
  // One access bin. Residents EVEN (all 1000); jobs SKEWED (95% at 200, 5% at 6000).
  const pts: FitInputPoint[] = [];
  for (let i = 0; i < 100; i++) {
    pts.push({ location: [i * 0.002, 0], residents: 1000, jobs: i < 5 ? 6000 : 200, access: 0.9 });
  }
  const fit = fitDensity(pts, cfg);
  const floor = cfg.SPLIT_CAP_QUANTILE_FLOOR;
  // Even residents: every draw ≈ 1000, regardless of the per-point uniform.
  assert.ok(Math.abs(massResAt(fit, 0.9, 0, floor) - 1000) < 1);
  assert.ok(Math.abs(massResAt(fit, 0.9, 1, floor) - 1000) < 1);
  // Skewed jobs: a low draw sits in the body, a high draw reaches the tail.
  const jLow = massJobAt(fit, 0.9, 0, floor);
  const jHigh = massJobAt(fit, 0.9, 1, floor);
  assert.ok(jHigh > jLow * 3, `job draw spreads: high ${jHigh} ≫ low ${jLow}`);
  // A higher qFloor never draws below a lower one (bracket floor raises the low end).
  assert.ok(massJobAt(fit, 0.9, 0, 0.5) >= massJobAt(fit, 0.9, 0, 0.25),
    'raising the floor lifts the low draw');
});

test('fit: spacing clamped to [R_MIN, R_MAX]', () => {
  const fit = fitDensity(city(), cfg);
  for (const a of [0, 0.3, 0.6, 1]) {
    const s = spacingAt(fit, a);
    assert.ok(s >= cfg.R_MIN && s <= cfg.R_MAX, `spacing(${a}) = ${s}`);
  }
});

test('fit: mass clamped by envelope quantile', () => {
  const fit = fitDensity(city(), cfg);
  assert.ok(massAt(fit, 1) <= fit.massCeiling);
  assert.ok(fit.massCeiling <= 3000);
});

test('fit: curves are monotone across all access values', () => {
  const fit = fitDensity(city(), cfg);
  let prevS = Infinity, prevM = -Infinity;
  for (let a = 0; a <= 1.001; a += 0.05) {
    const s = spacingAt(fit, a), m = massAt(fit, a);
    assert.ok(s <= prevS + 1e-9, `spacing rose at ${a}`);
    assert.ok(m >= prevM - 1e-9, `mass fell at ${a}`);
    prevS = s; prevM = m;
  }
});

test('fit: empty input degrades to flat clamped defaults, no throw', () => {
  const fit = fitDensity([], cfg);
  assert.ok(spacingAt(fit, 0.5) >= cfg.R_MIN);
  assert.ok(massAt(fit, 0.5) >= 0);
});


// --- supported density (Voronoi subdivision) --------------------------------

import { supportedDensityAt } from './densityFit';

test('supportedDensityAt: massAt / spacingAt² (people per m²), higher where access is higher', () => {
  const fit = fitDensity(city(), cfg);
  const dHigh = supportedDensityAt(fit, 0.9);
  const dLow = supportedDensityAt(fit, 0.1);
  assert.ok(Math.abs(dHigh - massAt(fit, 0.9) / spacingAt(fit, 0.9) ** 2) < 1e-12);
  assert.ok(dHigh > dLow, `${dHigh} > ${dLow}`);
  // sanity: a plausible urban magnitude (people per m² is small)
  assert.ok(dHigh > 0 && dHigh < 1);
});
