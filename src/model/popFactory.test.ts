import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInduced, addInducedPop, removeInducedPop, deferredRemovalPopCount, countInducedPops,
  deferInducedPopRemoval, ensureTombstoneStub,
} from './popFactory';
import { DEFAULT_CONFIG } from './config';
import type { DemandData, DemandPoint } from '../types/game-state';

function point(id: string): DemandPoint {
  return {
    id, location: id === 'H' ? [0, 0] : [0, 0.01], jobs: 0, residents: 0, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}
function demand(): DemandData {
  const points = new Map<string, DemandPoint>([['H', point('H')], ['W', point('W')]]);
  return { points, popsMap: new Map() };
}

test('isInduced detects our prefix', () => {
  assert.equal(isInduced('induced:1'), true);
  assert.equal(isInduced('base-42'), false);
});

test('addInducedPop adds 200 residents/jobs and links both endpoints', () => {
  const dd = demand();
  const ok = addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  assert.equal(ok, true);
  assert.equal(dd.points.get('H')!.residents, 200);
  assert.equal(dd.points.get('W')!.jobs, 200);
  assert.equal(dd.points.get('H')!.jobs, 0);
  assert.equal(dd.points.get('W')!.residents, 0);
  assert.deepEqual(dd.points.get('H')!.popIds, ['induced:1']);
  assert.deepEqual(dd.points.get('W')!.popIds, ['induced:1']);
  const pop = dd.popsMap.get('induced:1')!;
  assert.equal(pop.size, 200);
  assert.equal(pop.residenceId, 'H');
  assert.equal(pop.jobId, 'W');
});

test('removeInducedPop reverses the add exactly', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  const ok = removeInducedPop(dd, 'induced:1', DEFAULT_CONFIG);
  assert.equal(ok, true);
  assert.equal(dd.points.get('H')!.residents, 0);
  assert.equal(dd.points.get('W')!.jobs, 0);
  assert.deepEqual(dd.points.get('H')!.popIds, []);
  assert.deepEqual(dd.points.get('W')!.popIds, []);
  assert.equal(dd.popsMap.size, 0);
});

test('removeInducedPop refuses non-induced ids', () => {
  const dd = demand();
  dd.popsMap.set('base-1', { id: 'base-1', size: 200, residenceId: 'H', jobId: 'W' } as never);
  assert.equal(removeInducedPop(dd, 'base-1', DEFAULT_CONFIG), false);
});

test('deferredRemovalPopCount uses pendingRemovals or all induced when clear is queued', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  addInducedPop(dd, 'H', 'W', 'induced:2', DEFAULT_CONFIG);
  assert.equal(countInducedPops(dd), 2);
  assert.equal(deferredRemovalPopCount(dd, { pendingRemovals: ['induced:1'] }, false), 1);
  assert.equal(deferredRemovalPopCount(dd, { pendingRemovals: ['induced:1'] }, true), 2);
});

// Retired/deferred pops must be fully inert: size 0 means they add nothing to
// mode-share sums or ridership, and our overlay (which sums pop.size over popsMap)
// no longer overcounts them. The entry itself stays so movements resolve by id.
test('deferInducedPopRemoval zeroes the pop size so it stops counting anywhere', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  const led: { pendingRemovals?: string[] } = {};
  deferInducedPopRemoval(dd, led, 'induced:1', DEFAULT_CONFIG);
  assert.equal(dd.popsMap.get('induced:1')!.size, 0);
});

test('ensureTombstoneStub creates a size-0 stub', () => {
  const dd = demand();
  ensureTombstoneStub(dd, 'induced:9', { residenceId: 'H', jobId: 'W' }, DEFAULT_CONFIG);
  assert.equal(dd.popsMap.get('induced:9')!.size, 0);
  assert.equal(dd.points.get('H')!.residents, 0);
  assert.deepEqual(dd.points.get('H')!.popIds, []);
});
