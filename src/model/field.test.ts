import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DemandData, DemandPoint, Route } from '../types/game-state';
import { buildPointSites, computeStructuralHash, refreshSiteAccess } from './field';

function point(id: string, lon: number, lat: number, residents = 100, jobs = 100): DemandPoint {
  return {
    id, location: [lon, lat], residents, jobs, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

function dd(points: DemandPoint[]): DemandData {
  return { points: new Map(points.map((p) => [p.id, p])), popsMap: new Map() };
}

test('buildPointSites: one occupied site per demand point with cached access', () => {
  const data = dd([point('n1', 0.001, 0.001), point('n2', 0.5, 0.5)]);
  const sites = buildPointSites(data, (c) => (c[0] < 0.1 ? { res: 0.8, com: 0.6 } : { res: 0, com: 0 }));
  assert.equal(sites.length, 2);
  const s1 = sites.find((s) => s.id === 'n1')!;
  assert.equal(s1.pointId, 'n1');
  assert.equal(s1.accessRes, 0.8);
  assert.equal(sites.find((s) => s.id === 'n2')!.accessRes, 0);
});

test('computeStructuralHash: changes on route stops, stable on order', () => {
  const r = (id: string, stops: string[]): Route =>
    ({ id, stations: stops.map((sid) => ({ id: sid })) }) as unknown as Route;
  const h1 = computeStructuralHash([r('a', ['x', 'y']), r('b', ['z'])]);
  const h2 = computeStructuralHash([r('b', ['z']), r('a', ['x', 'y'])]);
  const h3 = computeStructuralHash([r('a', ['x', 'y', 'w']), r('b', ['z'])]);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('refreshSiteAccess: overwrites cached access from the deps', () => {
  const data = dd([point('n1', 0.001, 0.001)]);
  const sites = buildPointSites(data, () => ({ res: 0.8, com: 0.6 }));
  refreshSiteAccess(sites, () => ({ res: 0.123, com: 0.456 }));
  assert.equal(sites[0].accessRes, 0.123);
  assert.equal(sites[0].accessCom, 0.456);
});
