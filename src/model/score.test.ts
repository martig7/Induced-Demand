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

// Access-dominant: score = access × (0.5 + 0.5 × transitFraction).
test('residentialScore = access × (FLOOR + (1−FLOOR)×resident transit fraction)', () => {
  // transit 50% -> factor 0.5 + 0.5*0.5 = 0.75; access 0.8 -> 0.6
  assert.ok(Math.abs(residentialScore(pt(50, 0), 0.8) - 0.6) < 1e-9);
});

test('commercialScore = access × (FLOOR + (1−FLOOR)×worker transit fraction)', () => {
  // transit 40% -> factor 0.5 + 0.5*0.4 = 0.7; access 0.5 -> 0.35
  assert.ok(Math.abs(commercialScore(pt(0, 40), 0.5) - 0.35) < 1e-9);
});

test('zero transit share still scores half its access (floor); full transit scores full access', () => {
  assert.ok(Math.abs(residentialScore(pt(0, 0), 0.8) - 0.4) < 1e-9);   // 0.8 × 0.5
  assert.ok(Math.abs(residentialScore(pt(100, 0), 0.8) - 0.8) < 1e-9); // 0.8 × 1.0
  assert.equal(residentialScore(pt(0, 0), 0), 0);                      // unserved stays 0
});
