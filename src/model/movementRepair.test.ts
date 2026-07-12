import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDanglingInducedMovementId, repairDanglingMovement } from './movementRepair';
import { newLedger } from './ledger';
import { DEFAULT_CONFIG } from './config';
import type { DemandData, DemandPoint } from '../types/game-state';

function point(id: string, residents: number, jobs: number): DemandPoint {
  return {
    id, location: [0, 0], residents, jobs, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

// The game logs `logger.error('[GameLoop] Tick error:', err)` for a movement whose
// pop id no longer resolves. Old mod builds hard-deleted retired pops, so existing
// saves can carry such movements; the console is the only place the id surfaces.

test('parseDanglingInducedMovementId extracts the id from string and Error args', () => {
  assert.equal(
    parseDanglingInducedMovementId(['[GameLoop] Tick error:', new Error('Pop not found for pop movement induced:4310')]),
    'induced:4310',
  );
  assert.equal(
    parseDanglingInducedMovementId(['Tick error: Error: Pop not found for pop movement induced:7']),
    'induced:7',
  );
});

test('parseDanglingInducedMovementId ignores unrelated errors and non-induced pops', () => {
  assert.equal(parseDanglingInducedMovementId(['Pop not found for pop movement base-12']), null);
  assert.equal(parseDanglingInducedMovementId([new Error('Train missed end at "X"')]), null);
  assert.equal(parseDanglingInducedMovementId([]), null);
});

test('repairDanglingMovement stubs the id demand-neutrally and tombstones it', () => {
  const dd: DemandData = {
    points: new Map([['p', point('p', 400, 100)]]),
    popsMap: new Map(),
  };
  const led = newLedger();
  const repaired = repairDanglingMovement(dd, led, 'induced:4310', DEFAULT_CONFIG);
  assert.equal(repaired, true);
  assert.ok(dd.popsMap.has('induced:4310'), 'stub lets the orphaned movement resolve');
  assert.equal(dd.points.get('p')!.residents, 400); // no demand added
  assert.ok(led.tombstones?.['induced:4310'], 'remembered so future loads re-stub it');
});

test('repairDanglingMovement is a no-op when the pop already exists', () => {
  const dd: DemandData = {
    points: new Map([['p', point('p', 400, 100)]]),
    popsMap: new Map([['induced:1', { id: 'induced:1', size: 200, residenceId: 'p', jobId: 'p' } as never]]),
  };
  const led = newLedger();
  assert.equal(repairDanglingMovement(dd, led, 'induced:1', DEFAULT_CONFIG), false);
  assert.equal(led.tombstones?.['induced:1'], undefined);
});
