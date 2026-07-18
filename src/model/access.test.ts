import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAccessStations } from './access';

test('toAccessStations drops stations with empty routeIds', () => {
  const out = toAccessStations([
    { coords: [0, 0], routeIds: [] },
    { coords: [0, 0.001], routeIds: ['r1'] },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].lineIds, ['r1']);
});
