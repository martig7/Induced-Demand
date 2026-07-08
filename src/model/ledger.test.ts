import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newLedger, captureBaselines, reconcileBaselines, reconcileInducedPops, isPristineLedger,
  serializeForStore, deserializeFromStore, loadFromStore, saveToStore, applyPendingAccum,
  type KVStore, type LedgerState,
} from './ledger';
import { DEFAULT_CONFIG } from './config';
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
