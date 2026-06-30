import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newLedger, captureBaselines, reconcileBaselines,
  serialize, deserialize, loadLedger, saveLedger, type ModStorage,
} from './ledger';
import type { DemandData, DemandPoint, Pop } from '../types/game-state';

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

test('serialize/deserialize round-trips', () => {
  const led = newLedger();
  led.points['p'] = { baselineResidents: 1, baselineJobs: 2, resAccum: 3, jobAccum: 4 };
  led.seq = 7;
  const back = deserialize(serialize(led));
  assert.deepEqual(back, led);
});

test('deserialize tolerates empty/garbage', () => {
  assert.deepEqual(deserialize(''), newLedger());
  assert.deepEqual(deserialize('not json'), newLedger());
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

test('loadLedger/saveLedger via a fake storage', async () => {
  const store = new Map<string, unknown>();
  const storage: ModStorage = {
    async get<T>(k: string, def?: T) { return (store.has(k) ? (store.get(k) as T) : (def as T)); },
    async set(k: string, v: unknown) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  };
  const led = newLedger();
  led.seq = 3;
  await saveLedger(storage, 'sea:save1', led);
  const back = await loadLedger(storage, 'sea:save1');
  assert.equal(back.seq, 3);
});
