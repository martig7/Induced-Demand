import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitFraction, residentialScore, commercialScore } from './score';
import type { DemandPoint, ModeChoiceStats } from '../types/game-state';

const ms = (transit: number): ModeChoiceStats => ({
  walking: 0, driving: 100 - transit, transit, unknown: 0,
});

function pt(resTransit: number, workTransit: number): DemandPoint {
  return {
    id: 'p', location: [0, 0], jobs: 0, residents: 0, popIds: [],
    residentModeShare: ms(resTransit), workerModeShare: ms(workTransit),
  };
}

test('transitFraction: transit / total, guards divide-by-zero', () => {
  assert.equal(transitFraction(ms(25)), 0.25);
  assert.equal(transitFraction({ walking: 0, driving: 0, transit: 0, unknown: 0 }), 0);
});

test('residentialScore = resident transit fraction * access', () => {
  assert.ok(Math.abs(residentialScore(pt(50, 0), 0.8) - 0.4) < 1e-9);
});

test('commercialScore = worker transit fraction * access', () => {
  assert.ok(Math.abs(commercialScore(pt(0, 40), 0.5) - 0.2) < 1e-9);
});
