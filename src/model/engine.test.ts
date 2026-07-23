import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDay, capDrawU, type RunDayDeps } from './engine';
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
  massResAt: () => 2000, massJobAt: () => 2000,
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

test('sub-pop headroom: a small point holds unmet demand honestly and never overshoots', () => {
  // 100 residents at K_MAX=1 → cap ≤ 200, so headroom ≤ 100: less than one
  // POP_SIZE, meaning the point can never legitimately take a 200-person pop.
  const dd = makeDD([point('S', 0, 0, 100, 0, 50, 0), point('J', 0, 0.001, 0, 100, 0, 50)]);
  const led = newLedger();
  captureBaselines(dd, led);
  const sites = [siteOf(dd.points.get('S')!), siteOf(dd.points.get('J')!)];
  for (let day = 0; day < 200; day++) runDay(dd, sites, led, cfg, makeRng(day), DAY_DEPS);
  // Never overshoots: no 200-person pop is jammed into ≤100 people of room.
  assert.equal(dd.points.get('S')!.residents, 100, 'residents unchanged — no room for a whole pop');
  assert.equal(dd.points.get('J')!.jobs, 100, 'jobs unchanged — no room for a whole pop');
  // Honest ledger: the accumulator holds the REAL unmet need (≤ headroom), not ACCUM_CAP.
  const e = led.points['S'];
  const maxHeadroom = 100 * cfg.K_MAX; // baseline × K_MAX × score, score ≤ 1
  assert.ok(e.resAccum <= maxHeadroom + 1e-6, `accum clamped to headroom, got ${e.resAccum}`);
  assert.ok(e.resAccum < cfg.ACCUM_CAP, 'does not balloon to ACCUM_CAP with phantom demand');
});

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

test('split: pressure (excess × fill) reaches TARGET_SPLIT_DAYS and splits', () => {
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  // Huge supported mass vs a small anchor cap → large excess; a full-ish anchor
  // (fill≈0.7) crosses even a 0.5-day target in one day.
  const cfgFast = { ...DEFAULT_CONFIG, TARGET_SPLIT_DAYS: 0.5 };
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number], pointCap: 2000 }]]);
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 1);
  const pid = 'induced-pt:0';
  assert.ok(dd.points.get(pid), 'point materialized at the cut');
  assert.deepEqual(dd.points.get(pid)!.location, [0.01, 0]);
  assert.ok(ledger.materialized?.[pid]);
  assert.equal(ledger.points[pid].baselineResidents, 0);
});

test('materialized point bootstraps: an empty split point accrues growth and gets a pop', () => {
  // A materialized point (residents/jobs 0) plus a native partner to pair with.
  const dd = makeDD([point('n1', 0, 0, 500, 500)]);
  const mat = point('induced-pt:0', 0.003, 0.003, 0, 0);
  dd.points.set(mat.id, mat);
  const ledger = newLedger();
  ledger.materialized = { 'induced-pt:0': { location: [0.003, 0.003] } };
  const sites = [siteOf(dd.points.get('n1')!, 0.8), siteOf(mat, 0.8)];
  // Run several days; without the bootstrap seed the empty point never grows.
  let gotPop = false;
  for (let day = 0; day < 60 && !gotPop; day++) {
    runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(day + 1), DAY_DEPS);
    gotPop = [...dd.popsMap.values()].some(
      (pp) => pp.residenceId === 'induced-pt:0' || pp.jobId === 'induced-pt:0',
    );
  }
  assert.ok(gotPop, 'the materialized point received a pop within 60 days');
  assert.ok((dd.points.get('induced-pt:0')!.residents + dd.points.get('induced-pt:0')!.jobs) > 0);
});

test('split: a larger cell accrues more split pressure per day than a smaller one', () => {
  // Two identical anchors (same cap, same fill), differing only in cell size
  // (supportedMass). One in-game day; assert the bigger cell built more pressure.
  const big = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const small = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const cells = (mass: number) =>
    new Map([['n1', { supportedMass: mass, centroid: [0.01, 0] as [number, number], pointCap: 2000 }]]);
  const run = (dd: ReturnType<typeof makeDD>, mass: number) => {
    const ledger = newLedger();
    // No split (findCut null) so the day's accrual stays in ledger.cells.
    runDay(dd, [siteOf(dd.points.get('n1')!, 0.8)], ledger, DEFAULT_CONFIG, makeRng(1), {
      massResAt: () => 2000, massJobAt: () => 2000, cells: cells(mass), findCut: () => null,
    });
    return ledger.cells?.n1 ?? 0;
  };
  const pBig = run(big, 1e6);
  const pSmall = run(small, 5000);
  assert.ok(pBig > pSmall, `big cell ${pBig} > small cell ${pSmall}`);
});

test('split: an empty anchor (fill 0) never accrues pressure regardless of deficit', () => {
  // Materialized point with a real cap (massAt) but zero current demand → fill 0.
  const dd = makeDD([point('n1', 0, 0, 0, 0)]);
  const ledger = newLedger();
  ledger.materialized = { n1: { location: [0, 0] } };
  ledger.points.n1 = { baselineResidents: 0, baselineJobs: 0, resAccum: 0, jobAccum: 0 };
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number], pointCap: 2000 }]]);
  runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(ledger.cells?.n1 ?? 0, 0);
});

test('split: a greenfield anchor (native baseline 0) splits on access alone', () => {
  // A NATIVE point with zero baseline — a station in undeveloped land. Its
  // native cap is 0, so it can never grow or (formerly) split; its high-access
  // territory sat inert. It must now split on access: measured vs pointCap with
  // the fill gate bypassed (nothing to densify first).
  const dd = makeDD([point('n1', 0, 0, 0, 0)]);
  const ledger = newLedger(); // NOT materialized — a native zero-demand point
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cfgFast = { ...DEFAULT_CONFIG, TARGET_SPLIT_DAYS: 0.5 };
  const cells = new Map([['n1',
    { supportedMass: 1e6, centroid: [0.01, 0] as [number, number], pointCap: 2000 }]]);
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 1, 'greenfield cell split on access');
  assert.ok(dd.points.get('induced-pt:0'), 'a point materialized in the empty land');
});

test('split: a right-sized cell is not ready despite a tiny anchor baseline', () => {
  // Low-baseline anchor whose cell supports only ~one point's worth of mass
  // (supportedMass == pointCap → area ≈ one spacing-cell, no room for another).
  // Measured against pointCap this reads excess 0 — not ready. (Against the tiny
  // baseline cap it read a huge false excess and pinned at max pressure forever,
  // a deep-purple cell that could never place a cut — the bug this fixes.)
  const dd = makeDD([point('n1', 0, 0, 10, 10)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cells = new Map([['n1',
    { supportedMass: 2000, centroid: [0.001, 0] as [number, number], pointCap: 2000 }]]);
  const r = runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 0);
  assert.equal(ledger.cells?.n1 ?? 0, 0); // no false pressure accrued
});

test('split: marginal excess decays instead of creeping to the threshold', () => {
  // excess·fill below SPLIT_PRESSURE_DECAY (1.0) → standing pressure must FALL,
  // so barely-over cells never slowly creep to the threshold and stick uncuttable.
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const ledger = newLedger();
  ledger.cells = { n1: 5 }; // some previously-accrued pressure
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  // supportedMass 3000 vs pointCap 2000 → excess 0.5; fill 2000/2800 ≈ 0.71 →
  // excess·fill ≈ 0.36, well under the 1.0 decay.
  const cells = new Map([['n1',
    { supportedMass: 3000, centroid: [0.001, 0] as [number, number], pointCap: 2000 }]]);
  const r = runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 0);
  assert.ok((ledger.cells?.n1 ?? 0) < 5, `marginal pressure decayed (got ${ledger.cells?.n1})`);
});

test('split: drains every placeable ready cell in one day (no daily cap)', () => {
  // Four cells ready and placeable. With no daily split cap, all four split the
  // same day instead of the old growth-coupled one-per-day starvation.
  const t = DEFAULT_CONFIG.TARGET_SPLIT_DAYS;
  const pts = [point('a', 0, 0, 1000, 1000), point('b', 0.1, 0, 1000, 1000),
    point('c', 0.2, 0, 1000, 1000), point('d', 0.3, 0, 1000, 1000)];
  const dd = makeDD(pts);
  const ledger = newLedger();
  ledger.cells = { a: t, b: t, c: t, d: t };
  const sites = pts.map((p) => siteOf(dd.points.get(p.id)!, 0.8));
  const cells = new Map(pts.map((p) => [p.id,
    { supportedMass: 1e6, centroid: [p.location[0] + 0.01, 0] as [number, number], pointCap: 2000 }]));
  const r = runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 4);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(ledger.cells?.[id], undefined);
});

test('split: an unplaceable top cell is skipped, not blocking a splittable one', () => {
  // Two ready cells at equal (max) pressure; budget floors to 1. The top by
  // id-tiebreak, 'a', can't place a cut (findCut null). It must be SKIPPED so
  // the day's one split lands on 'b' — a stuck cell can't starve the rest.
  const pts = [point('a', 0, 0, 1000, 1000), point('b', 0.1, 0, 1000, 1000)];
  const dd = makeDD(pts);
  const ledger = newLedger();
  ledger.cells = { a: 30, b: 30 };
  const sites = pts.map((p) => siteOf(dd.points.get(p.id)!, 0.8));
  const cells = new Map(pts.map((p) => [p.id,
    { supportedMass: 1e6, centroid: [p.location[0] + 0.01, 0] as [number, number], pointCap: 2000 }]));
  const r = runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: (id, c) => (id === 'a' ? null : c), // 'a' unplaceable
  });
  assert.equal(r.newPoints, 1);
  assert.equal(r.readyCells, 2);
  assert.equal(r.nullCuts, 1);
  assert.equal(ledger.cells?.a, DEFAULT_CONFIG.TARGET_SPLIT_DAYS); // 'a' stays capped, retries later
  assert.equal(ledger.cells?.b, undefined); // 'b' split
});

test('split: findCut null leaves pressure capped, no point', () => {
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cfgFast = { ...DEFAULT_CONFIG, TARGET_SPLIT_DAYS: 0.5 };
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number], pointCap: 2000 }]]);
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massResAt: () => 2000, massJobAt: () => 2000, cells, findCut: () => null,
  });
  assert.equal(r.newPoints, 0);
  assert.equal(ledger.cells?.n1, 0.5); // capped at the day target, retries later
});

test('capDrawU: higher access biases the cap draw toward the tail, stays in [0,1]', () => {
  const cfg = DEFAULT_CONFIG; // SPLIT_CAP_ACCESS_BIAS 0.5
  // Same id (same hash) → higher access yields a higher draw quantile.
  assert.ok(capDrawU(0.9, 'induced-pt:7#j', cfg) > capDrawU(0.1, 'induced-pt:7#j', cfg));
  // Always clamped to [0,1].
  for (const [a, id] of [[1, 'x'], [0, 'y'], [0.5, 'z']] as const) {
    const u = capDrawU(a, id, cfg);
    assert.ok(u >= 0 && u <= 1, `u=${u}`);
  }
  // Bias 0 → pure hash (access ignored); bias 1 → pure access.
  const b0 = { ...cfg, SPLIT_CAP_ACCESS_BIAS: 0 };
  assert.equal(capDrawU(0.9, 'q', b0), capDrawU(0.1, 'q', b0));
  const b1 = { ...cfg, SPLIT_CAP_ACCESS_BIAS: 1 };
  assert.equal(capDrawU(0.42, 'anything', b1), 0.42);
});
