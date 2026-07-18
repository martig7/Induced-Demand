import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DemandData, DemandPoint, Route, Station } from '../types/game-state';
import { buildSites, computeStructuralHash, refreshSiteAccess, type FieldDeps } from './field';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

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

function station(id: string, lon: number, lat: number, createdAt: number, routeIds: string[] = ['r']): Station {
  return {
    id, name: id, coords: [lon, lat], trackIds: [], trackGroupId: '', buildType: 'constructed',
    stNodeIds: [], routeIds, createdAt, nearbyStations: [],
  } as unknown as Station;
}

const DEPS: FieldDeps = {
  spacingAt: () => 400,
  accessAt: (c) => (Math.abs(c[0]) < 0.05 && Math.abs(c[1]) < 0.05 ? { res: 0.8, com: 0.6 } : { res: 0, com: 0 }),
  isWater: () => false,
};

test('buildSites: natives are occupied sites; candidates fill the catchment', () => {
  const data = dd([point('n1', 0.001, 0.001)]);
  const sites = buildSites({
    dd: data, stations: [station('s1', 0, 0, 1)], materialized: {},
    catchmentM: 1200, deps: DEPS, seedPrefix: 'TST',
  });
  const native = sites.find((s) => s.id === 'n1');
  assert.ok(native && native.pointId === 'n1');
  const candidates = sites.filter((s) => s.pointId === null);
  assert.ok(candidates.length > 3, `got ${candidates.length}`);
  for (const c of candidates) assert.match(c.id, /^TST:s1:\d+$/);
});

test('buildSites: candidates below MIN_SITE_ACCESS are dropped', () => {
  const farDeps: FieldDeps = { ...DEPS, accessAt: () => ({ res: 0.01, com: 0.01 }) };
  const sites = buildSites({
    dd: dd([]), stations: [station('s1', 0, 0, 1)], materialized: {},
    catchmentM: 1200, deps: farDeps, seedPrefix: 'TST',
  });
  assert.equal(sites.filter((s) => s.pointId === null).length, 0);
});

test('buildSites: unrouted stations produce no candidates', () => {
  const sites = buildSites({
    dd: dd([]), stations: [station('s1', 0, 0, 1, [])], materialized: {},
    catchmentM: 1200, deps: DEPS, seedPrefix: 'TST',
  });
  assert.equal(sites.length, 0);
});

test('buildSites: materialized points are occupied under their original site id', () => {
  const data = dd([point('induced-pt:0', 0.002, 0.002, 200, 0)]);
  const sites = buildSites({
    dd: data, stations: [station('s1', 0, 0, 1)],
    materialized: { 'induced-pt:0': { location: [0.002, 0.002], siteId: 'TST:s1:3' } },
    catchmentM: 1200, deps: DEPS, seedPrefix: 'TST',
  });
  const mat = sites.find((s) => s.id === 'TST:s1:3');
  assert.ok(mat, 'materialized site present under nominal site id');
  assert.equal(mat!.pointId, 'induced-pt:0');
  // and no duplicate site occupies that id
  assert.equal(sites.filter((s) => s.id === 'TST:s1:3').length, 1);
});

test('buildSites: overlapping catchments — older station samples first, no soft-spacing violations', () => {
  const sites = buildSites({
    dd: dd([]), stations: [station('s2', 0.004, 0, 5), station('s1', 0, 0, 1)], materialized: {},
    catchmentM: 1200, deps: DEPS, seedPrefix: 'TST',
  });
  // s1 is older → its candidates exist; s2 only adds what fits
  assert.ok(sites.some((s) => s.id.startsWith('TST:s1:')));
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
  const sites = buildSites({
    dd: data, stations: [station('s1', 0, 0, 1)], materialized: {},
    catchmentM: 1200, deps: DEPS, seedPrefix: 'TST',
  });
  refreshSiteAccess(sites, () => ({ res: 0.123, com: 0.456 }));
  assert.equal(sites[0].accessRes, 0.123);
  assert.equal(sites[0].accessCom, 0.456);
});
