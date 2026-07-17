import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsRetime, rescueCommuteTimes } from './commuteRescue';
import { commuteTimesFor, buildSlotSet, DEFAULT_SLOT_SET } from './commuteTimes';
import { addInducedPop } from './popFactory';
import { DEFAULT_CONFIG } from './config';
import type { DemandData, DemandPoint, Pop } from '../types/game-state';

const LEGACY_HOME = 8 * 3600;
const LEGACY_WORK = 17 * 3600;

function point(id: string): DemandPoint {
  return {
    id, location: [0, 0], residents: 0, jobs: 0, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}
function demand(): DemandData {
  return { points: new Map([['H', point('H')], ['W', point('W')]]), popsMap: new Map() };
}
/** A pop as older mod builds created it: every commute pinned to 8:00 / 17:00. */
function legacyPop(dd: DemandData, id: string): Pop {
  addInducedPop(dd, 'H', 'W', id, DEFAULT_CONFIG);
  const pop = dd.popsMap.get(id)!;
  pop.homeDepartureTime = LEGACY_HOME;
  pop.workDepartureTime = LEGACY_WORK;
  return pop;
}

test('needsRetime is false for a pop already holding its generated times', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  assert.equal(needsRetime(dd.popsMap.get('induced:1')!, DEFAULT_SLOT_SET), false);
});

test('needsRetime flags the legacy fixed 8/17 pair', () => {
  const dd = demand();
  assert.equal(needsRetime(legacyPop(dd, 'induced:1'), DEFAULT_SLOT_SET), true);
});

test('needsRetime ignores non-induced pops and inert size-0 stubs', () => {
  const base = { id: 'base-1', size: 200, residenceId: 'H', jobId: 'W', homeDepartureTime: 0, workDepartureTime: 0 } as Pop;
  assert.equal(needsRetime(base, DEFAULT_SLOT_SET), false);

  const dd = demand();
  const stub = legacyPop(dd, 'induced:2');
  stub.size = 0; // retired tombstone: never rides, times are irrelevant
  assert.equal(needsRetime(stub, DEFAULT_SLOT_SET), false);
});

test('rescueCommuteTimes retimes legacy pops in place, leaving everything else identical', () => {
  const dd = demand();
  for (let i = 0; i < 5; i++) legacyPop(dd, `induced:${i}`);
  const before = dd.popsMap.get('induced:0')!;
  const residentsBefore = dd.points.get('H')!.residents;
  const popIdsBefore = [...dd.points.get('H')!.popIds];

  const retimed = rescueCommuteTimes(dd, DEFAULT_SLOT_SET);

  assert.equal(retimed, 5);
  assert.equal(dd.popsMap.size, 5, 'no pop may be added or deleted');
  assert.equal(dd.popsMap.get('induced:0'), before, 'must mutate the SAME object, not replace it');
  assert.equal(dd.points.get('H')!.residents, residentsBefore, 'demand must not move');
  assert.deepEqual(dd.points.get('H')!.popIds, popIdsBefore, 'endpoints must stay linked');
  for (let i = 0; i < 5; i++) {
    const pop = dd.popsMap.get(`induced:${i}`)!;
    const want = commuteTimesFor(pop.id, pop.jobId, DEFAULT_SLOT_SET);
    assert.equal(pop.homeDepartureTime, want.homeDepartureTime);
    assert.equal(pop.workDepartureTime, want.workDepartureTime);
    assert.equal(pop.size, 200);
    assert.equal(pop.residenceId, 'H');
    assert.equal(pop.jobId, 'W');
  }
});

test('rescueCommuteTimes is idempotent — a healthy world needs no work', () => {
  const dd = demand();
  for (let i = 0; i < 5; i++) legacyPop(dd, `induced:${i}`);
  assert.equal(rescueCommuteTimes(dd, DEFAULT_SLOT_SET), 5);
  assert.equal(rescueCommuteTimes(dd, DEFAULT_SLOT_SET), 0);
});

test('rescueCommuteTimes retimes to the live ranges when they change', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG); // healthy under the default table
  const nightShift = buildSlotSet({
    ranges: [
      { start: 0, end: 12, homeDemandMultiplier: 1, workDemandMultiplier: 0 },
      { start: 12, end: 24, homeDemandMultiplier: 0, workDemandMultiplier: 1 },
    ],
  });
  assert.equal(rescueCommuteTimes(dd, nightShift), 1);
  const pop = dd.popsMap.get('induced:1')!;
  assert.deepEqual(
    { h: pop.homeDepartureTime, w: pop.workDepartureTime },
    { h: commuteTimesFor('induced:1', 'W', nightShift).homeDepartureTime, w: commuteTimesFor('induced:1', 'W', nightShift).workDepartureTime },
  );
  assert.equal(rescueCommuteTimes(dd, nightShift), 0);
});

test('rescueCommuteTimes never touches pops the mod does not own', () => {
  const dd = demand();
  const base = { id: 'base-1', size: 200, residenceId: 'H', jobId: 'W', homeDepartureTime: 1, workDepartureTime: 2 } as Pop;
  dd.popsMap.set('base-1', base);
  legacyPop(dd, 'induced:1');
  assert.equal(rescueCommuteTimes(dd, DEFAULT_SLOT_SET), 1);
  assert.equal(base.homeDepartureTime, 1);
  assert.equal(base.workDepartureTime, 2);
});
