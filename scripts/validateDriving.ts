/**
 * Acceptance harness for the driving model — runs the REAL modules (not a prototype)
 * against the game's shipped city data and checks they reproduce its own numbers.
 *
 *   npx tsx scripts/validateDriving.ts [CITY ...]
 *
 * Passes when the median routed/real ratio for both distance and time sits inside
 * ±5% (see docs/superpowers/specs/2026-07-12-driving-model-design.md).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildRoadGraph, snapToNode, type RoadFeatureCollection } from '../src/model/roadGraph';
import { createRouter } from '../src/model/router';
import { calibrateSpeeds, type CalibrationPair } from '../src/model/speedFit';
import { buildDonorBands, createDrivingModel, bandIndexFor } from '../src/model/drivingModel';
import { haversine } from '../src/model/geo';
import type { Coordinate } from '../src/types/core';
import type { DemandData, DemandPoint, Pop } from '../src/types/game-state';

const TOLERANCE = 0.05;
const CITIES = process.argv.slice(2).length ? process.argv.slice(2) : ['DEN', 'NYC', 'SF'];
const dataDir = `${process.env.APPDATA}/metro-maker4/cities/data`;

const load = (city: string, file: string): unknown =>
  JSON.parse(gunzipSync(readFileSync(`${dataDir}/${city}/${file}.gz`)).toString('utf8'));

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function toDemandData(raw: { points: DemandPoint[]; pops: Pop[] }): DemandData {
  return {
    points: new Map(raw.points.map((p) => [p.id, { ...p, popIds: p.popIds ?? [] }])),
    popsMap: new Map(raw.pops.map((p) => [p.id, p])),
  };
}

let failed = false;

for (const city of CITIES) {
  let dd: DemandData;
  let roads: RoadFeatureCollection;
  try {
    dd = toDemandData(load(city, 'demand_data.json') as { points: DemandPoint[]; pops: Pop[] });
    roads = load(city, 'roads.geojson') as RoadFeatureCollection;
  } catch {
    console.log(`${city}: no local data, skipping`);
    continue;
  }

  const t0 = Date.now();
  const graph = buildRoadGraph(roads);
  const built = Date.now() - t0;

  // Calibrate exactly as main.ts does: native pops, sorted by id, capped at 300.
  const pairs: CalibrationPair[] = [...dd.popsMap.values()]
    .filter((p) => !p.id.startsWith('induced:') && p.drivingSeconds > 0
      && dd.points.has(p.residenceId) && dd.points.has(p.jobId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 300)
    .map((p) => ({
      residence: dd.points.get(p.residenceId)!.location,
      job: dd.points.get(p.jobId)!.location,
      seconds: p.drivingSeconds,
    }));
  const t1 = Date.now();
  const speeds = calibrateSpeeds(graph, pairs);
  const calibrated = Date.now() - t1;

  // Score on a DIFFERENT slice than we calibrated on — otherwise we are grading our
  // own homework.
  const holdout = [...dd.popsMap.values()]
    .filter((p) => p.drivingSeconds > 0 && dd.points.has(p.residenceId) && dd.points.has(p.jobId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(300, 900);

  const router = createRouter(graph, speeds);
  const distRatio: number[] = [];
  const timeRatio: number[] = [];
  const routedDetour: number[] = [];
  const realDetour: number[] = [];
  const legacyTimeRatio: number[] = [];
  let unroutable = 0;
  const t2 = Date.now();
  for (const p of holdout) {
    const res = dd.points.get(p.residenceId)!.location as Coordinate;
    const job = dd.points.get(p.jobId)!.location as Coordinate;
    const from = snapToNode(graph, res);
    const to = snapToNode(graph, job);
    const r = from && to ? router.route(from.node, to.node) : null;
    const straight = haversine(res, job);
    if (!r || !(r.seconds > 0)) { unroutable++; continue; }
    const distance = r.distance + from!.dist + to!.dist;
    distRatio.push(distance / p.drivingDistance);
    timeRatio.push(r.seconds / p.drivingSeconds);
    routedDetour.push(distance / straight);
    realDetour.push(p.drivingDistance / straight);
    legacyTimeRatio.push((straight * 1.3) / 11 / p.drivingSeconds); // the old flat model
  }
  const routedMs = (Date.now() - t2) / Math.max(1, distRatio.length);

  // The statistical tier must be sane too — it is the fallback for road-less cities.
  const donorModel = createDrivingModel({ donors: buildDonorBands(dd) });
  const donorRatio = holdout.slice(0, 200).map((p) => {
    const res = dd.points.get(p.residenceId)!.location as Coordinate;
    const job = dd.points.get(p.jobId)!.location as Coordinate;
    return donorModel.estimate(`induced:${p.id}`, p.residenceId, p.jobId, res, job).seconds / p.drivingSeconds;
  });

  const dMed = median(distRatio), tMed = median(timeRatio);
  const ok = Math.abs(dMed - 1) <= TOLERANCE && Math.abs(tMed - 1) <= TOLERANCE;
  failed ||= !ok;

  console.log(`\n=== ${city} ===`);
  console.log(`  graph ${graph.nodeCount} nodes / ${graph.edgeCount} edges in ${built} ms; `
    + `calibrated in ${calibrated} ms; ${routedMs.toFixed(1)} ms/route`);
  console.log(`  fitted speeds: highway ${speeds.highway.toFixed(1)}, major ${speeds.major.toFixed(1)}, `
    + `minor ${speeds.minor.toFixed(1)} m/s`);
  console.log(`  holdout ${distRatio.length} pops (${unroutable} unroutable, `
    + `${((unroutable / holdout.length) * 100).toFixed(1)}%)`);
  console.log(`  routed/real distance  median ${dMed.toFixed(3)}`);
  console.log(`  routed/real time      median ${tMed.toFixed(3)}`);
  console.log(`  detour  routed ${median(routedDetour).toFixed(3)}  vs real ${median(realDetour).toFixed(3)}`);
  console.log(`  donor tier time median ${median(donorRatio).toFixed(3)}   `
    + `| OLD flat model time median ${median(legacyTimeRatio).toFixed(3)}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} (tolerance ±${TOLERANCE * 100}%)`);
}

if (failed) {
  console.error('\nAcceptance FAILED: a city fell outside tolerance.');
  process.exit(1);
}
console.log('\nAll cities within tolerance.');
