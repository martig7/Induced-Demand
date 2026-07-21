import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDump, type DumpFile } from './dump';
import { runSimulation } from './harness';
import { renderHtml } from './render';

/** Homes by station A, jobs by station B, A—B on one route ~1.1 km apart. */
function miniDump(): DumpFile {
  return {
    version: 1, city: 'Test',
    points: [
      { id: 'r', lon: 0, lat: 0, residents: 2000, jobs: 0 },
      { id: 'w', lon: 0.01, lat: 0, residents: 0, jobs: 2000 },
    ],
    stations: [
      { id: 'A', lon: 0, lat: 0, buildType: 'constructed', routeIds: ['r1'], stNodeIds: ['nA'], nearby: [] },
      { id: 'B', lon: 0.01, lat: 0, buildType: 'constructed', routeIds: ['r1'], stNodeIds: ['nB'], nearby: [] },
    ],
    routes: [{
      id: 'r1', stationIds: ['A', 'B'],
      stComboTimings: [
        { stNodeId: 'nA', stNodeIndex: 0, arrivalTime: 0, departureTime: 0 },
        { stNodeId: 'nB', stNodeIndex: 1, arrivalTime: 100, departureTime: 110 },
      ],
      trainSchedule: { highDemand: 4, mediumDemand: 1, lowDemand: 1 },
    }],
    groups: [],
  };
}

const total = (s: { points: { residents: number; jobs: number }[] }): number =>
  s.points.reduce((a, p) => a + p.residents + p.jobs, 0);

test('harness: runs the real engine headlessly and induces demand', () => {
  const result = runSimulation(parseDump(miniDump()), 20);
  assert.ok(total(result.after) > total(result.before),
    `demand grew ${total(result.before)} → ${total(result.after)}`);
  assert.equal(result.before.points.length, 2);
  assert.equal(result.days, 20);
});

test('harness: blueprint / routeless stations induce nothing (no access anywhere)', () => {
  const blueprint = miniDump();
  blueprint.stations.forEach((s) => { s.buildType = 'blueprint'; });
  assert.equal(total(runSimulation(parseDump(blueprint), 20).after),
    total(runSimulation(parseDump(blueprint), 0).before), 'unbuilt → no growth');

  const routeless = miniDump();
  routeless.stations.forEach((s) => { s.routeIds = []; });
  assert.equal(total(runSimulation(parseDump(routeless), 20).after),
    total(runSimulation(parseDump(routeless), 0).before), 'routeless → no growth');
});

test('render: produces a standalone before/after HTML document', () => {
  const html = renderHtml(runSimulation(parseDump(miniDump()), 10));
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Induced Demand simulation/);
  assert.match(html, /Before — day 0/);
  assert.match(html, /After — day 10/);
});
