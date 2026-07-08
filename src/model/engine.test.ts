import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDay } from './engine';
import { newLedger, captureBaselines, applyPendingRemovals, type LedgerState } from './ledger';
import { isInduced } from './popFactory';
import { makeRng } from './gravity';
import { DEFAULT_CONFIG, type InducedDemandConfig } from './config';
import type { DemandData, DemandPoint, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';

const ms = (transit: number) => ({ walking: 0, driving: 100 - transit, transit, unknown: 0 });
function point(id: string, loc: Coordinate, residents: number, jobs: number, rt: number, wt: number): DemandPoint {
  return { id, location: loc, residents, jobs, popIds: [], residentModeShare: ms(rt), workerModeShare: ms(wt) };
}
function station(id: string, coords: Coordinate, routeIds: string[]): Station {
  return { id, coords, routeIds } as unknown as Station;
}
function world(): DemandData {
  const points = new Map<string, DemandPoint>([
    ['H', point('H', [0, 0], 400, 0, 50, 0)],
    ['W', point('W', [0, 0.001], 0, 400, 0, 50)],
    ['Z', point('Z', [1, 1], 400, 400, 50, 50)],
  ]);
  return { points, popsMap: new Map() };
}

const cfg: InducedDemandConfig = { ...DEFAULT_CONFIG, R_GROW: 0.05, R_DECAY: 0.02 };

function inducedResidentsAt(dd: DemandData, ledger: LedgerState, id: string): number {
  let n = 0;
  for (const pop of dd.popsMap.values()) {
    if (!isInduced(pop.id) || pop.residenceId !== id) continue;
    if (ledger.pendingRemovals?.includes(pop.id)) continue;
    n += pop.size;
  }
  return n;
}
function inducedJobsAt(dd: DemandData, ledger: LedgerState, id: string): number {
  let n = 0;
  for (const pop of dd.popsMap.values()) {
    if (!isInduced(pop.id) || pop.jobId !== id) continue;
    if (ledger.pendingRemovals?.includes(pop.id)) continue;
    n += pop.size;
  }
  return n;
}

test('engine grows residents at served home points and jobs at served job points', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const stations = [station('s', [0, 0], ['r1', 'r2', 'r3'])];
  let added = 0;
  for (let day = 0; day < 400; day++) added += runDay(dd, stations, led, cfg, makeRng(day)).added;

  assert.equal(dd.points.get('H')!.residents, 600);
  assert.equal(dd.points.get('W')!.jobs, 600);
  assert.equal(dd.points.get('Z')!.residents, 400);
  assert.equal(dd.points.get('Z')!.jobs, 400);
  assert.equal(dd.points.get('H')!.residents - led.points['H'].baselineResidents, inducedResidentsAt(dd, led, 'H'));
  assert.equal(dd.points.get('W')!.jobs - led.points['W'].baselineJobs, inducedJobsAt(dd, led, 'W'));
  let totalResDelta = 0, totalJobDelta = 0;
  for (const p of dd.points.values()) {
    totalResDelta += p.residents - led.points[p.id].baselineResidents;
    totalJobDelta += p.jobs - led.points[p.id].baselineJobs;
  }
  assert.equal(totalResDelta, totalJobDelta);
  for (const pop of dd.popsMap.values()) if (isInduced(pop.id)) assert.equal(pop.size, 200);
  assert.ok(added >= 1);
});

test('engine records every induced pop it creates in the ledger roster', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const stations = [station('s', [0, 0], ['r1', 'r2', 'r3'])];
  for (let day = 0; day < 400; day++) runDay(dd, stations, led, cfg, makeRng(day));

  const inducedIds = [...dd.popsMap.values()].filter((p) => isInduced(p.id)).map((p) => p.id);
  assert.ok(inducedIds.length >= 1);
  assert.equal(Object.keys(led.pops).length, inducedIds.length);
  for (const id of inducedIds) {
    const pop = dd.popsMap.get(id)!;
    assert.deepEqual(led.pops[id], { residenceId: pop.residenceId, jobId: pop.jobId });
  }
});

test('engine removes roster entries when it decays induced pops', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const stations = [station('s', [0, 0], ['r1', 'r2', 'r3'])];
  for (let day = 0; day < 400; day++) runDay(dd, stations, led, cfg, makeRng(day));
  assert.ok(Object.keys(led.pops).length >= 1);

  for (let day = 0; day < 400; day++) runDay(dd, [], led, cfg, makeRng(1000 + day));
  applyPendingRemovals(dd, led, cfg);
  assert.equal(Object.keys(led.pops).length, 0); // all decayed → roster empty
});

test('engine queues decay removals instead of deleting pops live', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const stations = [station('s', [0, 0], ['r1', 'r2', 'r3'])];
  for (let day = 0; day < 400; day++) runDay(dd, stations, led, cfg, makeRng(day));
  assert.equal(dd.points.get('H')!.residents, 600);

  for (let day = 0; day < 400; day++) runDay(dd, [], led, cfg, makeRng(1000 + day));
  assert.ok(led.pendingRemovals && led.pendingRemovals.length >= 1);
  assert.equal(dd.points.get('H')!.residents, 400); // bookkeeping applied, popsMap kept
  assert.ok([...dd.popsMap.keys()].some((id) => id.startsWith('induced:')));
  applyPendingRemovals(dd, led, cfg);
  assert.equal(dd.points.get('H')!.residents, 400);
  assert.equal(led.pendingRemovals, undefined);
});

test('engine decays induced demand when the station is removed, never below baseline', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const stations = [station('s', [0, 0], ['r1', 'r2', 'r3'])];
  for (let day = 0; day < 400; day++) runDay(dd, stations, led, cfg, makeRng(day));
  assert.equal(dd.points.get('H')!.residents, 600);

  for (let day = 0; day < 400; day++) runDay(dd, [], led, cfg, makeRng(1000 + day));
  applyPendingRemovals(dd, led, cfg);
  assert.equal(dd.points.get('H')!.residents, 400);
  assert.equal(dd.points.get('W')!.jobs, 400);
  for (const pop of dd.popsMap.values()) assert.equal(isInduced(pop.id), false);
});
