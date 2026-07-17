import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsRetime, rescueCommuteTimes, needsDrivingFix, rescueDrivingValues, rescueOrphanedPops,
} from './popRescue';
import { commuteTimesFor, buildSlotSet, DEFAULT_SLOT_SET } from './commuteTimes';
import { DEFAULT_DRIVING_MODEL } from './drivingModel';
import { addInducedPop } from './popFactory';
import { DEFAULT_CONFIG } from './config';
import type { Coordinate } from '../types/core';
import type { DemandData, DemandPoint, Pop } from '../types/game-state';

const LEGACY_HOME = 8 * 3600;
const LEGACY_WORK = 17 * 3600;

/** H at the origin, W ~1.11 km east — far enough for driving values to be meaningful. */
const HOME_LOC: Coordinate = [0, 0];
const WORK_LOC: Coordinate = [0.01, 0];
function point(id: string, location: Coordinate): DemandPoint {
  return {
    id, location, residents: 0, jobs: 0, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}
function demand(): DemandData {
  return {
    points: new Map([['H', point('H', HOME_LOC)], ['W', point('W', WORK_LOC)]]),
    popsMap: new Map(),
  };
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

test('needsDrivingFix flags the legacy flat 1.30 / 11 m/s values', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  const pop = dd.popsMap.get('induced:1')!;
  // What older builds wrote: haversine * 1.30, then / 11 m/s.
  pop.drivingDistance = 1113 * 1.3;
  pop.drivingSeconds = pop.drivingDistance / 11;
  assert.equal(needsDrivingFix(pop, dd, DEFAULT_DRIVING_MODEL), true);
});

test('needsDrivingFix tolerates float noise but not real drift', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  const pop = dd.popsMap.get('induced:1')!;
  assert.equal(needsDrivingFix(pop, dd, DEFAULT_DRIVING_MODEL), false);
  pop.drivingSeconds *= 1.0001; // a refit nudging speeds by 0.01% must not churn
  assert.equal(needsDrivingFix(pop, dd, DEFAULT_DRIVING_MODEL), false);
  pop.drivingSeconds *= 1.5;    // 50% off is real drift
  assert.equal(needsDrivingFix(pop, dd, DEFAULT_DRIVING_MODEL), true);
});

test('needsDrivingFix ignores stubs, foreign pops and pops with vanished endpoints', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  const stub = dd.popsMap.get('induced:1')!;
  stub.drivingDistance = 1; stub.drivingSeconds = 1; stub.size = 0;
  assert.equal(needsDrivingFix(stub, dd, DEFAULT_DRIVING_MODEL), false);

  const base = { id: 'base-1', size: 200, residenceId: 'H', jobId: 'W', drivingDistance: 1, drivingSeconds: 1 } as Pop;
  assert.equal(needsDrivingFix(base, dd, DEFAULT_DRIVING_MODEL), false);

  addInducedPop(dd, 'H', 'W', 'induced:2', DEFAULT_CONFIG);
  const orphan = dd.popsMap.get('induced:2')!;
  orphan.residenceId = 'GONE';
  assert.equal(needsDrivingFix(orphan, dd, DEFAULT_DRIVING_MODEL), false);
});

test('rescueDrivingValues repairs legacy pops in place and is idempotent', () => {
  const dd = demand();
  for (let i = 0; i < 5; i++) {
    addInducedPop(dd, 'H', 'W', `induced:${i}`, DEFAULT_CONFIG);
    const p = dd.popsMap.get(`induced:${i}`)!;
    p.drivingDistance = 1113 * 1.3;
    p.drivingSeconds = p.drivingDistance / 11;
  }
  const before = dd.popsMap.get('induced:0')!;
  const residents = dd.points.get('H')!.residents;

  assert.equal(rescueDrivingValues(dd, DEFAULT_DRIVING_MODEL), 5);
  assert.equal(dd.popsMap.get('induced:0'), before, 'must mutate the same object');
  assert.equal(dd.popsMap.size, 5);
  assert.equal(dd.points.get('H')!.residents, residents, 'demand must not move');
  for (let i = 0; i < 5; i++) {
    const p = dd.popsMap.get(`induced:${i}`)!;
    const want = DEFAULT_DRIVING_MODEL.estimate(p.id, 'H', 'W', HOME_LOC, WORK_LOC);
    assert.ok(Math.abs(p.drivingDistance - want.distance) < 1e-6);
    assert.ok(Math.abs(p.drivingSeconds - want.seconds) < 1e-6);
    assert.ok(p.drivingSeconds > 0);
  }
  assert.equal(rescueDrivingValues(dd, DEFAULT_DRIVING_MODEL), 0);
});

test('rescueOrphanedPops re-anchors pops whose endpoints vanished from the city data', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  // A city data update removed W: the pop now poisons every commute batch.
  dd.points.delete('W');
  assert.equal(rescueOrphanedPops(dd, DEFAULT_CONFIG), 1);
  const pop = dd.popsMap.get('induced:1')!;
  assert.ok(dd.points.has(pop.residenceId) && dd.points.has(pop.jobId), 'endpoints must resolve');
  assert.equal(pop.size, 0, 'an orphan can no longer be a live commuter');
  assert.ok(dd.popsMap.has('induced:1'), 'but it must stay: movements may still reference it');
  // Its demand is removed from the endpoint that DID survive.
  assert.equal(dd.points.get('H')!.residents, 0);
  assert.deepEqual(dd.points.get('H')!.popIds, []);
  assert.equal(rescueOrphanedPops(dd, DEFAULT_CONFIG), 0, 'idempotent');
});

test('rescueOrphanedPops leaves healthy pops and foreign pops alone', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  const base = { id: 'base-1', size: 200, residenceId: 'GONE', jobId: 'ALSO_GONE' } as Pop;
  dd.popsMap.set('base-1', base);
  assert.equal(rescueOrphanedPops(dd, DEFAULT_CONFIG), 0);
  assert.equal(dd.popsMap.get('induced:1')!.size, 200, 'a healthy pop is untouched');
  assert.equal(base.residenceId, 'GONE', 'not our pop, not our problem');
});

test('rescueOrphanedPops repairs a stub written by an older build', () => {
  const dd = demand();
  // What the previous build produced when it had no record: empty endpoint ids.
  dd.popsMap.set('induced:9', { id: 'induced:9', size: 0, residenceId: '', jobId: '' } as Pop);
  assert.equal(rescueOrphanedPops(dd, DEFAULT_CONFIG), 1);
  const pop = dd.popsMap.get('induced:9')!;
  assert.ok(dd.points.has(pop.residenceId) && dd.points.has(pop.jobId));
  assert.equal(pop.size, 0);
});

test('rescueOrphanedPops does nothing when the city has no points', () => {
  const empty: DemandData = { points: new Map(), popsMap: new Map([['induced:1', { id: 'induced:1', size: 0, residenceId: '', jobId: '' } as Pop]]) };
  assert.equal(rescueOrphanedPops(empty, DEFAULT_CONFIG), 0);
});
