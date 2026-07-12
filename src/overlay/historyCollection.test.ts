import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryOverlay, HISTORY_ADDED, HISTORY_REMOVED } from './historyCollection';
import type { DayHistoryEntry } from '../model/history';
import type { DemandPoint } from '../types/game-state';

function point(id: string, lon: number): DemandPoint {
  return {
    id, location: [lon, 0], residents: 0, jobs: 0, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

const points = new Map<string, DemandPoint>([['p', point('p', 1)], ['q', point('q', 2)]]);

function entry(deltas: DayHistoryEntry['deltas']): DayHistoryEntry {
  return { day: 100, added: 0, removed: 0, deltas };
}

test('buildHistoryOverlay emits green adds and red removes, red first (green renders on top)', () => {
  const fc = buildHistoryOverlay(
    entry({ p: { ar: 3, aj: 0, rr: 1, rj: 0 } }),
    points,
    'combined',
  );
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0].properties.color, HISTORY_REMOVED);
  assert.equal(fc.features[0].properties.value, 1);
  assert.equal(fc.features[1].properties.color, HISTORY_ADDED);
  assert.equal(fc.features[1].properties.value, 3);
  assert.equal(fc.maxValue, 3);
  assert.equal(fc.features[1].properties.t, 1);        // normalized to the day's max
  assert.equal(fc.features[0].properties.t, 1 / 3);
});

test('buildHistoryOverlay filters by the metric toggle', () => {
  const deltas = { p: { ar: 2, aj: 5, rr: 0, rj: 0 } };
  assert.equal(buildHistoryOverlay(entry(deltas), points, 'residential').features[0].properties.value, 2);
  assert.equal(buildHistoryOverlay(entry(deltas), points, 'commercial').features[0].properties.value, 5);
  assert.equal(buildHistoryOverlay(entry(deltas), points, 'combined').features[0].properties.value, 7);
});

test('buildHistoryOverlay skips points missing from the live map and empty counts', () => {
  const fc = buildHistoryOverlay(
    entry({ gone: { ar: 4, aj: 0, rr: 0, rj: 0 }, q: { ar: 0, aj: 0, rr: 0, rj: 2 } }),
    points,
    'combined',
  );
  assert.equal(fc.features.length, 1); // 'gone' skipped; q has only a removal
  assert.equal(fc.features[0].properties.id, 'q');
  assert.equal(fc.features[0].properties.color, HISTORY_REMOVED);
});

test('buildHistoryOverlay of an empty day yields an empty collection', () => {
  const fc = buildHistoryOverlay(entry({}), points, 'combined');
  assert.deepEqual(fc.features, []);
  assert.equal(fc.maxValue, 0);
});
