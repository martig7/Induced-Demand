import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlockedRaster } from './blockedRaster';

const M = 111194.9; // metres per degree (equator frame — cos(0)=1, so cells are square)
const m = (metres: number): number => metres / M;

test('blockedRaster: fills a polygon; blockedWithin sees it over a disc but not the bare point', () => {
  // 1 km square centred on [0,0]; edges at ±500 m.
  const sq: [number, number][] = [[m(-500), m(-500)], [m(500), m(-500)], [m(500), m(500)], [m(-500), m(500)]];
  const r = buildBlockedRaster([[sq]], [m(-1500), m(-1500), m(1500), m(1500)], 50);
  assert.equal(r.blockedWithin([0, 0], 0), true, 'centre cell is filled');
  assert.equal(r.blockedWithin([m(1200), 0], 0), false, 'far outside is clear');
  // A point 700 m east: 200 m from the square's east edge (at 500 m).
  const p: [number, number] = [m(700), 0];
  assert.equal(r.blockedWithin(p, 0), false, 'the point itself is dry');
  assert.equal(r.blockedWithin(p, 100), false, 'no blocked cell within 100 m');
  assert.equal(r.blockedWithin(p, 250), true, 'blocked cell within 250 m');
});

test('blockedRaster: even-odd hole is not blocked', () => {
  const outer: [number, number][] = [[m(-1000), m(-1000)], [m(1000), m(-1000)], [m(1000), m(1000)], [m(-1000), m(1000)]];
  const hole: [number, number][] = [[m(-250), m(-250)], [m(250), m(-250)], [m(250), m(250)], [m(-250), m(250)]];
  const r = buildBlockedRaster([[outer, hole]], [m(-2000), m(-2000), m(2000), m(2000)], 50);
  assert.equal(r.blockedWithin([0, 0], 0), false, 'inside the hole → clear');
  assert.equal(r.blockedWithin([m(700), 0], 0), true, 'in the filled ring → blocked');
});

test('blockedRaster: empty polygon list → nothing blocked', () => {
  const r = buildBlockedRaster([], [0, 0, m(1000), m(1000)], 50);
  assert.equal(r.coverage, 0);
  assert.equal(r.blockedWithin([m(500), m(500)], 200), false);
});
