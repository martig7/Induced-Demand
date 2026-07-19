import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newLedger, captureBaselines, reconcileBaselines, reconcileInducedPops, isPristineLedger,
  serializeForStore, deserializeFromStore, loadFromStore, saveToStore, applyPendingAccum,
  mergePendingRemovals, restoreTombstoneStubs, clearAllInduced, TOMBSTONE_CAP,
  queueInducedPopRemoval, retirePendingRemovals, recreateMaterializedPoints,
  type KVStore, type LedgerState,
} from './ledger';
import { DEFAULT_CONFIG } from './config';
import { deferInducedPopRemoval } from './popFactory';
import type { DemandData, DemandPoint, Pop } from '../types/game-state';

/** In-memory localStorage-shaped store for tests. */
function fakeStore(): KVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

function point(id: string, residents: number, jobs: number, popIds: string[] = []): DemandPoint {
  return {
    id, location: [0, 0], residents, jobs, popIds,
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

test('captureBaselines records new points once and does not overwrite', () => {
  const dd: DemandData = { points: new Map([['p', point('p', 400, 100)]]), popsMap: new Map() };
  const led = newLedger();
  captureBaselines(dd, led);
  led.points['p'].resAccum = 5;
  dd.points.get('p')!.residents = 999;
  captureBaselines(dd, led); // no-op for existing
  assert.equal(led.points['p'].baselineResidents, 400);
  assert.equal(led.points['p'].resAccum, 5);
});

test('serializeForStore persists seq + roster + nonzero accumulators; baselines re-derive on load', () => {
  const led = newLedger();
  led.seq = 7;
  led.points['p'] = { baselineResidents: 1, baselineJobs: 2, resAccum: 150, jobAccum: -30 };
  led.points['q'] = { baselineResidents: 5, baselineJobs: 6, resAccum: 0, jobAccum: 0 }; // no pressure → dropped
  led.pops['induced:1'] = { residenceId: 'p', jobId: 'q' };
  const back = deserializeFromStore(serializeForStore(led));
  assert.equal(back.seq, 7);
  assert.deepEqual(back.pops, { 'induced:1': { residenceId: 'p', jobId: 'q' } });
  assert.deepEqual(back.points, {});                    // baselines dropped — re-derived from live demand
  assert.deepEqual(back.pendingAccum, { p: [150, -30] }); // only the point with pressure is carried
});

test('applyPendingAccum restores pressure onto (re-baselined) points, then clears itself', () => {
  const back = deserializeFromStore(JSON.stringify({ seq: 1, pops: {}, accum: { p: [150, -30] } }));
  // reconcileBaselines would have created p with correct baselines and zero accumulators:
  back.points['p'] = { baselineResidents: 400, baselineJobs: 100, resAccum: 0, jobAccum: 0 };
  applyPendingAccum(back);
  assert.equal(back.points['p'].resAccum, 150);
  assert.equal(back.points['p'].jobAccum, -30);
  assert.equal(back.points['p'].baselineResidents, 400); // baseline untouched
  assert.equal(back.pendingAccum, undefined);            // consumed
});

test('applyPendingAccum skips vanished points and is a no-op with no pending data', () => {
  const led = newLedger();
  led.pendingAccum = { gone: [10, 20] };
  applyPendingAccum(led); // point 'gone' absent → skipped, no throw
  assert.equal(led.points['gone'], undefined);
  applyPendingAccum(newLedger()); // nothing pending → no-op
});

test('deserializeFromStore tolerates empty/garbage', () => {
  assert.deepEqual(deserializeFromStore(''), newLedger());
  assert.deepEqual(deserializeFromStore(null), newLedger());
  assert.deepEqual(deserializeFromStore('not json'), newLedger());
});

test('loadFromStore/saveToStore round-trip the roster through a localStorage-shaped store', () => {
  const store = fakeStore();
  const led = newLedger();
  led.seq = 3;
  led.pops['induced:2'] = { residenceId: 'a', jobId: 'b' };
  saveToStore(store, 'id:BOS', led);
  const back = loadFromStore(store, 'id:BOS');
  assert.equal(back.seq, 3);
  assert.deepEqual(back.pops, { 'induced:2': { residenceId: 'a', jobId: 'b' } });
});

test('loadFromStore returns a fresh ledger for a missing key', () => {
  assert.deepEqual(loadFromStore(fakeStore(), 'nope'), newLedger());
});

test('reconcileBaselines recovers baseline = current - induced', () => {
  const pop: Pop = { id: 'induced:1', size: 200, residenceId: 'p', jobId: 'p' } as Pop;
  const dd: DemandData = {
    points: new Map([['p', point('p', 600, 200, ['induced:1'])]]),
    popsMap: new Map([['induced:1', pop]]),
  };
  const led = newLedger();
  reconcileBaselines(dd, led);
  assert.equal(led.points['p'].baselineResidents, 400); // 600 - 200
  assert.equal(led.points['p'].baselineJobs, 0);        // 200 - 200
});

test('reconcileInducedPops restores tracked pops the save dropped', () => {
  // Prior session created induced:1 (residence p, job q) and persisted it in the
  // roster, but this reload lost it: popsMap is empty and residents/jobs are back
  // at baseline. The ledger point entries already exist (so reconcileBaselines is
  // a no-op) — this is the drained-accumulator desync that never self-heals today.
  const dd: DemandData = {
    points: new Map([
      ['p', point('p', 400, 100)],
      ['q', point('q', 100, 300)],
    ]),
    popsMap: new Map(),
  };
  const led: LedgerState = {
    points: {
      p: { baselineResidents: 400, baselineJobs: 100, resAccum: 0, jobAccum: 0 },
      q: { baselineResidents: 100, baselineJobs: 300, resAccum: 0, jobAccum: 0 },
    },
    pops: { 'induced:1': { residenceId: 'p', jobId: 'q' } },
    seq: 1,
  };

  const restored = reconcileInducedPops(dd, led, DEFAULT_CONFIG);

  assert.equal(restored, 1);
  assert.ok(dd.popsMap.has('induced:1'));
  assert.equal(dd.points.get('p')!.residents, 600); // 400 baseline + 200 induced
  assert.equal(dd.points.get('q')!.jobs, 500);       // 300 baseline + 200 induced
  assert.deepEqual(dd.points.get('p')!.popIds, ['induced:1']);
});

test('isPristineLedger is true only for a fully empty ledger', () => {
  assert.equal(isPristineLedger(newLedger()), true);
  const withPts = newLedger();
  withPts.points['p'] = { baselineResidents: 1, baselineJobs: 1, resAccum: 0, jobAccum: 0 };
  assert.equal(isPristineLedger(withPts), false); // baselines present → a real load, not a bug-window empty
  const withPop = newLedger();
  withPop.pops['induced:1'] = { residenceId: 'p', jobId: 'q' };
  assert.equal(isPristineLedger(withPop), false);
  const grown = newLedger();
  grown.seq = 5;
  assert.equal(isPristineLedger(grown), false);
});

test('reconcileInducedPops adopts present-but-untracked induced pops', () => {
  // Ledger was blank/lost but the save kept the pop — adopt it so a FUTURE loss
  // is recoverable.
  const pop: Pop = { id: 'induced:5', size: 200, residenceId: 'p', jobId: 'p' } as Pop;
  const dd: DemandData = {
    points: new Map([['p', point('p', 600, 200, ['induced:5'])]]),
    popsMap: new Map([['induced:5', pop]]),
  };
  const led = newLedger();
  const restored = reconcileInducedPops(dd, led, DEFAULT_CONFIG);
  assert.equal(restored, 0); // nothing missing to re-add
  assert.deepEqual(led.pops['induced:5'], { residenceId: 'p', jobId: 'p' });
});

test('reconcileInducedPops is a no-op when tracked pops are already present', () => {
  const pop: Pop = { id: 'induced:1', size: 200, residenceId: 'p', jobId: 'q' } as Pop;
  const dd: DemandData = {
    points: new Map([
      ['p', point('p', 600, 100, ['induced:1'])],
      ['q', point('q', 100, 500, ['induced:1'])],
    ]),
    popsMap: new Map([['induced:1', pop]]),
  };
  const led: LedgerState = {
    points: {}, pops: { 'induced:1': { residenceId: 'p', jobId: 'q' } }, seq: 1,
  };
  const restored = reconcileInducedPops(dd, led, DEFAULT_CONFIG);
  assert.equal(restored, 0);
  assert.equal(dd.points.get('p')!.residents, 600); // not double-counted
  assert.equal(dd.points.get('q')!.jobs, 500);
});

test('reconcileInducedPops prunes roster entries whose endpoints are gone', () => {
  const dd: DemandData = { points: new Map([['p', point('p', 400, 100)]]), popsMap: new Map() };
  const led = newLedger();
  led.pops['induced:9'] = { residenceId: 'gone', jobId: 'p' }; // residence point no longer exists
  const restored = reconcileInducedPops(dd, led, DEFAULT_CONFIG);
  assert.equal(restored, 0);
  assert.equal(led.pops['induced:9'], undefined); // stale entry dropped
});

test('serializeForStore persists pending decay removals', () => {
  const led = newLedger();
  queueInducedPopRemoval(led, 'induced:3');
  const back = deserializeFromStore(serializeForStore(led));
  assert.deepEqual(back.pendingRemovals, ['induced:3']);
});

test('mergePendingRemovals unions session and stored deferred queues', () => {
  const session = newLedger();
  session.pendingRemovals = ['induced:1', 'induced:2'];
  const stored = newLedger();
  stored.pendingRemovals = ['induced:2', 'induced:3'];
  assert.deepEqual(mergePendingRemovals(session, stored).pendingRemovals, [
    'induced:1', 'induced:2', 'induced:3',
  ]);
  assert.equal(mergePendingRemovals(session, newLedger()), session);
});

test('reconcileInducedPops does not re-adopt pops queued for removal', () => {
  const pop: Pop = { id: 'induced:5', size: 200, residenceId: 'p', jobId: 'p' } as Pop;
  const dd: DemandData = {
    points: new Map([['p', point('p', 600, 200, ['induced:5'])]]),
    popsMap: new Map([['induced:5', pop]]),
  };
  const led = newLedger();
  queueInducedPopRemoval(led, 'induced:5');
  reconcileInducedPops(dd, led, DEFAULT_CONFIG);
  assert.equal(led.pops['induced:5'], undefined);
});

// Retiring at load must NEVER delete from popsMap: the sim ticks before onGameLoaded
// reaches the mod and saves carry popMovementsMap, so a deleted pop can orphan a live
// movement — "[GameLoop] Tick error: Pop not found for pop movement induced:N" every
// tick, forever. Retired pops become demand-neutral tombstone stubs instead; the
// game's own save process strips them, and we re-stub on load while remembered.
test('retirePendingRemovals keeps the popsMap entry as a tombstone (never deletes)', () => {
  const pop: Pop = { id: 'induced:1', size: 200, residenceId: 'p', jobId: 'q' } as Pop;
  const dd: DemandData = {
    points: new Map([
      ['p', point('p', 600, 100, ['induced:1'])],
      ['q', point('q', 100, 500, ['induced:1'])],
    ]),
    popsMap: new Map([['induced:1', pop]]),
  };
  const led = newLedger();
  led.pops['induced:1'] = { residenceId: 'p', jobId: 'q' };
  deferInducedPopRemoval(dd, led, 'induced:1', DEFAULT_CONFIG);
  assert.equal(dd.points.get('p')!.residents, 400);
  assert.equal(dd.points.get('q')!.jobs, 300);

  const retired = retirePendingRemovals(dd, led, DEFAULT_CONFIG);
  assert.equal(retired, 1);
  assert.ok(dd.popsMap.has('induced:1'), 'stub must remain so in-flight movements resolve');
  assert.equal(dd.points.get('p')!.residents, 400); // demand not double-subtracted
  assert.equal(led.pendingRemovals, undefined);
  assert.equal(led.pops['induced:1'], undefined);
  assert.deepEqual(led.tombstones?.['induced:1'], { residenceId: 'p', jobId: 'q' });
});

test('retirePendingRemovals subtracts demand for a still-attached pop, once', () => {
  // Queued (e.g. merged from another session's queue) but never detached live.
  const pop: Pop = { id: 'induced:1', size: 200, residenceId: 'p', jobId: 'q' } as Pop;
  const dd: DemandData = {
    points: new Map([
      ['p', point('p', 600, 100, ['induced:1'])],
      ['q', point('q', 100, 500, ['induced:1'])],
    ]),
    popsMap: new Map([['induced:1', pop]]),
  };
  const led = newLedger();
  led.pops['induced:1'] = { residenceId: 'p', jobId: 'q' };
  queueInducedPopRemoval(led, 'induced:1');
  retirePendingRemovals(dd, led, DEFAULT_CONFIG);
  assert.equal(dd.points.get('p')!.residents, 400);
  assert.equal(dd.points.get('q')!.jobs, 300);
  assert.deepEqual(dd.points.get('p')!.popIds, []);
  assert.ok(dd.popsMap.has('induced:1'));
});

test('retirePendingRemovals re-stubs a pop the save stripped, without demand', () => {
  const dd: DemandData = {
    points: new Map([
      ['p', point('p', 400, 100)],
      ['q', point('q', 100, 300)],
    ]),
    popsMap: new Map(), // game strips induced pops from saves
  };
  const led = newLedger();
  led.pops['induced:1'] = { residenceId: 'p', jobId: 'q' };
  queueInducedPopRemoval(led, 'induced:1');
  retirePendingRemovals(dd, led, DEFAULT_CONFIG);
  assert.ok(dd.popsMap.has('induced:1'), 'stub satisfies saved movements referencing the id');
  assert.equal(dd.points.get('p')!.residents, 400); // stub adds no demand
  assert.deepEqual(dd.points.get('p')!.popIds, []);
  assert.ok(led.tombstones?.['induced:1']);
});

test('reconcileInducedPops stubs pending-removal ids instead of restoring their demand', () => {
  const dd: DemandData = {
    points: new Map([
      ['p', point('p', 400, 100)],
      ['q', point('q', 100, 300)],
    ]),
    popsMap: new Map(),
  };
  const led = newLedger();
  led.pops['induced:1'] = { residenceId: 'p', jobId: 'q' }; // decayed pop, queued
  queueInducedPopRemoval(led, 'induced:1');
  led.pops['induced:2'] = { residenceId: 'p', jobId: 'q' }; // live pop the save dropped
  const restored = reconcileInducedPops(dd, led, DEFAULT_CONFIG);
  assert.equal(restored, 1); // only the live pop counts as restored
  assert.equal(dd.points.get('p')!.residents, 600); // +200 for induced:2 only — no leak
  assert.ok(dd.popsMap.has('induced:1'), 'pending id stubbed so saved movements resolve');
  assert.ok(dd.popsMap.has('induced:2'));
  assert.equal(dd.points.get('p')!.popIds.includes('induced:1'), false);
});

test('restoreTombstoneStubs re-creates stubs each load and never adopts them back', () => {
  const dd: DemandData = {
    points: new Map([['p', point('p', 400, 100)], ['q', point('q', 100, 300)]]),
    popsMap: new Map(),
  };
  const led = newLedger();
  led.tombstones = { 'induced:7': { residenceId: 'p', jobId: 'q' } };
  restoreTombstoneStubs(dd, led, DEFAULT_CONFIG);
  assert.ok(dd.popsMap.has('induced:7'));
  assert.equal(dd.points.get('p')!.residents, 400);
  // A stub in popsMap must not be adopted into the roster as a live pop.
  reconcileInducedPops(dd, led, DEFAULT_CONFIG);
  assert.equal(led.pops['induced:7'], undefined);
});

test('reconcileBaselines ignores tombstone/pending stubs when deriving baselines', () => {
  const dd: DemandData = {
    points: new Map([['p', point('p', 400, 100)], ['q', point('q', 100, 300)]]),
    popsMap: new Map(),
  };
  const led = newLedger();
  led.tombstones = { 'induced:7': { residenceId: 'p', jobId: 'q' } };
  restoreTombstoneStubs(dd, led, DEFAULT_CONFIG);
  reconcileBaselines(dd, led);
  // Stub demand is NOT in residents, so baseline must equal current — not current − 200.
  assert.equal(led.points['p'].baselineResidents, 400);
});

test('tombstones round-trip through the store and are capped', () => {
  const led = newLedger();
  led.tombstones = {};
  for (let i = 0; i < TOMBSTONE_CAP + 25; i++) {
    led.tombstones[`induced:${i}`] = { residenceId: 'p', jobId: 'q' };
  }
  const back = deserializeFromStore(serializeForStore(led));
  const keys = Object.keys(back.tombstones ?? {});
  assert.equal(keys.length, TOMBSTONE_CAP);
  assert.equal(keys.includes('induced:0'), false); // oldest dropped
  assert.ok(keys.includes(`induced:${TOMBSTONE_CAP + 24}`)); // newest kept
});

test('clearAllInduced detaches every induced pop and resets the ledger, keeping tombstones', () => {
  const dd: DemandData = {
    points: new Map([
      ['p', point('p', 800, 100, ['induced:1', 'induced:2'])],
      ['q', point('q', 100, 700, ['induced:1', 'induced:2'])],
    ]),
    popsMap: new Map([
      ['induced:1', { id: 'induced:1', size: 200, residenceId: 'p', jobId: 'q' } as Pop],
      ['induced:2', { id: 'induced:2', size: 200, residenceId: 'p', jobId: 'q' } as Pop],
    ]),
  };
  const led = newLedger();
  led.seq = 3;
  led.pops['induced:1'] = { residenceId: 'p', jobId: 'q' };
  led.pops['induced:2'] = { residenceId: 'p', jobId: 'q' };
  const { removed, ledger: fresh } = clearAllInduced(dd, led, DEFAULT_CONFIG);
  assert.equal(removed, 2);
  assert.equal(dd.points.get('p')!.residents, 400);
  assert.equal(dd.points.get('q')!.jobs, 300);
  assert.ok(dd.popsMap.has('induced:1'), 'clear must not orphan in-flight movements either');
  assert.ok(dd.popsMap.has('induced:2'));
  assert.deepEqual(fresh.pops, {});
  assert.equal(fresh.seq, 3); // ids must never be reused while stubs exist
  assert.ok(fresh.tombstones?.['induced:1'] && fresh.tombstones?.['induced:2']);
});

test('saveToStore swallows quota/errors so a full store never crashes the mod', () => {
  const throwing: KVStore = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
  const led = newLedger();
  led.pops['induced:1'] = { residenceId: 'a', jobId: 'b' };
  saveToStore(throwing, 'id:BOS', led); // must not throw
});

test('reconcileInducedPops never adopts an inert (size-0) stub as a live pop', () => {
  // Storage-loss scenario: ledger blank (no tombstones either), but a session stub
  // is still in popsMap. Adopting it would resurrect the pop at full size later.
  const dd: DemandData = {
    points: new Map([['p', point('p', 400, 100)], ['q', point('q', 100, 300)]]),
    popsMap: new Map([['induced:3', { id: 'induced:3', size: 0, residenceId: 'p', jobId: 'q' } as Pop]]),
  };
  const led = newLedger();
  reconcileInducedPops(dd, led, DEFAULT_CONFIG);
  assert.equal(led.pops['induced:3'], undefined);
});

// --- access-field infill: ledger extensions -------------------------------

test('serialize/deserialize round-trips materialized and ptSeq', () => {
  const led = newLedger();
  led.materialized = { 'induced-pt:0': { location: [1, 2] } };
  led.ptSeq = 3;
  const back = deserializeFromStore(serializeForStore(led));
  assert.deepEqual(back.materialized, led.materialized);
  assert.equal(back.ptSeq, 3);
});

test('serialize: empty records are omitted; legacy sites/densify are dropped silently', () => {
  const led = newLedger();
  const payload = JSON.parse(serializeForStore(led));
  assert.equal(payload.materialized, undefined);
  assert.equal(payload.cells, undefined);
  // Legacy payloads (candidate-site build) carry sites/densify — dropped on read.
  const legacy = JSON.stringify({ seq: 3, pops: {}, accum: {}, sites: { x: [5, 0] }, densify: 1.2 });
  const revived = deserializeFromStore(legacy);
  assert.equal((revived as unknown as Record<string, unknown>).sites, undefined);
  assert.equal((revived as unknown as Record<string, unknown>).densify, undefined);
  assert.equal(revived.seq, 3);
});

test('recreateMaterializedPoints: recreates referenced, GCs husks with evidence of death', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.pops['induced:0'] = { residenceId: 'induced-pt:0', jobId: 'native1' };
  // induced-pt:1 lived and died: no roster pop, but a tombstone references it.
  led.tombstones = { 'induced:9': { residenceId: 'induced-pt:1', jobId: 'native1' } };
  led.materialized = {
    'induced-pt:0': { location: [1, 2], siteId: 's' },   // referenced by roster
    'induced-pt:1': { location: [3, 4], siteId: 't' },   // dead husk → GC
  };
  const r = recreateMaterializedPoints(dd, led);
  assert.equal(r.recreated, 1);
  assert.equal(r.dropped, 1);
  const p = dd.points.get('induced-pt:0');
  assert.ok(p);
  assert.equal(p!.residents, 0);
  assert.equal(p!.jobs, 0);
  assert.deepEqual(p!.location, [1, 2]);
  assert.equal(led.materialized!['induced-pt:1'], undefined);
});

test('recreateMaterializedPoints: a fresh split (no pops yet, no tombstones) survives reload', () => {
  // Splits create points EMPTY; a save/reload before the first pop lands must
  // not lose the split — the parent cell already spent its accrued split pressure on it.
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.materialized = { 'induced-pt:0': { location: [5, 6] } };
  const r = recreateMaterializedPoints(dd, led);
  assert.equal(r.recreated, 1);
  assert.equal(r.dropped, 0);
  assert.ok(dd.points.get('induced-pt:0'));
  assert.ok(led.materialized['induced-pt:0'], 'record kept');
});

test('recreateMaterializedPoints: existing points are left untouched', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.pops['induced:0'] = { residenceId: 'induced-pt:0', jobId: 'induced-pt:0' };
  led.materialized = { 'induced-pt:0': { location: [1, 2], siteId: 's' } };
  recreateMaterializedPoints(dd, led);
  const p = dd.points.get('induced-pt:0')!;
  p.residents = 999; // simulate later state
  const r2 = recreateMaterializedPoints(dd, led);
  assert.equal(r2.recreated, 0);
  assert.equal(dd.points.get('induced-pt:0')!.residents, 999);
});

test('composed load order: recreate -> baselines -> pops re-adds the pop without corrupting baselines', () => {
  // The real init() sequence: materialized points are recreated (empty), baselines
  // are derived from the husk (still empty), THEN the roster re-adds the pop's demand.
  // Order matters: baselines must be captured at 0 for the husked induced point and
  // at the native value for n1 BEFORE the pop re-add inflates their live counts.
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  dd.points.set('n1', point('n1', 500, 500));
  const led = newLedger();
  led.pops['induced:0'] = { residenceId: 'induced-pt:0', jobId: 'n1' };
  led.materialized = { 'induced-pt:0': { location: [1, 2], siteId: 's' } };

  recreateMaterializedPoints(dd, led); // husks induced-pt:0 at residents/jobs = 0
  reconcileBaselines(dd, led);         // baselines captured against the husk
  reconcileInducedPops(dd, led, DEFAULT_CONFIG); // re-adds induced:0 (+POP_SIZE each end)

  // Baselines for the induced point stay 0 — its live count is entirely induced.
  assert.equal(led.points['induced-pt:0'].baselineResidents, 0);
  assert.equal(led.points['induced-pt:0'].baselineJobs, 0);
  // The pop was re-added.
  assert.ok(dd.popsMap.has('induced:0'));
  // Live residents == the re-added pop's contribution, while baseline stayed 0.
  assert.equal(dd.points.get('induced-pt:0')!.residents, DEFAULT_CONFIG.POP_SIZE);
  // n1's baseline was captured (500) before the re-add; its jobs now include +POP_SIZE.
  assert.equal(led.points['n1'].baselineJobs, 500);
  assert.equal(dd.points.get('n1')!.jobs, 500 + DEFAULT_CONFIG.POP_SIZE);
});

test('clearAllInduced: drops materialized records, keeps ptSeq', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.ptSeq = 5;
  led.materialized = { 'induced-pt:0': { location: [1, 2] } };
  const { ledger: fresh } = clearAllInduced(dd, led, DEFAULT_CONFIG);
  assert.equal(fresh.ptSeq, 5);
  assert.equal(fresh.materialized, undefined);
});

// --- Voronoi subdivision: split-pressure cells -------------------------------

test('serialize round-trips cells sparsely (zeros pruned)', () => {
  const led = newLedger();
  led.cells = { 'induced-pt:0': 1200, n1: 0 };
  const back = deserializeFromStore(serializeForStore(led));
  assert.deepEqual(back.cells, { 'induced-pt:0': 1200 });
});

test('materialized records without siteId round-trip and recreate', () => {
  const led = newLedger();
  led.pops['induced:0'] = { residenceId: 'induced-pt:0', jobId: 'induced-pt:0' };
  led.materialized = { 'induced-pt:0': { location: [1, 2] } };
  const back = deserializeFromStore(serializeForStore(led));
  assert.deepEqual(back.materialized, led.materialized);
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const r = recreateMaterializedPoints(dd, back);
  assert.equal(r.recreated, 1);
  assert.deepEqual(dd.points.get('induced-pt:0')!.location, [1, 2]);
});

test('clearAllInduced drops cells', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.cells = { x: 500 };
  const { ledger: fresh } = clearAllInduced(dd, led, DEFAULT_CONFIG);
  assert.equal(fresh.cells, undefined);
});
