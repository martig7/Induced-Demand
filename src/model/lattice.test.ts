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
  blockedWithin: () => false,
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

test('integrateCells: water bounds the cell — no mass/centroid over the blocked side', () => {
  const a = anchors([['p1', 0, 0]]);
  const eastBlocked: LatticeDeps = { ...DEPS, blockedWithin: ([lon]) => lon > 0 }; // east half is water
  const open = integrateCells({ anchors: a, stations: [[0, 0]], catchmentM: 1000, latticeM: 250, deps: DEPS });
  const bounded = integrateCells({ anchors: a, stations: [[0, 0]], catchmentM: 1000, latticeM: 250, clearanceM: 0, deps: eastBlocked });
  const co = open.get('p1')!, cb = bounded.get('p1')!;
  assert.ok(cb.supportedMass < co.supportedMass * 0.75, 'the blocked half is dropped from the mass');
  assert.ok(cb.centroid![0] < 0, 'centroid sits on the open (western) side, off the water');
});

test('findCut: null when water or spacing exclude every sample', () => {
  const a = anchors([['p1', 0, 0]]);
  const wet: LatticeDeps = { ...DEPS, blockedWithin: () => true };
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 800, latticeM: 250, deps: DEPS,
  });
  const cut = findCut({
    anchorId: 'p1', centroid: cells.get('p1')!.centroid!, anchors: a, latticeM: 250, deps: wet,
  });
  assert.equal(cut, null);
});

test('findCut: a fully-blocked cell excludes every sample and tallies the reason', () => {
  const a = anchors([['p1', 0, 0]]);
  const blocked: LatticeDeps = { ...DEPS, blockedWithin: () => true };
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 800, latticeM: 250, deps: DEPS,
  });
  const reject = { samples: 0, floor: 0, blocked: 0, outCell: 0, spacing: 0, clearance: 0 };
  const cut = findCut({
    anchorId: 'p1', centroid: cells.get('p1')!.centroid!, anchors: a, latticeM: 250, deps: blocked,
  }, reject);
  assert.equal(cut, null);
  assert.ok(reject.blocked > 0 && reject.blocked === reject.samples, 'all samples rejected as blocked');
});

test('findCut: clearance margin rejects candidates hugging a shoreline', () => {
  const a = anchors([['p1', 0, 0]]);
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 800, latticeM: 250, deps: DEPS,
  });
  const M = 1 / 111194.9; // deg per metre (lat)
  // Dry only in a thin |lat| < 100 m horizontal strip; water is within r of a
  // point once the disc's far edge reaches |lat| = 100 m, i.e. |lat| ≥ (100−r).
  const strip: LatticeDeps = { ...DEPS, blockedWithin: ([, lat], r) => Math.abs(lat) >= (100 - r) * M };
  const centroid = cells.get('p1')!.centroid!;
  const dry = findCut({ anchorId: 'p1', centroid, anchors: a, latticeM: 150, deps: strip });
  const reject = { samples: 0, floor: 0, blocked: 0, outCell: 0, spacing: 0, clearance: 0 };
  const clear = findCut({
    anchorId: 'p1', centroid, anchors: a, latticeM: 150, clearanceM: 120, deps: strip,
  }, reject);
  assert.ok(dry !== null, 'without clearance a dry strip point is accepted');
  assert.equal(clear, null, 'a 120 m clearance is wider than the strip — every candidate is rejected');
  assert.ok(reject.clearance > 0, 'clearance rejects are tallied');
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
