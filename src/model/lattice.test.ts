import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Coordinate } from '../types/core';
import { haversine } from './geo';
import {
  createAnchorIndex, integrateCells, findCut, type LatticeDeps,
} from './lattice';

// Flat access everywhere inside catchments; constant density/spacing for
// hand-checkable integrals: supportedDensity = 1e-3 people/m².
const DEPS: LatticeDeps = {
  accessAt: () => ({ res: 0.8, com: 0.8 }),
  isWater: () => false,
  isAirport: () => false,
  supportedDensity: () => 1e-3,
  spacingAt: () => 300,
  minAccess: 0.05,
};

const anchors = (locs: [string, number, number][]): { id: string; location: Coordinate }[] =>
  locs.map(([id, lon, lat]) => ({ id, location: [lon, lat] }));

test('createAnchorIndex: nearest anchor, deterministic tie-break by id', () => {
  const idx = createAnchorIndex(anchors([['b', 0.01, 0], ['a', -0.01, 0]]));
  assert.equal(idx.nearest([0.009, 0])!.id, 'b');
  assert.equal(idx.nearest([-0.009, 0])!.id, 'a');
  // exact midpoint: equal distance → lexicographically smaller id
  assert.equal(idx.nearest([0, 0])!.id, 'a');
});

test('integrateCells: single anchor, single station — mass ≈ density × catchment area', () => {
  const a = anchors([['p1', 0, 0]]);
  const cells = integrateCells({
    anchors: a,
    stations: [[0, 0]],
    catchmentM: 1000,
    latticeM: 250,
    deps: DEPS,
  });
  const cell = cells.get('p1')!;
  // π·1000² m² × 1e-3 people/m² ≈ 3141 people; lattice discretization ±20%
  assert.ok(cell.supportedMass > 2500 && cell.supportedMass < 3800, `${cell.supportedMass}`);
  // uniform access → centroid ≈ the station/anchor position
  assert.ok(haversine(cell.centroid!, [0, 0]) < 250);
});

test('integrateCells: two anchors split the mass; samples beyond minAccess are excluded', () => {
  const a = anchors([['west', -0.005, 0], ['east', 0.005, 0]]);
  const gated: LatticeDeps = {
    ...DEPS,
    accessAt: (c) => (c[0] < 0 ? { res: 0.8, com: 0.8 } : { res: 0.01, com: 0.01 }),
  };
  const cells = integrateCells({
    anchors: a, stations: [[-0.005, 0], [0.005, 0]], catchmentM: 800, latticeM: 250, deps: gated,
  });
  // East side is below minAccess → east cell integrates ~nothing.
  assert.ok((cells.get('west')?.supportedMass ?? 0) > 0);
  assert.ok((cells.get('east')?.supportedMass ?? 0) < (cells.get('west')?.supportedMass ?? 0) / 4);
});

test('integrateCells: deterministic across calls', () => {
  const a = anchors([['p1', 0, 0], ['p2', 0.004, 0.003]]);
  const run = () => integrateCells({
    anchors: a, stations: [[0, 0], [0.004, 0.003]], catchmentM: 1200, latticeM: 250, deps: DEPS,
  });
  const c1 = run(), c2 = run();
  assert.deepEqual([...c1.entries()], [...c2.entries()]);
});

test('findCut: returns a dry, min-spaced sample in the cell near the centroid', () => {
  const a = anchors([['p1', 0, 0]]);
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 1200, latticeM: 250, deps: DEPS,
  });
  const cut = findCut({
    anchorId: 'p1',
    centroid: cells.get('p1')!.centroid!,
    anchors: a,
    latticeM: 250,
    deps: DEPS,
  });
  assert.ok(cut, 'a cut exists');
  // must respect min spacing from every anchor
  assert.ok(haversine(cut!, [0, 0]) >= 300 - 1, `${haversine(cut!, [0, 0])}`);
});

test('findCut: null when water or spacing exclude every sample', () => {
  const a = anchors([['p1', 0, 0]]);
  const wet: LatticeDeps = { ...DEPS, isWater: () => true };
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 800, latticeM: 250, deps: DEPS,
  });
  const cut = findCut({
    anchorId: 'p1', centroid: cells.get('p1')!.centroid!, anchors: a, latticeM: 250, deps: wet,
  });
  assert.equal(cut, null);
});

test('findCut: airport excludes every sample and tallies the reason', () => {
  const a = anchors([['p1', 0, 0]]);
  const onAirport: LatticeDeps = { ...DEPS, isAirport: () => true };
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 800, latticeM: 250, deps: DEPS,
  });
  const reject = { samples: 0, floor: 0, water: 0, airport: 0, outCell: 0, spacing: 0 };
  const cut = findCut({
    anchorId: 'p1', centroid: cells.get('p1')!.centroid!, anchors: a, latticeM: 250, deps: onAirport,
  }, reject);
  assert.equal(cut, null);
  assert.ok(reject.airport > 0 && reject.airport === reject.samples, 'all samples rejected as airport');
});

test('createAnchorIndex: nearer axial anchor two rings out beats a diagonal first hit', () => {
  // Reviewer repro: query near a cell corner. A sits diagonally in ring 0 at
  // ~704m; B sits axially two rings away at ~502m. A fixed "first hit + 1"
  // ring guard returns A; the distance-sound guard must return B.
  const M = 1 / 111194.9; // degrees per meter at the equator frame
  const idx = createAnchorIndex(anchors([
    ['a-diagonal', 499 * M, 499 * M],
    ['b-axial', -501 * M, 1 * M],
  ]));
  assert.equal(idx.nearest([1 * M, 1 * M])!.id, 'b-axial');
});
