import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDay, type RunDayDeps } from './engine';
import { newLedger, captureBaselines, retirePendingRemovals, type LedgerState } from './ledger';
import { isInduced } from './popFactory';
import { makeRng } from './gravity';
import { DEFAULT_CONFIG, type InducedDemandConfig } from './config';
import type { DemandData, DemandPoint } from '../types/game-state';
import type { Site } from './field';

const ms = (transit: number) => ({ walking: 0, driving: 100 - transit, transit, unknown: 0 });
function point(id: string, lon: number, lat: number, residents: number, jobs: number, rt = 0, wt = 0): DemandPoint {
  return { id, location: [lon, lat], residents, jobs, popIds: [], residentModeShare: ms(rt), workerModeShare: ms(wt) };
}
function makeDD(points: DemandPoint[]): DemandData {
  return { points: new Map(points.map((p) => [p.id, p])), popsMap: new Map() };
}
function world(): DemandData {
  return makeDD([
    point('H', 0, 0, 400, 0, 50, 0),
    point('W', 0, 0.001, 0, 400, 0, 50),
    point('Z', 1, 1, 400, 400, 50, 50),
  ]);
}

/** Occupied site for an existing point with directly-injected access. */
function siteOf(p: DemandPoint, access = 0.8): Site {
  return { id: p.id, pointId: p.id, location: p.location, accessRes: access, accessCom: access };
}
const DAY_DEPS: RunDayDeps = {
  massAt: () => 2000,
  cells: null,
  findCut: () => null,
};

/** Served sites for H/W (access 0.8), Z unserved (access 0) — mirrors the old single-station fixture. */
function servedSites(dd: DemandData): Site[] {
  return [...dd.points.values()].map((p) => siteOf(p, p.id === 'Z' ? 0 : 0.8));
}
/** Every point unserved — mirrors the old "no stations" runs. */
function noAccessSites(dd: DemandData): Site[] {
  return [...dd.points.values()].map((p) => siteOf(p, 0));
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
  let added = 0;
  for (let day = 0; day < 400; day++) added += runDay(dd, servedSites(dd), led, cfg, makeRng(day), DAY_DEPS).added;

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
  for (const pop of dd.popsMap.values()) {
    if (!isInduced(pop.id)) continue;
    // Live pops are full 200-person groups; decay-deferred ones are inert (size 0).
    assert.equal(pop.size, led.pendingRemovals?.includes(pop.id) ? 0 : 200);
  }
  assert.ok(added >= 1);
});

test('engine grows nothing when no site has access (track-only infrastructure)', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  let added = 0;
  for (let day = 0; day < 400; day++) added += runDay(dd, noAccessSites(dd), led, cfg, makeRng(day), DAY_DEPS).added;

  assert.equal(added, 0);
  assert.equal(dd.points.get('H')!.residents, 400);
  assert.equal(dd.points.get('W')!.jobs, 400);
});

test('engine records every induced pop it creates in the ledger roster', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  for (let day = 0; day < 400; day++) runDay(dd, servedSites(dd), led, cfg, makeRng(day), DAY_DEPS);

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
  for (let day = 0; day < 400; day++) runDay(dd, servedSites(dd), led, cfg, makeRng(day), DAY_DEPS);
  assert.ok(Object.keys(led.pops).length >= 1);

  for (let day = 0; day < 400; day++) runDay(dd, noAccessSites(dd), led, cfg, makeRng(1000 + day), DAY_DEPS);
  retirePendingRemovals(dd, led, cfg);
  assert.equal(Object.keys(led.pops).length, 0); // all decayed → roster empty
});

test('engine queues decay removals instead of deleting pops live', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  for (let day = 0; day < 400; day++) runDay(dd, servedSites(dd), led, cfg, makeRng(day), DAY_DEPS);
  assert.equal(dd.points.get('H')!.residents, 600);

  for (let day = 0; day < 400; day++) runDay(dd, noAccessSites(dd), led, cfg, makeRng(1000 + day), DAY_DEPS);
  assert.ok(led.pendingRemovals && led.pendingRemovals.length >= 1);
  assert.equal(dd.points.get('H')!.residents, 400); // bookkeeping applied, popsMap kept
  assert.ok([...dd.popsMap.keys()].some((id) => id.startsWith('induced:')));
  retirePendingRemovals(dd, led, cfg);
  assert.equal(dd.points.get('H')!.residents, 400);
  assert.equal(led.pendingRemovals, undefined);
});

test('engine decays induced demand when access is removed, never below baseline', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  for (let day = 0; day < 400; day++) runDay(dd, servedSites(dd), led, cfg, makeRng(day), DAY_DEPS);
  assert.equal(dd.points.get('H')!.residents, 600);

  for (let day = 0; day < 400; day++) runDay(dd, noAccessSites(dd), led, cfg, makeRng(1000 + day), DAY_DEPS);
  retirePendingRemovals(dd, led, cfg);
  assert.equal(dd.points.get('H')!.residents, 400);
  assert.equal(dd.points.get('W')!.jobs, 400);
  // Retired pops stay in popsMap as demand-neutral tombstone stubs (deleting them
  // would orphan in-flight movements); every remaining induced entry must be one.
  for (const pop of dd.popsMap.values()) {
    if (isInduced(pop.id)) assert.ok(led.tombstones?.[pop.id]);
  }
});

test('runDay reports per-point deltas for the history view', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  let ar = 0, aj = 0, addedTotal = 0;
  for (let day = 0; day < 400; day++) {
    const r = runDay(dd, servedSites(dd), led, cfg, makeRng(day), DAY_DEPS);
    addedTotal += r.added;
    for (const d of Object.values(r.deltas)) { ar += d.ar; aj += d.aj; }
  }
  // Every added pop counts once at its home point (ar) and once at its work point (aj).
  assert.equal(ar, addedTotal);
  assert.equal(aj, addedTotal);
  assert.ok(addedTotal > 0);

  // Decay: removals are attributed to BOTH endpoints of the removed pop.
  let rr = 0, rj = 0, removedTotal = 0;
  for (let day = 0; day < 400; day++) {
    const r = runDay(dd, noAccessSites(dd), led, cfg, makeRng(1000 + day), DAY_DEPS);
    removedTotal += r.removed;
    for (const d of Object.values(r.deltas)) { rr += d.rr; rj += d.rj; }
  }
  assert.equal(rr, removedTotal);
  assert.equal(rj, removedTotal);
  assert.ok(removedTotal > 0);
});

test('runDay deltas contain only touched points', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const r = runDay(dd, noAccessSites(dd), led, cfg, makeRng(7), DAY_DEPS); // no access → no growth anywhere
  assert.equal(r.added, 0);
  assert.deepEqual(r.deltas, {});
});

// --- Voronoi subdivision: the split step (spec 2026-07-18) -------------------

test('split: pressure accrues ∝ deficit × fill and splits at threshold', () => {
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  // Huge supported mass + full anchor → one day crosses a small threshold.
  const cfgFast = { ...DEFAULT_CONFIG, SPLIT_THRESHOLD: 1000, SPLIT_RATE: 1 };
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number] }]]);
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 1);
  const pid = 'induced-pt:0';
  assert.ok(dd.points.get(pid), 'point materialized at the cut');
  assert.deepEqual(dd.points.get(pid)!.location, [0.01, 0]);
  assert.ok(ledger.materialized?.[pid]);
  assert.equal(ledger.points[pid].baselineResidents, 0);
});

test('split: empty anchor (fill 0) never splits regardless of deficit', () => {
  const dd = makeDD([point('n1', 0, 0, 0, 0)]);
  dd.points.get('n1')!.residents = 0;
  dd.points.get('n1')!.jobs = 0;
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number] }]]);
  runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), {
    massAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(ledger.cells?.n1 ?? 0, 0);
});

test('split: budget caps splits per day, highest pressure first', () => {
  const pts = [point('a', 0, 0, 1000, 1000), point('b', 0.1, 0, 1000, 1000),
    point('c', 0.2, 0, 1000, 1000), point('d', 0.3, 0, 1000, 1000)];
  const dd = makeDD(pts);
  const ledger = newLedger();
  ledger.cells = { a: 999, b: 999, c: 999, d: 999 };
  const sites = pts.map((p) => siteOf(dd.points.get(p.id)!, 0.8));
  const cfgFast = { ...DEFAULT_CONFIG, SPLIT_THRESHOLD: 1000, MAX_SPLITS_PER_DAY: 2 };
  const cells = new Map(pts.map((p) => [p.id,
    { supportedMass: 1e6, centroid: [p.location[0] + 0.01, 0] as [number, number] }]));
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 2);
});

test('split: findCut null leaves pressure capped, no point', () => {
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cfgFast = { ...DEFAULT_CONFIG, SPLIT_THRESHOLD: 1000 };
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number] }]]);
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massAt: () => 2000, cells, findCut: () => null,
  });
  assert.equal(r.newPoints, 0);
  assert.equal(ledger.cells?.n1, 1000); // capped at threshold, retries later
});
