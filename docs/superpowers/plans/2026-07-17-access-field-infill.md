# Access-Field Infill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let induced demand create new demand points in empty high-access areas via a unified site field — one daily loop drives growth at existing points AND condensation of new points, with a heatmap overlay of the field.

**Architecture:** New pure modules (`stationGraph`, `opportunity`, `densityFit`, `sampler`, `field`, `waterIndex`, `perf`) feed a refactored `engine.runDay` that iterates *sites* (occupied + empty candidates) instead of `dd.points`. The ledger gains candidate-site accumulators, materialized-point records, and a densify multiplier; `main.ts` wires two recalculation tiers (debounced route hooks + day-end weight refresh with structural-hash promotion). Spec: `docs/superpowers/specs/2026-07-17-access-field-infill-design.md`.

**Tech Stack:** TypeScript (ESM, no deps), node:test via tsx, MapLibre GL via the game's modding API. Tests: `npm test` (all) or `npx tsx --test src/model/<file>.test.ts` (one file).

**Conventions:** Files use the existing style: `import type` for types, JSDoc on exports, tests colocated as `<file>.test.ts` with `node:test` + `assert/strict`. All geometry is `[lon, lat]` (`Coordinate` from `src/types/core`). All existing invariants (tombstones, live-endpoint pops, net-equal growth) must keep passing — the full suite runs at every task boundary.

---

### Task 1: Config, id prefixes, and typings groundwork

**Files:**
- Modify: `src/model/config.ts`
- Modify: `src/model/inducedId.ts`
- Modify: `src/types/game-state.d.ts` (Route/TrainSchedule)

- [ ] **Step 1: Extend `InducedDemandConfig`** — append to the interface in `src/model/config.ts` (keep every existing field; do NOT remove `CONNECTIVITY_REF` yet — old `access()` still uses it until Task 10):

```ts
  // --- Access v2 (reachability to opportunity) ---
  /** Decay scale (s) for network travel time in the opportunity sum. */
  TAU_REACH: number;
  /** Ride-speed fallback (m/s) when a route lacks stComboTimings. */
  NOMINAL_TRANSIT_SPEED: number;
  /** Cost (s) of an in-complex interchange (station groups). */
  INTERCHANGE_SECONDS: number;
  /** Boarding wait (s) when a route has no usable service data. */
  DEFAULT_WAIT_SECONDS: number;
  /** Floor (s) for the boarding wait. */
  MIN_WAIT_SECONDS: number;
  // --- Site sampling ---
  /** Min/max blue-noise spacing (m) between sites. */
  R_MIN: number;
  R_MAX: number;
  /** Max jitter radius as a fraction of local spacing; soft spacing = (1−J_FRAC)·r. */
  J_FRAC: number;
  /** Empty candidate sites below this max(accessRes, accessCom) are dropped. */
  MIN_SITE_ACCESS: number;
  // --- Density fit ---
  /** Access bins for the density fit. */
  FIT_BINS: number;
  /** Low quantile of nearest-neighbor distance per bin → spacing curve. */
  FIT_SPACING_QUANTILE: number;
  /** Upper quantile of per-point people mass per bin → mass curve. */
  FIT_MASS_QUANTILE: number;
  /** City-wide people-mass quantile that clamps the mass curve (envelope). */
  ENVELOPE_QUANTILE: number;
  // --- Empty-site caps ---
  /** Residential / job share of an empty site's access-derived mass cap. */
  RES_SHARE: number;
  JOB_SHARE: number;
  // --- Densification ---
  /** Daily ceiling-creep rate while saturated. */
  RHO_DENSIFY: number;
  /** Saturation (filled induced headroom fraction) above which densify creeps. */
  SAT_THRESHOLD: number;
```

And to `DEFAULT_CONFIG`:

```ts
  TAU_REACH: 900,
  NOMINAL_TRANSIT_SPEED: 15,
  INTERCHANGE_SECONDS: 45,
  DEFAULT_WAIT_SECONDS: 300,
  MIN_WAIT_SECONDS: 30,
  R_MIN: 150,
  R_MAX: 600,
  J_FRAC: 0.35,
  MIN_SITE_ACCESS: 0.05,
  FIT_BINS: 8,
  FIT_SPACING_QUANTILE: 0.25,
  FIT_MASS_QUANTILE: 0.8,
  ENVELOPE_QUANTILE: 0.95,
  RES_SHARE: 0.5,
  JOB_SHARE: 0.5,
  RHO_DENSIFY: 0.002,
  SAT_THRESHOLD: 0.8,
```

- [ ] **Step 2: Point-id identity** — append to `src/model/inducedId.ts`:

```ts
/**
 * Demand POINTS this mod materializes from candidate sites. Distinct prefix from
 * pops: `isInduced` (pop checks) must NOT match point ids and vice versa.
 */
export const INDUCED_POINT_PREFIX = 'induced-pt:';

export function isInducedPoint(pointId: string): boolean {
  return pointId.startsWith(INDUCED_POINT_PREFIX);
}
```

- [ ] **Step 3: Typings** — in `src/types/game-state.d.ts`, extend `TrainSchedule` and `Route`:

```ts
export interface TrainSchedule {
  highDemand: number;
  mediumDemand: number;
  lowDemand: number;
  /** @verified optional in the v1.4.10 bundle (`veryLowDemand ?? lowDemand`). */
  veryLowDemand?: number;
}

/**
 * Timetable scheduling mode. @verified against the build: routes with
 * `mode === 'timetable'` are costed via `periods[].headwaySeconds`
 * (`getMaxTimetableTrains` in the bundle); other fields exist but are unused here.
 */
export interface TimetableSchedule {
  mode: string;
  periods: { headwaySeconds: number }[];
}
```

and add to `Route` (after `trainSchedule?: TrainSchedule;`):

```ts
  /** @verified Present on timetable-mode routes; see {@link TimetableSchedule}. */
  timetableSchedule?: TimetableSchedule;
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; all existing tests PASS (no behavior changed).

- [ ] **Step 5: Commit**

```bash
git add src/model/config.ts src/model/inducedId.ts src/types/game-state.d.ts
git commit -m "feat: config, point-id prefix, schedule typings for access-field infill"
```

---

### Task 2: Perf tracker

**Files:**
- Create: `src/model/perf.ts`
- Test: `src/model/perf.test.ts`

- [ ] **Step 1: Write the failing test** (`src/model/perf.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPerfTracker } from './perf';

test('track: runs fn, records ms, logs summary line', () => {
  const logs: string[] = [];
  const warns: string[] = [];
  let t = 0;
  const perf = createPerfTracker((m) => logs.push(m), (m) => warns.push(m), () => (t += 5));
  const out = perf.track('fit', 100, () => 42, () => '6k pts');
  assert.equal(out, 42);
  assert.equal(perf.last.fit.ms, 5);
  assert.equal(perf.last.fit.info, '6k pts');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fit/);
  assert.match(logs[0], /5\.0ms/);
  assert.equal(warns.length, 0);
});

test('track: budget breach warns', () => {
  const warns: string[] = [];
  let t = 0;
  const perf = createPerfTracker(() => {}, (m) => warns.push(m), () => (t += 200));
  perf.track('tier1', 100, () => null);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /tier1/);
  assert.match(warns[0], /budget 100ms/);
});

test('track: fn throwing still records timing, rethrows', () => {
  let t = 0;
  const perf = createPerfTracker(() => {}, () => {}, () => (t += 3));
  assert.throws(() => perf.track('x', 100, () => { throw new Error('boom'); }));
  assert.equal(perf.last.x.ms, 3);
});

test('summary: compact one-liner of last runs', () => {
  let t = 0;
  const perf = createPerfTracker(() => {}, () => {}, () => (t += 2));
  perf.track('a', 100, () => 0);
  perf.track('b', 100, () => 0);
  assert.match(perf.summary(), /a 2\.0ms · b 2\.0ms/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/perf.test.ts`
Expected: FAIL — `Cannot find module './perf'`.

- [ ] **Step 3: Implement** (`src/model/perf.ts`):

```ts
/**
 * Always-on performance indicators (spec §10): every heavy phase is timed and
 * logged as one `[InducedDemand][perf]` line; exceeding its budget warns so
 * regressions surface during normal play. `now` injectable for tests.
 */
export interface PerfEntry { ms: number; info?: string }

export interface PerfTracker {
  /** Time `fn`, log `phase → ms (info)`, warn if over `budgetMs`. Rethrows errors. */
  track<T>(phase: string, budgetMs: number, fn: () => T, info?: (result: T) => string): T;
  /** Most recent timing per phase (for the toolbar panel). */
  last: Record<string, PerfEntry>;
  /** Compact "phase 1.2ms · phase 0.4ms" line of the last runs. */
  summary(): string;
}

export function createPerfTracker(
  log: (msg: string) => void,
  warn: (msg: string) => void,
  now: () => number = () => performance.now(),
): PerfTracker {
  const last: Record<string, PerfEntry> = {};
  const finish = (phase: string, budgetMs: number, start: number, info?: string): void => {
    const ms = now() - start;
    last[phase] = info === undefined ? { ms } : { ms, info };
    const line = `[InducedDemand][perf] ${phase} ${ms.toFixed(1)}ms${info ? ` (${info})` : ''}`;
    log(line);
    if (ms > budgetMs) warn(`${line} — over budget ${budgetMs}ms`);
  };
  return {
    last,
    track<T>(phase: string, budgetMs: number, fn: () => T, info?: (result: T) => string): T {
      const start = now();
      let result: T;
      try {
        result = fn();
      } catch (e) {
        finish(phase, budgetMs, start);
        throw e;
      }
      finish(phase, budgetMs, start, info?.(result));
      return result;
    },
    summary(): string {
      return Object.entries(last).map(([k, v]) => `${k} ${v.ms.toFixed(1)}ms`).join(' · ');
    },
  };
}

/** Spec §10 budgets (ms). */
export const PERF_BUDGETS = {
  tier1: 100,
  tier2: 15,
  day: 50,
  water: 500,
} as const;
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/perf.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/perf.ts src/model/perf.test.ts
git commit -m "feat: perf tracker with budgets and panel summary"
```

---

### Task 3: Water index

**Files:**
- Create: `src/game/waterIndex.ts`
- Test: `src/game/waterIndex.test.ts`

Format (verified on ATL's `ocean_depth_index.json.gz`): `{ cs, bbox: [w,s,e,n], grid: [cols,rows], cells: [[col,row,...polyIdx]], depths: [{ b: bbox, d: depth, p: [ring, ...] }] }`, lon/lat rings. Water test = grid cell lookup → even-odd point-in-polygon over that cell's polygons; no cell entry ⇒ land.

- [ ] **Step 1: Write the failing test** (`src/game/waterIndex.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterIndex, type OceanDepthFile } from './waterIndex';

/** 1°×1° world, 10×10 grid (cs=0.1). One square lake polygon covering [0.3..0.5]². */
const LAKE: OceanDepthFile = {
  cs: 0.1,
  bbox: [0, 0, 1, 1],
  grid: [10, 10],
  cells: [
    // lake spans grid cells cols 3-5, rows 3-5 (poly index 0)
    [3, 3, 0], [4, 3, 0], [5, 3, 0],
    [3, 4, 0], [4, 4, 0], [5, 4, 0],
    [3, 5, 0], [4, 5, 0], [5, 5, 0],
  ],
  depths: [{
    b: [0.3, 0.3, 0.5, 0.5],
    d: -4,
    p: [[[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5], [0.3, 0.3]]],
  }],
};

test('point inside the lake is water', () => {
  const idx = buildWaterIndex(LAKE);
  assert.equal(idx.isWater([0.4, 0.4]), true);
});

test('point on land (no cell entry) is not water', () => {
  const idx = buildWaterIndex(LAKE);
  assert.equal(idx.isWater([0.85, 0.85]), false);
});

test('point in a water-adjacent cell but outside the polygon is not water', () => {
  const idx = buildWaterIndex(LAKE);
  // cell (3,3) covers lon .3-.4 lat .3-.4 — but the polygon starts exactly at .3;
  // a point just outside the ring within the same cell must be dry:
  assert.equal(idx.isWater([0.30001, 0.29999]), false);
});

test('out-of-bbox points are not water', () => {
  const idx = buildWaterIndex(LAKE);
  assert.equal(idx.isWater([5, 5]), false);
  assert.equal(idx.isWater([-1, 0.5]), false);
});

test('polygon holes: a ring inside a ring is dry (even-odd)', () => {
  const donut: OceanDepthFile = {
    ...LAKE,
    depths: [{
      b: [0.3, 0.3, 0.5, 0.5],
      d: -4,
      p: [
        [[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5], [0.3, 0.3]],
        [[0.38, 0.38], [0.42, 0.38], [0.42, 0.42], [0.38, 0.42], [0.38, 0.38]], // island
      ],
    }],
  };
  const idx = buildWaterIndex(donut);
  assert.equal(idx.isWater([0.4, 0.4]), false); // on the island
  assert.equal(idx.isWater([0.34, 0.34]), true); // in the ring
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/game/waterIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/game/waterIndex.ts`):

```ts
/**
 * O(1) point-in-water test over the game's per-city `ocean_depth_index.json`
 * (spec §facts 3 — despite the name it covers lakes and rivers; verified on ATL).
 * Structure: a lon/lat grid (`cs` degrees per cell over `bbox`) where `cells`
 * lists only water-touching cells with the indices of the polygons they touch.
 * Test = cell lookup → even-odd point-in-polygon over that cell's few polygons.
 */
import type { Coordinate } from '../types/core';

export interface OceanDepthFile {
  cs: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** [cols, rows] */
  grid: [number, number];
  /** Each entry: [col, row, ...polygonIndices] */
  cells: number[][];
  depths: {
    b: [number, number, number, number];
    d: number;
    /** Rings of [lon, lat]; first ring outer, later rings holes (even-odd). */
    p: [number, number][][];
  }[];
}

export interface WaterIndex {
  isWater(c: Coordinate): boolean;
}

/** Even-odd rule across all rings of one polygon. */
function inPolygon(lon: number, lat: number, rings: [number, number][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export function buildWaterIndex(file: OceanDepthFile): WaterIndex {
  const cellPolys = new Map<number, number[]>();
  const [cols] = file.grid;
  for (const entry of file.cells) {
    const [col, row, ...polys] = entry;
    cellPolys.set(row * cols + col, polys);
  }
  const [west, south, east, north] = file.bbox;
  return {
    isWater([lon, lat]: Coordinate): boolean {
      if (lon < west || lon > east || lat < south || lat > north) return false;
      const col = Math.floor((lon - west) / file.cs);
      const row = Math.floor((lat - south) / file.cs);
      const polys = cellPolys.get(row * cols + col);
      if (!polys) return false;
      for (const pi of polys) {
        const d = file.depths[pi];
        if (!d) continue;
        const [bw, bs, be, bn] = d.b;
        if (lon < bw || lon > be || lat < bs || lat > bn) continue;
        if (inPolygon(lon, lat, d.p)) return true;
      }
      return false;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/game/waterIndex.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/waterIndex.ts src/game/waterIndex.test.ts
git commit -m "feat: O(1) water test over the city ocean-depth index"
```

---

### Task 4: Station graph with real weights

**Files:**
- Create: `src/model/stationGraph.ts`
- Test: `src/model/stationGraph.test.ts`

Model (spec §2): route-aware nodes. Per station a **street** node; per (route, stop) a **platform** node. Edges: street→platform = boarding wait; platform→street = 0; platform↔platform (consecutive stops, both directions) = ride seconds from `stComboTimings` (fallback distance ÷ `NOMINAL_TRANSIT_SPEED`); street↔street = `nearbyStations` walk seconds; same interchange group = `INTERCHANGE_SECONDS`. Wait per route: timetable mode → min `periods[].headwaySeconds`/2; else cycle ÷ max(`trainSchedule` counts, `idealTrainCount`)/2; clamp ≥ `MIN_WAIT_SECONDS`; no data → `DEFAULT_WAIT_SECONDS`. Temp routes (`tempParentId != null`) are skipped.

- [ ] **Step 1: Write the failing test** (`src/model/stationGraph.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Route, Station, StationGroup } from '../types/game-state';
import { buildStationGraph, peakWaitSeconds, routeRideSeconds } from './stationGraph';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

/** Minimal Station: only fields the graph uses. */
function station(id: string, lon: number, lat: number, routeIds: string[], stNodeIds: string[],
  nearby: { stationId: string; walkingTime: number }[] = []): Station {
  return {
    id, name: id, coords: [lon, lat], trackIds: [], trackGroupId: '', buildType: 'constructed',
    stNodeIds, routeIds, createdAt: 0, nearbyStations: nearby,
  } as unknown as Station;
}

const A = station('A', 0, 0, ['r1'], ['nA']);
const B = station('B', 0.01, 0, ['r1'], ['nB']);
const C = station('C', 0.02, 0, ['r1'], ['nC']);

/** r1: A→B→C with timings; 120 s cycle; 2 peak trains. */
const r1 = {
  id: 'r1',
  stations: [A, B, C],
  stComboTimings: [
    { stNodeId: 'nA', stNodeIndex: 0, arrivalTime: 0, departureTime: 10 },
    { stNodeId: 'nB', stNodeIndex: 1, arrivalTime: 60, departureTime: 70 },
    { stNodeId: 'nC', stNodeIndex: 2, arrivalTime: 120, departureTime: 130 },
  ],
  trainSchedule: { highDemand: 2, mediumDemand: 1, lowDemand: 1 },
} as unknown as Route;

test('peakWaitSeconds: legacy counts → cycle/peak/2', () => {
  // cycle 120, peak 2 → headway 60 → wait 30
  assert.equal(peakWaitSeconds(r1, 120, cfg), 30);
});

test('peakWaitSeconds: timetable mode wins, min headway across periods', () => {
  const tt = {
    ...r1,
    timetableSchedule: { mode: 'timetable', periods: [{ headwaySeconds: 600 }, { headwaySeconds: 240 }] },
  } as unknown as Route;
  assert.equal(peakWaitSeconds(tt, 120, cfg), 120); // 240/2
});

test('peakWaitSeconds: no service data → DEFAULT_WAIT_SECONDS', () => {
  const bare = { id: 'x', stations: [A, B] } as unknown as Route;
  assert.equal(peakWaitSeconds(bare, 0, cfg), cfg.DEFAULT_WAIT_SECONDS);
});

test('routeRideSeconds: from timings (arrival(b) − departure(a))', () => {
  const rides = routeRideSeconds(r1, [A, B, C], cfg);
  assert.deepEqual(rides, [50, 50]); // 60-10, 120-70
});

test('routeRideSeconds: missing timings → distance/NOMINAL_TRANSIT_SPEED', () => {
  const bare = { id: 'x', stations: [A, B] } as unknown as Route;
  const rides = routeRideSeconds(bare, [A, B], cfg);
  assert.equal(rides.length, 1);
  // ~1113 m / 15 m/s ≈ 74 s
  assert.ok(rides[0] > 60 && rides[0] < 90, `got ${rides[0]}`);
});

test('buildStationGraph: ride path costs wait + rides', () => {
  const g = buildStationGraph([r1], [A, B, C], [], cfg);
  assert.equal(g.stationIds.length, 3);
  // street(A) → platform(A,r1) edge exists with boarding wait 30
  const streetA = g.streetIndex.get('A')!;
  const boarding = g.adj[streetA].find((e) => e.s === 30);
  assert.ok(boarding, 'boarding edge with wait 30');
});

test('buildStationGraph: temp routes are skipped', () => {
  const temp = { ...r1, id: 't', tempParentId: 'r1' } as unknown as Route;
  const g = buildStationGraph([temp], [A, B, C], [], cfg);
  // only street nodes + walk edges, no platforms
  assert.equal(g.nodeCount, 3);
});

test('buildStationGraph: interchange group links streets cheaply', () => {
  const groups = [{ id: 'g', stationIds: ['A', 'B'] }] as StationGroup[];
  const g = buildStationGraph([], [A, B], groups, cfg);
  const streetA = g.streetIndex.get('A')!;
  const link = g.adj[streetA].find((e) => e.to === g.streetIndex.get('B') && e.s === cfg.INTERCHANGE_SECONDS);
  assert.ok(link);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/stationGraph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/model/stationGraph.ts`):

```ts
/**
 * Transit-network graph with REAL weights from the modding API (spec §2, §facts 4).
 * Route-aware nodes so boarding wait is paid once per boarding, not per segment:
 * a street node per station, a platform node per (route, stop).
 *
 * Weights: ride = stComboTimings deltas (fallback distance ÷ NOMINAL_TRANSIT_SPEED);
 * boarding = peak-service headway/2 from route-intrinsic schedule data — NEVER
 * getTrains(), which samples the current demand period (spec §facts 4);
 * transfer = the game's own nearbyStations walk times; interchange = constant.
 */
import type { Coordinate } from '../types/core';
import type { Route, Station, StationGroup } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

export interface GraphEdge { to: number; s: number }

export interface StationGraph {
  /** Street-node i ↔ stationIds[i]; platforms are nodes ≥ stationIds.length. */
  stationIds: string[];
  coords: Coordinate[];
  streetIndex: Map<string, number>;
  nodeCount: number;
  adj: GraphEdge[][];
}

/** Cycle time exactly as the game's getRouteCycleTime: last timing arrival. */
export function routeCycleSeconds(route: Route): number {
  const t = route.stComboTimings;
  return t && t.length > 0 ? t[t.length - 1].arrivalTime : 0;
}

/**
 * Peak boarding wait for a route (seconds). Timetable mode → min headway/2;
 * legacy trainSchedule counts (they ARE counts — decompile-verified) →
 * (cycle ÷ peak trains)/2; no data → DEFAULT_WAIT_SECONDS.
 */
export function peakWaitSeconds(route: Route, cycleSeconds: number, cfg: InducedDemandConfig): number {
  const clamp = (w: number): number => Math.max(cfg.MIN_WAIT_SECONDS, w);
  const tt = route.timetableSchedule;
  if (tt?.mode === 'timetable' && tt.periods?.length) {
    const headways = tt.periods.map((p) => p.headwaySeconds).filter((h) => h > 0);
    if (headways.length > 0) return clamp(Math.min(...headways) / 2);
  }
  const ts = route.trainSchedule;
  const counts = [
    ts?.highDemand ?? 0, ts?.mediumDemand ?? 0, ts?.lowDemand ?? 0,
    ts?.veryLowDemand ?? 0, route.idealTrainCount ?? 0,
  ];
  const peak = Math.max(...counts);
  if (peak > 0 && cycleSeconds > 0) return clamp(cycleSeconds / peak / 2);
  return cfg.DEFAULT_WAIT_SECONDS;
}

/**
 * Ride seconds between consecutive stops. Matches each stop's timing entry via
 * `stNodeId ∈ station.stNodeIds`; if any stop lacks a timing, the whole route
 * falls back to distance ÷ NOMINAL_TRANSIT_SPEED (structure unchanged).
 */
export function routeRideSeconds(
  route: Route,
  stops: Station[],
  cfg: InducedDemandConfig,
): number[] {
  const timings = route.stComboTimings ?? [];
  const perStop = stops.map((st) => timings.find((t) => st.stNodeIds.includes(t.stNodeId)));
  const rides: number[] = [];
  const usable = perStop.every((t) => t !== undefined);
  for (let i = 0; i + 1 < stops.length; i++) {
    if (usable) {
      const ride = perStop[i + 1]!.arrivalTime - perStop[i]!.departureTime;
      rides.push(Math.max(15, ride));
    } else {
      rides.push(haversine(stops[i].coords, stops[i + 1].coords) / cfg.NOMINAL_TRANSIT_SPEED);
    }
  }
  return rides;
}

export function buildStationGraph(
  routes: Route[],
  stations: Station[],
  groups: StationGroup[],
  cfg: InducedDemandConfig,
): StationGraph {
  const stationIds = stations.map((s) => s.id);
  const coords = stations.map((s) => s.coords);
  const streetIndex = new Map(stationIds.map((id, i) => [id, i]));
  const adj: GraphEdge[][] = stationIds.map(() => []);
  let nodeCount = stationIds.length;
  const addNode = (): number => { adj.push([]); return nodeCount++; };
  const edge = (a: number, b: number, s: number): void => { adj[a].push({ to: b, s }); };

  // Ride + boarding edges per live route.
  for (const route of routes) {
    if (route.tempParentId != null) continue;
    const stops = (route.stations ?? []).filter((s) => streetIndex.has(s.id));
    if (stops.length < 2) continue;
    const wait = peakWaitSeconds(route, routeCycleSeconds(route), cfg);
    const rides = routeRideSeconds(route, stops, cfg);
    const platforms = stops.map((st) => {
      const p = addNode();
      const street = streetIndex.get(st.id)!;
      edge(street, p, wait); // board
      edge(p, street, 0);    // alight
      return p;
    });
    for (let i = 0; i + 1 < platforms.length; i++) {
      edge(platforms[i], platforms[i + 1], rides[i]);
      edge(platforms[i + 1], platforms[i], rides[i]); // service assumed bidirectional
    }
  }

  // Transfer walks (the game's own nearbyStations basis).
  for (const st of stations) {
    const a = streetIndex.get(st.id)!;
    for (const nb of st.nearbyStations ?? []) {
      const b = streetIndex.get(nb.stationId);
      if (b !== undefined && b !== a) edge(a, b, nb.walkingTime);
    }
  }

  // Interchange groups: same complex, cheap fixed transfer.
  for (const g of groups) {
    for (const idA of g.stationIds) {
      for (const idB of g.stationIds) {
        if (idA === idB) continue;
        const a = streetIndex.get(idA);
        const b = streetIndex.get(idB);
        if (a !== undefined && b !== undefined) edge(a, b, cfg.INTERCHANGE_SECONDS);
      }
    }
  }

  return { stationIds, coords, streetIndex, nodeCount, adj };
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/stationGraph.test.ts`
Expected: 8 PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — all PASS.

```bash
git add src/model/stationGraph.ts src/model/stationGraph.test.ts
git commit -m "feat: route-aware station graph with schedule-derived weights"
```

---

### Task 5: Opportunity + directional access v2

**Files:**
- Create: `src/model/opportunity.ts`
- Test: `src/model/opportunity.test.ts`

Directional (spec §2): residential access weighs reachable **jobs** mass; commercial access weighs reachable **residents** mass. Per station: Dijkstra from its street node, `O = Σ mass(t)·exp(−time/TAU_REACH)`, normalized by city totals. Per location: `max over in-catchment stations of walkProx·(FLOOR + (1−FLOOR)·Ô)` (multi-station generalization of the spec's "nearest station").

- [ ] **Step 1: Write the failing test** (`src/model/opportunity.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Route, Station } from '../types/game-state';
import type { DemandPoint } from '../types/game-state';
import { buildStationGraph } from './stationGraph';
import {
  dijkstraStreetTimes, stationMasses, computeOpportunities, accessAt,
} from './opportunity';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

function station(id: string, lon: number, lat: number, routeIds: string[], stNodeIds: string[]): Station {
  return {
    id, name: id, coords: [lon, lat], trackIds: [], trackGroupId: '', buildType: 'constructed',
    stNodeIds, routeIds, createdAt: 0, nearbyStations: [],
  } as unknown as Station;
}

function point(id: string, lon: number, lat: number, residents: number, jobs: number): DemandPoint {
  return {
    id, location: [lon, lat], residents, jobs, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

// A —(r1: 100 s)— B. Jobs concentrated at B, residents at A.
const A = station('A', 0, 0, ['r1'], ['nA']);
const B = station('B', 0.05, 0, ['r1'], ['nB']);
const r1 = {
  id: 'r1',
  stations: [A, B],
  stComboTimings: [
    { stNodeId: 'nA', stNodeIndex: 0, arrivalTime: 0, departureTime: 0 },
    { stNodeId: 'nB', stNodeIndex: 1, arrivalTime: 100, departureTime: 110 },
  ],
  trainSchedule: { highDemand: 4, mediumDemand: 1, lowDemand: 1 },
} as unknown as Route;

const pts = [
  point('p1', 0.0005, 0, 5000, 0),   // residents at A
  point('p2', 0.0505, 0, 0, 5000),   // jobs at B
];

test('dijkstraStreetTimes: reaches the other street via wait+ride', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const t = dijkstraStreetTimes(g, g.streetIndex.get('A')!);
  assert.equal(t[g.streetIndex.get('A')!], 0);
  // wait 100/4/2=12.5 → clamped to MIN_WAIT 30; ride 100 → 130
  assert.ok(Math.abs(t[g.streetIndex.get('B')!] - 130) < 1e-9, `got ${t[g.streetIndex.get('B')!]}`);
});

test('stationMasses: sums residents/jobs within catchment', () => {
  const m = stationMasses([A, B], pts, cfg);
  assert.equal(m.get('A')!.res, 5000);
  assert.equal(m.get('A')!.jobs, 0);
  assert.equal(m.get('B')!.jobs, 5000);
});

test('computeOpportunities: A sees jobs through the network, B sees residents', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const opps = computeOpportunities(g, stationMasses([A, B], pts, cfg), cfg);
  const oA = opps.find((o) => o.stationId === 'A')!;
  const oB = opps.find((o) => o.stationId === 'B')!;
  assert.ok(oA.oJobs > 0.5, `A reaches the job mass (got ${oA.oJobs})`);
  assert.ok(oB.oRes > 0.5, `B reaches the resident mass (got ${oB.oRes})`);
  // A has no local jobs: its jobs-opportunity is purely network-decayed, so < B's local-ish view
  assert.ok(oA.oJobs < oB.oJobs + 1e-9);
});

test('accessAt: directional — near A, res access (to jobs) beats com access', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const opps = computeOpportunities(g, stationMasses([A, B], pts, cfg), cfg);
  const acc = accessAt([0.0002, 0], opps, cfg);
  assert.ok(acc.res > acc.com, `res ${acc.res} com ${acc.com}`);
  assert.ok(acc.res > 0 && acc.res <= 1);
});

test('accessAt: out of catchment → zero', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const opps = computeOpportunities(g, stationMasses([A, B], pts, cfg), cfg);
  assert.deepEqual(accessAt([2, 2], opps, cfg), { res: 0, com: 0 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/opportunity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/model/opportunity.ts`):

```ts
/**
 * Reachability-to-opportunity (spec §2). Per station: Dijkstra over the
 * stationGraph, then O_jobs/O_res = Σ reachable mass × exp(−t/TAU_REACH),
 * normalized by city totals. Per location: walk proximity × opportunity of the
 * best in-catchment station, directional (residences value reachable JOBS,
 * job sites value reachable RESIDENTS — mirroring gravity pairing).
 * Recomputed on network change / day end only; per-site lookups are O(stations).
 */
import type { Coordinate } from '../types/core';
import type { DemandPoint, Station } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import type { StationGraph } from './stationGraph';
import { haversine, walkSeconds } from './geo';

/** Binary-heap Dijkstra; returns seconds from `sourceStreet` to every street node. */
export function dijkstraStreetTimes(g: StationGraph, sourceStreet: number): Float64Array {
  const dist = new Float64Array(g.nodeCount).fill(Infinity);
  dist[sourceStreet] = 0;
  // [dist, node] pairs in a simple binary min-heap.
  const heap: [number, number][] = [[0, sourceStreet]];
  const push = (d: number, n: number): void => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [d, n] = pop()!;
    if (d > dist[n]) continue;
    for (const e of g.adj[n]) {
      const nd = d + e.s;
      if (nd < dist[e.to]) { dist[e.to] = nd; push(nd, e.to); }
    }
  }
  return dist.slice(0, g.stationIds.length);
}

export interface StationMass { res: number; jobs: number }

/** Residents/jobs mass within each station's walk catchment (grid-indexed). */
export function stationMasses(
  stations: Station[],
  points: Iterable<DemandPoint>,
  cfg: InducedDemandConfig,
): Map<string, StationMass> {
  const radiusM = cfg.CATCHMENT_SECONDS * cfg.WALK_SPEED;
  const cell = radiusM; // 1-cell ring covers the radius
  const grid = new Map<string, DemandPoint[]>();
  const keyOf = (lon: number, lat: number): string =>
    `${Math.floor((lon * 111320) / cell)},${Math.floor((lat * 110540) / cell)}`;
  for (const p of points) {
    const k = keyOf(p.location[0], p.location[1]);
    const bucket = grid.get(k);
    if (bucket) bucket.push(p); else grid.set(k, [p]);
  }
  const out = new Map<string, StationMass>();
  for (const st of stations) {
    let res = 0, jobs = 0;
    const [lon, lat] = st.coords;
    const cx = Math.floor((lon * 111320) / cell);
    const cy = Math.floor((lat * 110540) / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (haversine(st.coords, p.location) <= radiusM) { res += p.residents; jobs += p.jobs; }
        }
      }
    }
    out.set(st.id, { res, jobs });
  }
  return out;
}

export interface StationOpportunity {
  stationId: string;
  coords: Coordinate;
  /** Normalized reachable-jobs mass in [0,1] — feeds RESIDENTIAL access. */
  oJobs: number;
  /** Normalized reachable-residents mass in [0,1] — feeds COMMERCIAL access. */
  oRes: number;
}

export function computeOpportunities(
  g: StationGraph,
  masses: Map<string, StationMass>,
  cfg: InducedDemandConfig,
): StationOpportunity[] {
  let totalRes = 0, totalJobs = 0;
  for (const m of masses.values()) { totalRes += m.res; totalJobs += m.jobs; }
  const out: StationOpportunity[] = [];
  for (let i = 0; i < g.stationIds.length; i++) {
    const t = dijkstraStreetTimes(g, i);
    let oJobs = 0, oRes = 0;
    for (let j = 0; j < g.stationIds.length; j++) {
      if (!Number.isFinite(t[j])) continue;
      const m = masses.get(g.stationIds[j]);
      if (!m) continue;
      const decay = Math.exp(-t[j] / cfg.TAU_REACH);
      oJobs += m.jobs * decay;
      oRes += m.res * decay;
    }
    out.push({
      stationId: g.stationIds[i],
      coords: g.coords[i],
      oJobs: totalJobs > 0 ? Math.min(1, oJobs / totalJobs) : 0,
      oRes: totalRes > 0 ? Math.min(1, oRes / totalRes) : 0,
    });
  }
  return out;
}

export interface DirectionalAccess { res: number; com: number }

/**
 * Access v2 at a location: best in-catchment station's
 * walkProx × (floor + (1−floor)·Ô), per side. Replaces line-count connectivity.
 */
export function accessAt(
  loc: Coordinate,
  opps: StationOpportunity[],
  cfg: InducedDemandConfig,
): DirectionalAccess {
  let res = 0, com = 0;
  const floor = cfg.ACCESS_CONN_FLOOR;
  for (const o of opps) {
    const t = walkSeconds(loc, o.coords, cfg.WALK_SPEED);
    if (t > cfg.CATCHMENT_SECONDS) continue;
    const prox = Math.exp(-((t / cfg.TAU_ACCESS) ** 2));
    const r = prox * (floor + (1 - floor) * o.oJobs);
    const c = prox * (floor + (1 - floor) * o.oRes);
    if (r > res) res = r;
    if (c > com) com = c;
  }
  return { res, com };
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/opportunity.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — all PASS.

```bash
git add src/model/opportunity.ts src/model/opportunity.test.ts
git commit -m "feat: directional reachability-to-opportunity access"
```

---

### Task 6: Density fit + saturation creep

**Files:**
- Create: `src/model/densityFit.ts`
- Test: `src/model/densityFit.test.ts`

Spec §3: bin native points by access; spacing curve = low quantile of nearest-neighbor distance (clamped `[R_MIN,R_MAX]`, monotone non-increasing); mass curve = upper quantile of residents+jobs (monotone non-decreasing, clamped by the city-wide `ENVELOPE_QUANTILE`). Empty bins borrow from the nearest populated bin below. `creepDensify` is monotone.

- [ ] **Step 1: Write the failing test** (`src/model/densityFit.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitDensity, spacingAt, massAt, creepDensify, type FitInputPoint,
} from './densityFit';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

/** Synthetic city: dense high-access core (tight spacing, heavy mass), sparse low-access edge. */
function city(): FitInputPoint[] {
  const pts: FitInputPoint[] = [];
  // core: 10×10 grid at ~200 m pitch (0.0018°), access 0.9, mass 3000
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      pts.push({ location: [i * 0.0018, j * 0.0018], residents: 1500, jobs: 1500, access: 0.9 });
    }
  }
  // edge: 5×5 grid at ~1 km pitch, access 0.1, mass 300
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      pts.push({ location: [0.5 + i * 0.009, 0.5 + j * 0.009], residents: 200, jobs: 100, access: 0.1 });
    }
  }
  return pts;
}

test('fit: high access → tighter spacing and higher mass than low access', () => {
  const fit = fitDensity(city(), cfg);
  assert.ok(spacingAt(fit, 0.9) < spacingAt(fit, 0.1),
    `${spacingAt(fit, 0.9)} < ${spacingAt(fit, 0.1)}`);
  assert.ok(massAt(fit, 0.9) > massAt(fit, 0.1));
});

test('fit: spacing clamped to [R_MIN, R_MAX]', () => {
  const fit = fitDensity(city(), cfg);
  for (const a of [0, 0.3, 0.6, 1]) {
    const s = spacingAt(fit, a);
    assert.ok(s >= cfg.R_MIN && s <= cfg.R_MAX, `spacing(${a}) = ${s}`);
  }
});

test('fit: mass clamped by envelope quantile', () => {
  const fit = fitDensity(city(), cfg);
  assert.ok(massAt(fit, 1) <= fit.massCeiling);
  assert.ok(fit.massCeiling <= 3000);
});

test('fit: curves are monotone across all access values', () => {
  const fit = fitDensity(city(), cfg);
  let prevS = Infinity, prevM = -Infinity;
  for (let a = 0; a <= 1.001; a += 0.05) {
    const s = spacingAt(fit, a), m = massAt(fit, a);
    assert.ok(s <= prevS + 1e-9, `spacing rose at ${a}`);
    assert.ok(m >= prevM - 1e-9, `mass fell at ${a}`);
    prevS = s; prevM = m;
  }
});

test('fit: empty input degrades to flat clamped defaults, no throw', () => {
  const fit = fitDensity([], cfg);
  assert.ok(spacingAt(fit, 0.5) >= cfg.R_MIN);
  assert.ok(massAt(fit, 0.5) >= 0);
});

test('creepDensify: grows only above threshold, never shrinks', () => {
  assert.equal(creepDensify(1, 0.5, cfg), 1);
  const grown = creepDensify(1, 0.9, cfg);
  assert.ok(grown > 1 && grown < 1.001, `slow creep, got ${grown}`);
  assert.equal(creepDensify(1.5, 0, cfg), 1.5); // monotone
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/densityFit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/model/densityFit.ts`):

```ts
/**
 * Density calibration from the city's own points (spec §3): "at access level a,
 * how dense is this city, when it's dense?" Two monotone curves over access bins —
 * spacing (low quantile of NN distance; high access packs tighter) and people
 * mass (upper quantile; clamped by the city-wide envelope so induced sprawl can
 * never out-dense what the map demonstrates). The ceiling multiplier creeps up
 * while the city is saturated (never down — cities don't un-build).
 */
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

export interface FitInputPoint {
  location: Coordinate;
  residents: number;
  jobs: number;
  access: number;
}

export interface DensityFit {
  /** Per-bin spacing r (m), index = bin. */
  spacing: number[];
  /** Per-bin mass M (people). */
  mass: number[];
  /** City-wide people-mass envelope (ENVELOPE_QUANTILE). */
  massCeiling: number;
  bins: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

/** Nearest-neighbor distance per point via a coarse grid (cell = R_MAX). */
function nnDistances(pts: FitInputPoint[], cellM: number): number[] {
  const grid = new Map<string, number[]>();
  const key = (lon: number, lat: number): string =>
    `${Math.floor((lon * 111320) / cellM)},${Math.floor((lat * 110540) / cellM)}`;
  pts.forEach((p, i) => {
    const k = key(p.location[0], p.location[1]);
    const b = grid.get(k);
    if (b) b.push(i); else grid.set(k, [i]);
  });
  return pts.map((p, i) => {
    const cx = Math.floor((p.location[0] * 111320) / cellM);
    const cy = Math.floor((p.location[1] * 110540) / cellM);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j === i) continue;
          const d = haversine(p.location, pts[j].location);
          if (d < best) best = d;
        }
      }
    }
    return best; // Infinity when isolated beyond the ring — treated as R_MAX by clamping
  });
}

export function fitDensity(pts: FitInputPoint[], cfg: InducedDemandConfig): DensityFit {
  const bins = cfg.FIT_BINS;
  const nn = nnDistances(pts, cfg.R_MAX);
  const byBinNN: number[][] = Array.from({ length: bins }, () => []);
  const byBinMass: number[][] = Array.from({ length: bins }, () => []);
  const allMass: number[] = [];
  pts.forEach((p, i) => {
    const b = Math.min(bins - 1, Math.floor(p.access * bins));
    if (Number.isFinite(nn[i])) byBinNN[b].push(nn[i]);
    byBinMass[b].push(p.residents + p.jobs);
    allMass.push(p.residents + p.jobs);
  });
  allMass.sort((a, b) => a - b);
  const massCeiling = quantile(allMass, cfg.ENVELOPE_QUANTILE);

  const spacing: number[] = new Array(bins);
  const mass: number[] = new Array(bins);
  const clampR = (r: number): number => Math.min(cfg.R_MAX, Math.max(cfg.R_MIN, r));
  for (let b = 0; b < bins; b++) {
    const nnSorted = [...byBinNN[b]].sort((x, y) => x - y);
    const mSorted = [...byBinMass[b]].sort((x, y) => x - y);
    // Empty bins borrow from the nearest populated bin below (bin 0 → global default).
    spacing[b] = nnSorted.length > 0
      ? clampR(quantile(nnSorted, cfg.FIT_SPACING_QUANTILE))
      : (b > 0 ? spacing[b - 1] : cfg.R_MAX);
    mass[b] = mSorted.length > 0
      ? Math.min(massCeiling, quantile(mSorted, cfg.FIT_MASS_QUANTILE))
      : (b > 0 ? mass[b - 1] : quantile(allMass, cfg.FIT_MASS_QUANTILE));
  }
  // Monotone enforcement: spacing non-increasing, mass non-decreasing with access.
  for (let b = 1; b < bins; b++) {
    spacing[b] = Math.min(spacing[b], spacing[b - 1]);
    mass[b] = Math.max(mass[b], mass[b - 1]);
  }
  return { spacing, mass, massCeiling, bins };
}

function binOf(fit: DensityFit, access: number): number {
  return Math.min(fit.bins - 1, Math.max(0, Math.floor(access * fit.bins)));
}

export function spacingAt(fit: DensityFit, access: number): number {
  return fit.spacing[binOf(fit, access)];
}

export function massAt(fit: DensityFit, access: number): number {
  return fit.mass[binOf(fit, access)];
}

/** Daily ceiling creep (spec §3): monotone, only while σ exceeds the threshold. */
export function creepDensify(current: number, sigma: number, cfg: InducedDemandConfig): number {
  if (sigma <= cfg.SAT_THRESHOLD) return current;
  return current * (1 + cfg.RHO_DENSIFY * (sigma - cfg.SAT_THRESHOLD));
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/densityFit.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/densityFit.ts src/model/densityFit.test.ts
git commit -m "feat: per-city density fit with envelope clamp and saturation creep"
```

---

### Task 7: Blue-noise sampler + jitter

**Files:**
- Create: `src/model/sampler.ts`
- Test: `src/model/sampler.test.ts`

Spec §4: deterministic Bridson Poisson-disc per station catchment with spatially-varying `r`, priors (existing sites) as blockers with **soft** spacing `(1−J_FRAC)·r`, water rejection, plus deterministic dart seeding for pockets. Jitter: seeded by point id, ≤ `J_FRAC·r`, deterministic re-roll ≤4 attempts, fallback nominal.

- [ ] **Step 1: Write the failing test** (`src/model/sampler.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine } from './geo';
import { hashStringToSeed, sampleCatchmentSites, jitterPosition } from './sampler';

const R = 300; // constant spacing for tests
const opts = (over: Partial<Parameters<typeof sampleCatchmentSites>[0]> = {}) => ({
  seedKey: 'TST:station1',
  center: [0, 0] as [number, number],
  radiusM: 1500,
  priors: [] as [number, number][],
  spacingAt: () => R,
  reject: () => false,
  softFactor: 0.65,
  ...over,
});

test('deterministic: same seedKey → identical sites; different key → different', () => {
  const a = sampleCatchmentSites(opts());
  const b = sampleCatchmentSites(opts());
  assert.deepEqual(a, b);
  const c = sampleCatchmentSites(opts({ seedKey: 'TST:station2' }));
  assert.notDeepEqual(a.map((s) => s.location), c.map((s) => s.location));
});

test('fills the disc and respects soft spacing between samples', () => {
  const sites = sampleCatchmentSites(opts());
  assert.ok(sites.length > 10, `got ${sites.length}`);
  for (let i = 0; i < sites.length; i++) {
    assert.ok(haversine([0, 0], sites[i].location) <= 1500 + 1);
    for (let j = i + 1; j < sites.length; j++) {
      const d = haversine(sites[i].location, sites[j].location);
      assert.ok(d >= 0.65 * R - 1, `pair ${i},${j} at ${d}m`);
    }
  }
});

test('priors block their soft-spacing neighborhood', () => {
  const priors: [number, number][] = [[0, 0]];
  const sites = sampleCatchmentSites(opts({ priors }));
  for (const s of sites) {
    assert.ok(haversine([0, 0], s.location) >= 0.65 * R - 1);
  }
});

test('reject predicate (water) excludes sites', () => {
  // reject everything west of the center
  const sites = sampleCatchmentSites(opts({ reject: (c) => c[0] < 0 }));
  assert.ok(sites.length > 0);
  for (const s of sites) assert.ok(s.location[0] >= 0);
});

test('site ids are stable and prefixed by seedKey', () => {
  const sites = sampleCatchmentSites(opts());
  assert.match(sites[0].id, /^TST:station1:0$/);
  assert.match(sites[1].id, /^TST:station1:1$/);
});

test('jitterPosition: within J·r, deterministic, re-rolls on rejection', () => {
  const nominal: [number, number] = [0, 0];
  const a = jitterPosition('induced-pt:7', nominal, R, 0.35, () => false);
  const b = jitterPosition('induced-pt:7', nominal, R, 0.35, () => false);
  assert.deepEqual(a, b);
  assert.ok(haversine(nominal, a) <= 0.35 * R + 1);
  assert.ok(haversine(nominal, a) > 0); // actually moved
  // rejecting every position falls back to the nominal
  const fallback = jitterPosition('induced-pt:7', nominal, R, 0.35, () => true);
  assert.deepEqual(fallback, nominal);
  // rejecting only the first attempt yields a different (re-rolled) position
  let calls = 0;
  const rerolled = jitterPosition('induced-pt:7', nominal, R, 0.35, () => calls++ === 0);
  assert.notDeepEqual(rerolled, a);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/sampler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/model/sampler.ts`):

```ts
/**
 * Deterministic blue-noise site sampling (spec §4). Bridson Poisson-disc with a
 * spatially-varying radius inside one station catchment, seeded by city+station —
 * candidates re-derive identically every load, so positions are never persisted.
 * Priors (existing demand points / already-accepted sites) block placement at the
 * SOFT spacing (1−J_FRAC)·r so condensation jitter reads as organic scatter
 * instead of compounding displacement. Water (or any reject predicate) excludes.
 *
 * Jitter at condensation is seeded by the materialized POINT id (FNV-1a →
 * mulberry32, the commuteTimes pattern): deterministic re-roll ≤ 4 attempts
 * against the caller's reject predicate, then the nominal position (already
 * validated at sampling time).
 */
import type { Coordinate } from '../types/core';
import { makeRng } from './gravity';
import { haversine } from './geo';

export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface SamplePoint { id: string; location: Coordinate }

export interface SampleCatchmentOpts {
  /** Deterministic identity, e.g. `<city>:<stationId>`; also the site-id prefix. */
  seedKey: string;
  center: Coordinate;
  radiusM: number;
  /** Existing locations that block placement (soft spacing). */
  priors: Coordinate[];
  /** Local target spacing r (m) at a location. */
  spacingAt(c: Coordinate): number;
  /** True to exclude a location (water). */
  reject(c: Coordinate): boolean;
  /** Soft-spacing factor (1 − J_FRAC). */
  softFactor: number;
}

const K_ATTEMPTS = 16;
const DART_SEEDS = 12;

export function sampleCatchmentSites(opts: SampleCatchmentOpts): SamplePoint[] {
  const { center, radiusM, softFactor } = opts;
  const lat0 = center[1];
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = 110540;
  const toLonLat = (x: number, y: number): Coordinate =>
    [center[0] + x / mPerLon, center[1] + y / mPerLat];
  const rng = makeRng(hashStringToSeed(opts.seedKey));

  // Occupancy grid over accepted + prior positions (meter frame), cell = R_MIN-ish.
  const accepted: { x: number; y: number; loc: Coordinate }[] = [];
  const blockers: { x: number; y: number }[] = [];
  for (const p of opts.priors) {
    const x = (p[0] - center[0]) * mPerLon;
    const y = (p[1] - center[1]) * mPerLat;
    if (Math.hypot(x, y) <= radiusM + 2 * opts.spacingAt(p)) blockers.push({ x, y });
  }
  const tooClose = (x: number, y: number, r: number): boolean => {
    const minD = softFactor * r;
    for (const b of blockers) if (Math.hypot(b.x - x, b.y - y) < minD) return true;
    for (const a of accepted) if (Math.hypot(a.x - x, a.y - y) < minD) return true;
    return false;
  };

  const tryAccept = (x: number, y: number): boolean => {
    if (Math.hypot(x, y) > radiusM) return false;
    const loc = toLonLat(x, y);
    const r = opts.spacingAt(loc);
    if (tooClose(x, y, r)) return false;
    if (opts.reject(loc)) return false;
    accepted.push({ x, y, loc });
    return true;
  };

  // Seeds: the center, plus deterministic darts for pockets behind blockers.
  const active: number[] = [];
  if (tryAccept(0, 0)) active.push(accepted.length - 1);
  for (let i = 0; i < DART_SEEDS; i++) {
    const ang = rng() * 2 * Math.PI;
    const rad = Math.sqrt(rng()) * radiusM;
    if (tryAccept(rad * Math.cos(ang), rad * Math.sin(ang))) active.push(accepted.length - 1);
  }

  // Bridson: spawn in the annulus [r, 2r] of an active sample.
  while (active.length > 0) {
    const ai = Math.floor(rng() * active.length);
    const a = accepted[active[ai]];
    const r = opts.spacingAt(a.loc);
    let placed = false;
    for (let k = 0; k < K_ATTEMPTS; k++) {
      const ang = rng() * 2 * Math.PI;
      const rad = r * (1 + rng());
      if (tryAccept(a.x + rad * Math.cos(ang), a.y + rad * Math.sin(ang))) {
        active.push(accepted.length - 1);
        placed = true;
        break;
      }
    }
    if (!placed) active.splice(ai, 1);
  }

  return accepted.map((a, i) => ({ id: `${opts.seedKey}:${i}`, location: a.loc }));
}

/**
 * Jittered condensation position for a materialized point (spec §4): offset
 * ≤ jFrac·r from the nominal site, deterministic per point id; re-roll with a
 * bumped seed while rejected (≤ `attempts`), then fall back to the nominal.
 */
export function jitterPosition(
  pointId: string,
  nominal: Coordinate,
  rM: number,
  jFrac: number,
  reject: (c: Coordinate) => boolean,
  attempts = 4,
): Coordinate {
  const lat0 = nominal[1];
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = 110540;
  for (let a = 0; a < attempts; a++) {
    const rng = makeRng(hashStringToSeed(`${pointId}:${a}`));
    const ang = rng() * 2 * Math.PI;
    const rad = Math.sqrt(rng()) * jFrac * rM;
    const c: Coordinate = [
      nominal[0] + (rad * Math.cos(ang)) / mPerLon,
      nominal[1] + (rad * Math.sin(ang)) / mPerLat,
    ];
    if (!reject(c)) return c;
  }
  return nominal;
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/sampler.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/sampler.ts src/model/sampler.test.ts
git commit -m "feat: deterministic varying-radius Bridson sampler and condensation jitter"
```

---

### Task 8: Field assembly + structural hash

**Files:**
- Create: `src/model/field.ts`
- Test: `src/model/field.test.ts`

Spec §1/§8: sites = natives (occupied) ∪ per-station candidates (empty), sampled per catchment seeded `<city>:<stationId>`, older stations first, priors = everything already placed; candidates below `MIN_SITE_ACCESS` dropped; directional access cached on every site. `computeStructuralHash` = route ids + station-id lists (the **primary** edit detector — route edits fire no hook).

- [ ] **Step 1: Write the failing test** (`src/model/field.test.ts`):

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/field.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/model/field.ts`):

```ts
/**
 * The site field (spec §1): every place that can hold demand. Native demand
 * points are occupied sites; blue-noise candidates in station catchments are
 * empty sites. Candidates are sampled PER STATION (seeded `<city>:<stationId>`,
 * older stations first) so adding a line elsewhere never reshuffles existing
 * candidates, and re-derive identically each load — only accumulators and
 * materialized-point records persist (ledger).
 */
import type { Coordinate } from '../types/core';
import type { DemandData, Route, Station } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import type { DirectionalAccess } from './opportunity';
import { sampleCatchmentSites } from './sampler';
import { DEFAULT_CONFIG } from './config';

export interface Site {
  /** Demand-point id for natives; nominal sampler id for candidates/materialized. */
  id: string;
  /** Demand-point id when occupied, null for empty candidates. */
  pointId: string | null;
  location: Coordinate;
  accessRes: number;
  accessCom: number;
}

export interface FieldDeps {
  spacingAt(c: Coordinate): number;
  accessAt(c: Coordinate): DirectionalAccess;
  isWater(c: Coordinate): boolean;
}

export interface BuildSitesOpts {
  dd: DemandData;
  stations: Station[];
  /** ledger.materialized: point id → { location, siteId }. */
  materialized: Record<string, { location: Coordinate; siteId: string }>;
  catchmentM: number;
  deps: FieldDeps;
  /** City code — sampler seed prefix. */
  seedPrefix: string;
  cfg?: InducedDemandConfig;
}

export function buildSites(opts: BuildSitesOpts): Site[] {
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  const { dd, deps } = opts;
  const sites: Site[] = [];
  const takenSiteIds = new Map<string, string>(); // nominal site id → point id
  for (const [pid, rec] of Object.entries(opts.materialized)) {
    takenSiteIds.set(rec.siteId, pid);
  }

  // Natives + materialized points: occupied sites. Materialized keep their
  // nominal site id so re-sampling dedupe knows the slot is taken.
  const materializedByPoint = opts.materialized;
  for (const p of dd.points.values()) {
    const rec = materializedByPoint[p.id];
    const a = deps.accessAt(p.location);
    sites.push({
      id: rec ? rec.siteId : p.id,
      pointId: p.id,
      location: p.location,
      accessRes: a.res,
      accessCom: a.com,
    });
  }

  // Candidates: per routed station, oldest first; priors = everything placed so far.
  const routed = opts.stations
    .filter((s) => (s.routeIds?.length ?? 0) > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  const priorLocs = (): Coordinate[] => sites.map((s) => s.location);
  for (const st of routed) {
    const samples = sampleCatchmentSites({
      seedKey: `${opts.seedPrefix}:${st.id}`,
      center: st.coords,
      radiusM: opts.catchmentM,
      priors: priorLocs(),
      spacingAt: deps.spacingAt,
      reject: deps.isWater,
      softFactor: 1 - cfg.J_FRAC,
    });
    for (const s of samples) {
      if (takenSiteIds.has(s.id)) continue; // materialized already occupies this slot
      const a = deps.accessAt(s.location);
      if (Math.max(a.res, a.com) < cfg.MIN_SITE_ACCESS) continue;
      sites.push({ id: s.id, pointId: null, location: s.location, accessRes: a.res, accessCom: a.com });
    }
  }
  return sites;
}

/** Tier 2 refresh: recompute cached access on every site (topology unchanged). */
export function refreshSiteAccess(
  sites: Site[],
  accessAt: (c: Coordinate) => DirectionalAccess,
): void {
  for (const s of sites) {
    const a = accessAt(s.location);
    s.accessRes = a.res;
    s.accessCom = a.com;
  }
}

/**
 * Structural hash of the live network (spec §8): route ids + per-route station
 * ids. This is the PRIMARY route-edit detector — temp-route commits fire NO
 * hook (decompile-verified), so Tier 2 compares this every day end.
 */
export function computeStructuralHash(routes: Route[]): string {
  return routes
    .filter((r) => r.tempParentId == null)
    .map((r) => `${r.id}:${(r.stations ?? []).map((s) => s.id).join(',')}`)
    .sort()
    .join('|');
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/field.test.ts`
Expected: 7 PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — all PASS.

```bash
git add src/model/field.ts src/model/field.test.ts
git commit -m "feat: site field assembly with per-station sampling and structural hash"
```

---

### Task 9: Ledger extensions (sites, materialized points, densify, ptSeq)

**Files:**
- Modify: `src/model/ledger.ts`
- Modify: `src/model/popFactory.ts` (zeroModeShare + createInducedPoint)
- Test: `src/model/ledger.test.ts` (append), `src/model/popFactory.test.ts` (append)

- [ ] **Step 1: Write the failing tests.** Append to `src/model/ledger.test.ts`:

```ts
// --- access-field infill: ledger extensions -------------------------------

import {
  recreateMaterializedPoints,
} from './ledger';

test('serialize/deserialize round-trips sites, materialized, densify, ptSeq', () => {
  const led = newLedger();
  led.sites = { 'C:s1:0': [120, 0], 'C:s1:1': [0, 0] }; // second is zero → pruned
  led.materialized = { 'induced-pt:0': { location: [1, 2], siteId: 'C:s1:4' } };
  led.densify = 1.25;
  led.ptSeq = 3;
  const back = deserializeFromStore(serializeForStore(led));
  assert.deepEqual(back.sites, { 'C:s1:0': [120, 0] });
  assert.deepEqual(back.materialized, led.materialized);
  assert.equal(back.densify, 1.25);
  assert.equal(back.ptSeq, 3);
});

test('serialize: defaults are omitted (no densify=1, no empty records)', () => {
  const led = newLedger();
  led.densify = 1;
  led.sites = {};
  const payload = JSON.parse(serializeForStore(led));
  assert.equal(payload.densify, undefined);
  assert.equal(payload.sites, undefined);
  assert.equal(payload.materialized, undefined);
});

test('recreateMaterializedPoints: recreates referenced, GCs unreferenced', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.pops['induced:0'] = { residenceId: 'induced-pt:0', jobId: 'native1' };
  led.materialized = {
    'induced-pt:0': { location: [1, 2], siteId: 's' },   // referenced by roster
    'induced-pt:1': { location: [3, 4], siteId: 't' },   // orphaned → GC
  };
  const r = recreateMaterializedPoints(dd, led);
  assert.equal(r.recreated, 1);
  assert.equal(r.dropped, 1);
  const p = dd.points.get('induced-pt:0');
  assert.ok(p);
  assert.equal(p!.residents, 0);
  assert.equal(p!.jobs, 0);
  assert.deepEqual(p!.location, [1, 2]);
  assert.equal(led.materialized!['induced-pt:1'], undefined);
});

test('recreateMaterializedPoints: existing points are left untouched', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.pops['induced:0'] = { residenceId: 'induced-pt:0', jobId: 'induced-pt:0' };
  led.materialized = { 'induced-pt:0': { location: [1, 2], siteId: 's' } };
  recreateMaterializedPoints(dd, led);
  const p = dd.points.get('induced-pt:0')!;
  p.residents = 999; // simulate later state
  const r2 = recreateMaterializedPoints(dd, led);
  assert.equal(r2.recreated, 0);
  assert.equal(dd.points.get('induced-pt:0')!.residents, 999);
});

test('clearAllInduced: drops materialized records, keeps ptSeq, resets densify', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.ptSeq = 5;
  led.densify = 1.4;
  led.materialized = { 'induced-pt:0': { location: [1, 2], siteId: 's' } };
  led.sites = { s2: [50, 0] };
  const { ledger: fresh } = clearAllInduced(dd, led, DEFAULT_CONFIG);
  assert.equal(fresh.ptSeq, 5);
  assert.equal(fresh.densify ?? 1, 1);
  assert.equal(fresh.materialized, undefined);
  assert.equal(fresh.sites, undefined);
});
```

(Reuse the existing test file's imports of `newLedger`, `serializeForStore`, `deserializeFromStore`, `clearAllInduced`, `DemandData`, `DEFAULT_CONFIG` — extend the import lists at the top of the file as needed.)

Append to `src/model/popFactory.test.ts`:

```ts
// --- access-field infill: point factory -----------------------------------

import { zeroModeShare, createInducedPoint } from './popFactory';

test('createInducedPoint: empty point with zeroed runtime fields', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const p = createInducedPoint(dd, 'induced-pt:0', [5, 6]);
  assert.equal(dd.points.get('induced-pt:0'), p);
  assert.equal(p.residents, 0);
  assert.equal(p.jobs, 0);
  assert.deepEqual(p.popIds, []);
  assert.deepEqual(p.residentModeShare, zeroModeShare());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/ledger.test.ts src/model/popFactory.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement.** In `src/model/popFactory.ts` add (near `ensureTombstoneStub`):

```ts
import type { DemandPoint, ModeChoiceStats } from '../types/game-state';

/** Runtime mode-share zeroes for a freshly materialized point. */
export function zeroModeShare(): ModeChoiceStats {
  return { walking: 0, driving: 0, transit: 0, unknown: 0 };
}

/**
 * Materialize an empty induced demand point (spec §5). The sim overwrites the
 * mode-share fields on its next cycle; residents/jobs stay 0 until pops attach.
 */
export function createInducedPoint(dd: DemandData, id: string, location: Coordinate): DemandPoint {
  const p: DemandPoint = {
    id,
    location,
    residents: 0,
    jobs: 0,
    popIds: [],
    residentModeShare: zeroModeShare(),
    workerModeShare: zeroModeShare(),
  };
  dd.points.set(id, p);
  return p;
}
```

(Merge the type imports with the existing `import type` lines.)

In `src/model/ledger.ts`:

1. Extend `LedgerState`:

```ts
  /** Candidate-site growth accumulators, sparse, keyed by site id as [res, job]. */
  sites?: Record<string, [number, number]>;
  /**
   * Demand points this mod materialized. The game drops them on every real load
   * (city-file-authoritative merge — spec §facts 1), so they are re-created from
   * here BEFORE the pop roster is restored. GC: a record no roster pop references
   * is dropped instead of re-created (the site returns to candidate duty).
   */
  materialized?: Record<string, { location: [number, number]; siteId: string }>;
  /** Densification ceiling multiplier (spec §3); monotone, default 1. */
  densify?: number;
  /** Monotonic counter for induced-pt ids (never reused). */
  ptSeq?: number;
```

2. In `serializeForStore`, before `return JSON.stringify(payload);`:

```ts
  if (ledger.sites) {
    const sites: Record<string, [number, number]> = {};
    for (const [id, [r, j]] of Object.entries(ledger.sites)) {
      if (r !== 0 || j !== 0) sites[id] = [r, j];
    }
    if (Object.keys(sites).length > 0) payload.sites = sites;
  }
  if (ledger.materialized && Object.keys(ledger.materialized).length > 0) {
    payload.materialized = ledger.materialized;
  }
  if (ledger.densify !== undefined && ledger.densify !== 1) payload.densify = ledger.densify;
  if (ledger.ptSeq) payload.ptSeq = ledger.ptSeq;
```

3. In `deserializeFromStore`, after the `tombstones` block:

```ts
    if (o.sites && typeof o.sites === 'object') led.sites = o.sites;
    if (o.materialized && typeof o.materialized === 'object') led.materialized = o.materialized;
    if (typeof o.densify === 'number' && o.densify >= 1) led.densify = o.densify;
    if (typeof o.ptSeq === 'number') led.ptSeq = o.ptSeq;
```

4. Add (after `restoreTombstoneStubs`), importing `createInducedPoint` from `./popFactory`:

```ts
/**
 * Re-create materialized points the load dropped (run BEFORE reconcileInducedPops —
 * roster pops may reference `induced-pt:*` endpoints and the commute worker
 * requires live endpoints). Unreferenced records are garbage-collected: their
 * pops are gone, so the point would be a permanent husk.
 */
export function recreateMaterializedPoints(
  dd: DemandData,
  ledger: LedgerState,
): { recreated: number; dropped: number } {
  let recreated = 0, dropped = 0;
  if (!ledger.materialized) return { recreated, dropped };
  const referenced = new Set<string>();
  for (const rec of Object.values(ledger.pops)) {
    referenced.add(rec.residenceId);
    referenced.add(rec.jobId);
  }
  for (const [pid, rec] of Object.entries(ledger.materialized)) {
    if (dd.points.has(pid)) continue;
    if (!referenced.has(pid)) {
      delete ledger.materialized[pid];
      dropped++;
      continue;
    }
    createInducedPoint(dd, pid, rec.location);
    recreated++;
  }
  return { recreated, dropped };
}
```

5. In `clearAllInduced`, after `fresh.tombstones = { ...(ledger.tombstones ?? {}) };` add:

```ts
  fresh.ptSeq = ledger.ptSeq; // point ids are never reused
  // materialized/sites/densify deliberately NOT carried: cleared points husk out
  // in-session and are GC'd at the next load; densification restarts from 1.
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/ledger.test.ts src/model/popFactory.test.ts`
Expected: all PASS (old + new).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — all PASS.

```bash
git add src/model/ledger.ts src/model/popFactory.ts src/model/ledger.test.ts src/model/popFactory.test.ts
git commit -m "feat: ledger tracks candidate sites, materialized points, densify"
```

---

### Task 10: Engine refactor — unified site loop with condensation

**Files:**
- Modify: `src/model/engine.ts` (rewrite `runDay` signature + sections A/C)
- Modify: `src/model/access.ts` (delete `access()`; keep `toAccessStations`)
- Modify: `src/model/config.ts` (delete `CONNECTIVITY_REF`)
- Modify: `src/overlay/featureCollection.ts` (targeting view → site access, see Step 5)
- Test: `src/model/engine.test.ts` (migrate), `src/model/access.test.ts` (trim)

This is the core refactor (spec §5). `runDay` iterates `Site[]`; occupied sites use `ledger.points` accumulators (native baseline caps ×densify on the induced-headroom term; materialized absolute caps), empty sites use `ledger.sites` with absolute caps and a `POP_SIZE` seeding current. Winners that are empty sites materialize a point (jittered), then `addInducedPop` runs as today. Saturation is computed in the same pass and `ledger.densify` creeps.

- [ ] **Step 1: New engine interface.** Rewrite `src/model/engine.ts` — full replacement of sections A–C wiring (D stays identical in body; shown in full so the file can be written top-to-bottom):

```ts
import type { DemandData } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import type { LedgerState } from './ledger';
import type { Site } from './field';
import { isPendingRemoval } from './ledger';
import { residentialScore, commercialScore, MODE_SHARE_FLOOR } from './score';
import { cap, logisticDelta } from './growth';
import { reconcile, allocateInteger } from './allocate';
import { pairByGravity } from './gravity';
import {
  addInducedPop, createInducedPoint, INDUCED_PREFIX, deferInducedPopRemoval,
} from './popFactory';
import { INDUCED_POINT_PREFIX } from './inducedId';
import { creepDensify } from './densityFit';
import { DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';
import { DEFAULT_DRIVING_MODEL, type DrivingModel } from './drivingModel';
import { clamp } from './util';

export interface DayDelta { ar: number; aj: number; rr: number; rj: number }

export interface DayResult {
  added: number;
  removed: number;
  /** Points newly materialized this day. */
  newPoints: number;
  deltas: Record<string, DayDelta>;
}

/** Injected field/fit context for one day (built by main.ts from the field state). */
export interface RunDayDeps {
  /** People cap for an empty/materialized site at a given access. */
  massAt(access: number): number;
  /** Local spacing r (m) at a given access — jitter radius source. */
  spacingAt(access: number): number;
  /** Water- and spacing-checked jitter for a materializing point. */
  jitter(pointId: string, nominal: Coordinate, rM: number): Coordinate;
}

function bumpDelta(deltas: Record<string, DayDelta>, id: string, key: keyof DayDelta): void {
  const d = deltas[id] ?? (deltas[id] = { ar: 0, aj: 0, rr: 0, rj: 0 });
  d[key]++;
}

/** Advance the model one in-game day over the unified site field (spec §5). */
export function runDay(
  dd: DemandData,
  sites: Site[],
  ledger: LedgerState,
  cfg: InducedDemandConfig,
  rng: () => number,
  deps: RunDayDeps,
  slots: SlotSet = DEFAULT_SLOT_SET,
  driving: DrivingModel = DEFAULT_DRIVING_MODEL,
): DayResult {
  const densify = ledger.densify ?? 1;
  const locations = new Map<string, Coordinate>();
  for (const s of sites) locations.set(s.id, s.location);
  const capRes = new Map<string, number>();
  const capJob = new Map<string, number>();
  // Saturation inputs: induced headroom filled vs capacity (spec §3).
  let satFilled = 0;
  let satCapacity = 0;

  // A. accumulate pressure per site
  for (const s of sites) {
    if (s.pointId) {
      const p = dd.points.get(s.pointId);
      if (!p) continue;
      const isMat = !!ledger.materialized?.[s.pointId];
      let e = ledger.points[s.pointId];
      if (!e) {
        e = ledger.points[s.pointId] = {
          baselineResidents: isMat ? 0 : p.residents,
          baselineJobs: isMat ? 0 : p.jobs,
          resAccum: 0,
          jobAccum: 0,
        };
      }
      const sRes = residentialScore(p, s.accessRes);
      const sJob = commercialScore(p, s.accessCom);
      const cR = isMat
        ? cfg.RES_SHARE * deps.massAt(s.accessRes) * densify
        : cap(e.baselineResidents, sRes * densify, cfg.K_MAX);
      const cJ = isMat
        ? cfg.JOB_SHARE * deps.massAt(s.accessCom) * densify
        : cap(e.baselineJobs, sJob * densify, cfg.K_MAX);
      capRes.set(s.id, cR);
      capJob.set(s.id, cJ);
      e.resAccum = clamp(
        e.resAccum + logisticDelta(e.baselineResidents, p.residents, cR, sRes, cfg),
        -cfg.ACCUM_CAP, cfg.ACCUM_CAP,
      );
      e.jobAccum = clamp(
        e.jobAccum + logisticDelta(e.baselineJobs, p.jobs, cJ, sJob, cfg),
        -cfg.ACCUM_CAP, cfg.ACCUM_CAP,
      );
      satFilled += Math.max(0, p.residents - e.baselineResidents) + Math.max(0, p.jobs - e.baselineJobs);
      satCapacity += Math.max(0, cR - e.baselineResidents) + Math.max(0, cJ - e.baselineJobs);
    } else {
      // Empty candidate: absolute caps; seed the logistic with one pop of latent demand
      // (current=0 would never grow), never decay below 0 (nothing there to remove).
      if (!ledger.sites) ledger.sites = {};
      const e = ledger.sites[s.id] ?? (ledger.sites[s.id] = [0, 0]);
      const sRes = s.accessRes * MODE_SHARE_FLOOR;
      const sJob = s.accessCom * MODE_SHARE_FLOOR;
      const cR = cfg.RES_SHARE * deps.massAt(s.accessRes) * densify;
      const cJ = cfg.JOB_SHARE * deps.massAt(s.accessCom) * densify;
      capRes.set(s.id, cR);
      capJob.set(s.id, cJ);
      e[0] = clamp(e[0] + Math.max(0, logisticDelta(0, cfg.POP_SIZE, cR, sRes, cfg)), 0, cfg.ACCUM_CAP);
      e[1] = clamp(e[1] + Math.max(0, logisticDelta(0, cfg.POP_SIZE, cJ, sJob, cfg)), 0, cfg.ACCUM_CAP);
      satCapacity += cR + cJ;
    }
  }

  // B. growth — one shared budget over ALL sites, gravity-paired
  let added = 0;
  let newPoints = 0;
  const deltas: Record<string, DayDelta> = {};
  const addedThisDay = new Set<string>();
  const ids = sites.map((s) => s.id);
  const accumOf = (s: Site): [number, number] => {
    if (s.pointId) {
      const e = ledger.points[s.pointId];
      return e ? [e.resAccum, e.jobAccum] : [0, 0];
    }
    return ledger.sites?.[s.id] ?? [0, 0];
  };
  const resWeights = sites.map((s) => Math.max(0, accumOf(s)[0]));
  const jobWeights = sites.map((s) => Math.max(0, accumOf(s)[1]));
  const rp = resWeights.reduce((a, b) => a + b, 0);
  const jp = jobWeights.reduce((a, b) => a + b, 0);
  const N = Math.floor(reconcile(rp, jp, cfg.RECONCILE) / cfg.POP_SIZE);
  if (N > 0) {
    const remCapRes = sites.map((s) => {
      const c = capRes.get(s.id) ?? 0;
      const current = s.pointId ? (dd.points.get(s.pointId)?.residents ?? 0) : 0;
      return Math.max(0, Math.ceil((c - current) / cfg.POP_SIZE));
    });
    const remCapJob = sites.map((s) => {
      const c = capJob.get(s.id) ?? 0;
      const current = s.pointId ? (dd.points.get(s.pointId)?.jobs ?? 0) : 0;
      return Math.max(0, Math.ceil((c - current) / cfg.POP_SIZE));
    });
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const resPool = expand(ids, allocateInteger(resWeights, N, remCapRes));
    const jobPool = expand(ids, allocateInteger(jobWeights, N, remCapJob));

    /** Condense an empty site into a real DemandPoint; returns its point id. */
    const materialize = (site: Site): string => {
      const pid = `${INDUCED_POINT_PREFIX}${ledger.ptSeq ?? 0}`;
      ledger.ptSeq = (ledger.ptSeq ?? 0) + 1;
      const r = deps.spacingAt(Math.max(site.accessRes, site.accessCom));
      const loc = deps.jitter(pid, site.location, r);
      createInducedPoint(dd, pid, loc);
      if (!ledger.materialized) ledger.materialized = {};
      ledger.materialized[pid] = { location: [loc[0], loc[1]], siteId: site.id };
      const [ra, ja] = ledger.sites?.[site.id] ?? [0, 0];
      ledger.points[pid] = { baselineResidents: 0, baselineJobs: 0, resAccum: ra, jobAccum: ja };
      if (ledger.sites) delete ledger.sites[site.id];
      site.pointId = pid;
      locations.set(site.id, loc);
      newPoints++;
      return pid;
    };
    const pointIdFor = (siteId: string): string | null => {
      const site = siteById.get(siteId);
      if (!site) return null;
      return site.pointId ?? materialize(site);
    };

    for (const [h, w] of pairByGravity(resPool, jobPool, locations, cfg, rng)) {
      const hPid = pointIdFor(h);
      const wPid = pointIdFor(w);
      if (!hPid || !wPid) continue;
      const id = `${INDUCED_PREFIX}${ledger.seq}`;
      if (addInducedPop(dd, hPid, wPid, id, cfg, slots, driving)) {
        ledger.pops[id] = { residenceId: hPid, jobId: wPid };
        ledger.seq++;
        addedThisDay.add(id);
        const eh = ledger.points[hPid];
        const ew = ledger.points[wPid];
        if (eh) eh.resAccum = Math.max(0, eh.resAccum - cfg.POP_SIZE);
        if (ew) ew.jobAccum = Math.max(0, ew.jobAccum - cfg.POP_SIZE);
        bumpDelta(deltas, hPid, 'ar');
        bumpDelta(deltas, wPid, 'aj');
        added++;
        satFilled += cfg.POP_SIZE * 2;
      }
    }
  }

  // C. decay — unchanged from the pre-field engine: only occupied sites can decay.
  let removed = 0;
  for (const s of sites) {
    if (!s.pointId) continue;
    const e = ledger.points[s.pointId];
    if (!e) continue;
    while (e.resAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, ledger, s.pointId, 'residence', addedThisDay);
      if (!id) { e.resAccum = -cfg.POP_SIZE + 1; break; }
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.resAccum += cfg.POP_SIZE;
      removed++;
    }
    while (e.jobAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, ledger, s.pointId, 'job', addedThisDay);
      if (!id) { e.jobAccum = -cfg.POP_SIZE + 1; break; }
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.jobAccum += cfg.POP_SIZE;
      removed++;
    }
  }

  // D. saturation-driven densification (spec §3) — monotone.
  const sigma = satCapacity > 0 ? Math.min(1, satFilled / satCapacity) : 0;
  ledger.densify = creepDensify(densify, sigma, cfg);

  return { added, removed, newPoints, deltas };
}

/** A removed pop changes demand at BOTH endpoints — attribute it to each (before deferral). */
function recordRemoval(dd: DemandData, deltas: Record<string, DayDelta>, id: string): void {
  const pop = dd.popsMap.get(id);
  if (!pop) return;
  bumpDelta(deltas, pop.residenceId, 'rr');
  bumpDelta(deltas, pop.jobId, 'rj');
}

function expand(ids: string[], slots: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) for (let k = 0; k < slots[i]; k++) out.push(ids[i]);
  return out;
}

function findInduced(
  dd: DemandData,
  ledger: LedgerState,
  pointId: string,
  side: 'residence' | 'job',
  exclude?: ReadonlySet<string>,
): string | null {
  const p = dd.points.get(pointId);
  if (!p) return null;
  for (let i = p.popIds.length - 1; i >= 0; i--) {
    const id = p.popIds[i];
    if (!id.startsWith(INDUCED_PREFIX)) continue;
    if (exclude?.has(id)) continue;
    if (isPendingRemoval(ledger, id)) continue;
    const pop = dd.popsMap.get(id);
    if (!pop) continue;
    if (side === 'residence' && pop.residenceId === pointId) return id;
    if (side === 'job' && pop.jobId === pointId) return id;
  }
  return null;
}
```

Notes locked in by this code (call them out in review): the relocation pass (`PHI`/`applyRelocation`) is **removed** — `PHI` defaults to 0 and never shipped enabled; delete the config field too if nothing references it (keep `PHI` in config, it is used by the old tests — delete those assertions instead). Densify boosts native caps by scaling the *score* inside `cap()` (equivalent to scaling `K_MAX·score`), keeping `cap()`'s signature.

- [ ] **Step 2: Trim `access.ts`** — delete the `access()` function and its `CONNECTIVITY_REF`/Gaussian body; keep `AccessStation` + `toAccessStations` (still used by `featureCollection.ts` until Step 5 and by tests). Delete `CONNECTIVITY_REF` from `config.ts` (interface + default). Delete the `access()` tests from `src/model/access.test.ts`, keeping `toAccessStations` tests.

- [ ] **Step 3: Migrate `engine.test.ts`.** Replace station fixtures with site fixtures. Add these helpers at the top of the file:

```ts
import type { Site } from './field';
import type { RunDayDeps } from './engine';

/** Occupied site for an existing point with directly-injected access. */
function siteOf(p: DemandPoint, access = 0.8): Site {
  return { id: p.id, pointId: p.id, location: p.location, accessRes: access, accessCom: access };
}
/** Empty candidate site. */
function candidate(id: string, lon: number, lat: number, access = 0.8): Site {
  return { id, pointId: null, location: [lon, lat], accessRes: access, accessCom: access };
}
const DAY_DEPS: RunDayDeps = {
  massAt: () => 2000,
  spacingAt: () => 300,
  jitter: (_id, nominal) => nominal,
};
```

Mechanical migration rule for every existing test: a call
`runDay(dd, stations, ledger, cfg, rng, slots?, driving?)` becomes
`runDay(dd, sites, ledger, cfg, rng, DAY_DEPS, slots?, driving?)` where `sites = [...dd.points.values()].map((p) => siteOf(p, A))` and `A` replaces whatever access the old station fixture produced (old tests placed a station on top of a point for access ≈ `1 × (floor + …)`; use `A = 0.8` for "near station" fixtures and `A = 0` for "no station" fixtures). Tests that asserted `PHI`/relocation behavior are deleted. Then add the new condensation tests:

```ts
test('condensation: an empty site that wins allocation materializes a point + pop', () => {
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);  // reuse the file's existing fixtures
  const ledger = newLedger();
  ledger.sites = { 'c1': [DEFAULT_CONFIG.POP_SIZE, DEFAULT_CONFIG.POP_SIZE] }; // pre-pressurized
  const sites = [siteOf(dd.points.get('n1')!, 0.8), candidate('c1', 0.01, 0.01)];
  const r = runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), DAY_DEPS);
  assert.ok(r.newPoints >= 1, `materialized ${r.newPoints}`);
  const pid = 'induced-pt:0';
  const p = dd.points.get(pid);
  assert.ok(p, 'point exists');
  assert.ok(ledger.materialized?.[pid], 'ledger records it');
  assert.equal(ledger.sites?.['c1'], undefined, 'site accum transferred');
  assert.ok(ledger.points[pid], 'point accumulator exists with baseline 0');
  assert.equal(ledger.points[pid].baselineResidents, 0);
  // the pop that won it references live endpoints
  const popIds = [...dd.popsMap.keys()].filter((id) => id.startsWith('induced:'));
  assert.ok(popIds.length >= 1);
});

test('empty sites accumulate pressure from access alone', () => {
  const dd = makeDD([]);
  const ledger = newLedger();
  const sites = [candidate('c1', 0, 0, 0.8)];
  runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), DAY_DEPS);
  assert.ok((ledger.sites?.['c1']?.[0] ?? 0) > 0, 'res pressure accrued');
});

test('empty sites never decay below zero pressure', () => {
  const dd = makeDD([]);
  const ledger = newLedger();
  ledger.sites = { c1: [0, 0] };
  const sites = [candidate('c1', 0, 0, 0)]; // zero access
  runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), DAY_DEPS);
  assert.deepEqual(ledger.sites.c1, [0, 0]);
});

test('densify creeps only when saturated', () => {
  const dd = makeDD([point('n1', 0, 0, 100, 100)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.1)];
  runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), DAY_DEPS);
  assert.equal(ledger.densify, 1); // far from saturation
});
```

- [ ] **Step 4: Update `featureCollection.ts` targeting view** — it imported `access()`. Change `buildOverlay` to take precomputed access per point instead: replace the `access/toAccessStations` import and the `stations` parameter with `accessOf: (p: DemandPoint) => { res: number; com: number }`; in the targeting branch use `const a = accessOf(p); const sRes = residentialScore(p, a.res); const sJob = commercialScore(p, a.com);`. Update `featureCollection.test.ts` call sites to pass `() => ({ res: 0.8, com: 0.8 })` (or `0` for the no-access cases) instead of station fixtures, and `main.ts`'s `refreshOverlay` call is fixed in Task 12.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all PASS (engine tests migrated, access tests trimmed, new condensation tests green). `npx tsc --noEmit` clean **except** `main.ts` errors from the changed `runDay`/`buildOverlay` signatures are NOT acceptable — main.ts still compiles because Task 12 has not run yet; to keep the tree green, apply the minimal `main.ts` bridge now: replace the old `runDay(...)` call with a temporary
`runDay(dd, [...dd.points.values()].map((p) => ({ id: p.id, pointId: p.id, location: p.location, accessRes: 0, accessCom: 0 })), ledger, DEFAULT_CONFIG, makeRng(hashSeed(currentCity(), day)), { massAt: () => 0, spacingAt: () => DEFAULT_CONFIG.R_MAX, jitter: (_i, n) => n }, liveSlotSet(), drivingModel())`
and `buildOverlay(dd, () => ({ res: 0, com: 0 }), s.view, s.metric, DEFAULT_CONFIG)` — behavior-neutral placeholders (zero access ⇒ no growth) that Task 12 replaces with the real field.

- [ ] **Step 6: Commit**

```bash
git add src/model/engine.ts src/model/engine.test.ts src/model/access.ts src/model/access.test.ts src/model/config.ts src/overlay/featureCollection.ts src/overlay/featureCollection.test.ts src/main.ts
git commit -m "feat: unified site loop with condensation of new demand points"
```

---

### Task 11: Heatmap overlay + panel field view

**Files:**
- Create: `src/overlay/heatmap.ts`
- Modify: `src/overlay/state.ts` (heatView)
- Modify: `src/ui/panel.ts` (Field row + perf line)
- Test: `src/overlay/heatmap.test.ts`

- [ ] **Step 1: Write the failing test** (`src/overlay/heatmap.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '../model/field';
import { buildHeatFeatures } from './heatmap';
import { newLedger } from '../model/ledger';
import { DEFAULT_CONFIG } from './../model/config';

const sites: Site[] = [
  { id: 'a', pointId: 'a', location: [0, 0], accessRes: 0.9, accessCom: 0.2 },
  { id: 'b', pointId: null, location: [1, 1], accessRes: 0.4, accessCom: 0.7 },
  { id: 'c', pointId: null, location: [2, 2], accessRes: 0.001, accessCom: 0.001 },
];

test('accessRes view: weight = accessRes, near-zero sites dropped', () => {
  const fc = buildHeatFeatures(sites, newLedger(), 'accessRes', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0].properties.w, 0.9);
});

test('pressure view: weight = accum / POP_SIZE clamped to 1', () => {
  const led = newLedger();
  led.sites = { b: [DEFAULT_CONFIG.POP_SIZE * 2, 0] };
  led.points.a = { baselineResidents: 0, baselineJobs: 0, resAccum: 100, jobAccum: 0 };
  const fc = buildHeatFeatures(sites, led, 'pressure', DEFAULT_CONFIG);
  const wa = fc.features.find((f) => f.properties.id === 'a')!.properties.w;
  const wb = fc.features.find((f) => f.properties.id === 'b')!.properties.w;
  assert.ok(Math.abs(wa - 100 / DEFAULT_CONFIG.POP_SIZE) < 1e-9);
  assert.equal(wb, 1); // clamped
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/overlay/heatmap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/overlay/heatmap.ts`):

```ts
/**
 * Heatmap of the site field (spec §7): the targeting display IS the model's
 * input. MapLibre native heatmap layer over site weights; views: residential
 * access, commercial access, growth pressure. Own source/layer via the same
 * registration pipeline as the circle overlay.
 */
import type { ModdingAPI } from '../types/api';
import type { InducedDemandConfig } from '../model/config';
import type { LedgerState } from '../model/ledger';
import type { Site } from '../model/field';

export const HEAT_SOURCE_ID = 'induced-demand-heat-source';
export const HEAT_LAYER_ID = 'induced-demand-heatmap';

export type HeatView = 'off' | 'accessRes' | 'accessCom' | 'pressure';

export interface HeatFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; w: number };
}
export interface HeatFeatureCollection {
  type: 'FeatureCollection';
  features: HeatFeature[];
}

const EMPTY: HeatFeatureCollection = { type: 'FeatureCollection', features: [] };
const MIN_WEIGHT = 0.02;

export function buildHeatFeatures(
  sites: Site[],
  ledger: LedgerState,
  view: Exclude<HeatView, 'off'>,
  cfg: InducedDemandConfig,
): HeatFeatureCollection {
  const features: HeatFeature[] = [];
  for (const s of sites) {
    let w: number;
    if (view === 'accessRes') w = s.accessRes;
    else if (view === 'accessCom') w = s.accessCom;
    else {
      const [ra, ja] = s.pointId
        ? [(ledger.points[s.pointId]?.resAccum ?? 0), (ledger.points[s.pointId]?.jobAccum ?? 0)]
        : (ledger.sites?.[s.id] ?? [0, 0]);
      w = Math.min(1, Math.max(ra, ja, 0) / cfg.POP_SIZE);
    }
    if (w < MIN_WEIGHT) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.location[0], s.location[1]] },
      properties: { id: s.id, w },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Register source + (hidden) heatmap layer. Idempotent via the API's upsert. */
export function registerHeatmap(api: ModdingAPI): void {
  api.map.registerSource(HEAT_SOURCE_ID, { type: 'geojson', data: EMPTY });
  api.map.registerLayer({
    id: HEAT_LAYER_ID,
    type: 'heatmap',
    source: HEAT_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['get', 'w'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.2],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 18, 14, 60],
      'heatmap-opacity': 0.55,
    },
  });
}

export function updateHeatmap(api: ModdingAPI, fc: HeatFeatureCollection): void {
  const map = api.utils.getMap();
  const src = map?.getSource(HEAT_SOURCE_ID) as unknown as { setData?: (d: unknown) => void } | undefined;
  src?.setData?.(fc);
}

export function setHeatmapVisible(api: ModdingAPI, visible: boolean): void {
  const map = api.utils.getMap();
  if (map && map.getLayer(HEAT_LAYER_ID)) {
    map.setLayoutProperty(HEAT_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
}
```

- [ ] **Step 4: State + panel.** In `src/overlay/state.ts` add to `OverlayState`:

```ts
  /** Field heatmap view; 'off' hides the layer. */
  heatView?: 'off' | 'accessRes' | 'accessCom' | 'pressure';
```

In `src/ui/panel.ts`: extend `createPanel` with a final optional parameter `getPerf: () => string = () => ''`, and inside `Panel` add after the Metric row:

```ts
      row('Field', [
        seg('Off', (s.heatView ?? 'off') === 'off', () => store.set({ heatView: 'off' })),
        seg('Res', s.heatView === 'accessRes', () => store.set({ heatView: 'accessRes' })),
        seg('Com', s.heatView === 'accessCom', () => store.set({ heatView: 'accessCom' })),
        seg('Pres', s.heatView === 'pressure', () => store.set({ heatView: 'pressure' })),
      ]),
```

and before the final `resetBtn` line, a perf readout:

```ts
      h('div', { style: { fontSize: '10px', opacity: 0.6, marginTop: '6px' } }, getPerf() || ' '),
```

Update `src/ui/panel.test.ts` if it asserts the exact row count (add the Field row to expectations).

- [ ] **Step 5: Run tests + commit**

Run: `npm test` — all PASS.

```bash
git add src/overlay/heatmap.ts src/overlay/heatmap.test.ts src/overlay/state.ts src/ui/panel.ts src/ui/panel.test.ts
git commit -m "feat: field heatmap overlay with res/com/pressure views"
```

---

### Task 12: main.ts wiring — field lifecycle, tiers, load order

**Files:**
- Modify: `src/main.ts`

No unit test file — this is the integration layer (covered by the in-game checklist); the full suite still gates the commit. Work through the sub-steps in order; each is a localized edit.

- [ ] **Step 1: Imports + session type.** Add imports:

```ts
import { buildStationGraph, type StationGraph } from './model/stationGraph';
import {
  stationMasses, computeOpportunities, accessAt, type StationOpportunity,
} from './model/opportunity';
import { fitDensity, spacingAt, massAt, type DensityFit, type FitInputPoint } from './model/densityFit';
import { jitterPosition } from './model/sampler';
import { buildSites, refreshSiteAccess, computeStructuralHash, type Site } from './model/field';
import { buildWaterIndex, type WaterIndex, type OceanDepthFile } from './game/waterIndex';
import { recreateMaterializedPoints } from './model/ledger';
import { createPerfTracker, PERF_BUDGETS } from './model/perf';
import {
  registerHeatmap, updateHeatmap, setHeatmapVisible, buildHeatFeatures, type HeatView,
} from './overlay/heatmap';
import { haversine } from './model/geo';
```

Extend `PersistentSession` with:

```ts
    /** Access-field state, per city (spec §1/§8). */
    field?: {
      city: string;
      sites: Site[];
      graph: StationGraph;
      opps: StationOpportunity[];
      fit: DensityFit;
      hash: string;
      water: WaterIndex | null;
      waterFailed: boolean;
    };
```

- [ ] **Step 2: Perf tracker + water loader.** After the `store` const add:

```ts
  const perf = createPerfTracker(
    (m) => { if (DEBUG) console.log(m); },
    (m) => console.warn(m),
  );

  /** Water index, one load attempt per city; null = no mask (warned once). */
  async function loadWaterIndex(city: string): Promise<WaterIndex | null> {
    const start = performance.now();
    try {
      const file = await loadCityJson<OceanDepthFile>(
        window as unknown as DataServerHost, `/data/${city}/ocean_depth_index.json`,
      );
      const idx = buildWaterIndex(file);
      const ms = performance.now() - start;
      if (DEBUG) console.log(`[InducedDemand][perf] water ${ms.toFixed(0)}ms (${file.depths.length} polys)`);
      if (ms > PERF_BUDGETS.water) console.warn(`${TAG} water index load over budget: ${ms.toFixed(0)}ms`);
      return idx;
    } catch (e) {
      console.warn(`${TAG} no ocean_depth_index for ${city} — placing without a water mask`, e);
      return null;
    }
  }
```

- [ ] **Step 3: Field lifecycle.** Add after `inductionStations()`:

```ts
  /** Live routes incl. stations, for graph + hash. */
  function liveRoutes() {
    return api.gameState.getRoutes({ includeTempRoutes: false });
  }

  /**
   * Tier 1 — full structural rebuild (spec §8): graph, opportunities, density
   * fit, candidate sampling, heatmap. Runs at init, debounced on route
   * created/deleted, and when the day-end structural hash mismatches.
   */
  async function rebuildField(): Promise<void> {
    const city = key();
    if (city === 'unknown') return;
    const dd = api.gameState.getDemandData();
    if (!dd) return;
    const session = ensureSession();
    let water = session.field?.city === city ? session.field.water : null;
    let waterFailed = session.field?.city === city ? session.field.waterFailed : false;
    if (!water && !waterFailed) {
      water = await loadWaterIndex(city);
      waterFailed = water === null;
    }
    perf.track('tier1', PERF_BUDGETS.tier1, () => {
      const routes = liveRoutes();
      const stations = inductionStations();
      const groups = api.gameState.getStationGroups?.() ?? [];
      const graph = buildStationGraph(routes, stations, groups, DEFAULT_CONFIG);
      const opps = computeOpportunities(graph, stationMasses(stations, dd.points.values(), DEFAULT_CONFIG), DEFAULT_CONFIG);
      const acc = (c: Coordinate) => accessAt(c, opps, DEFAULT_CONFIG);
      const fitInput: FitInputPoint[] = [...dd.points.values()].map((p) => {
        const a = acc(p.location);
        return { location: p.location, residents: p.residents, jobs: p.jobs, access: Math.max(a.res, a.com) };
      });
      const fit = fitDensity(fitInput, DEFAULT_CONFIG);
      const isWater = (c: Coordinate): boolean => water?.isWater(c) ?? false;
      const sites = buildSites({
        dd,
        stations,
        materialized: ledger.materialized ?? {},
        catchmentM: DEFAULT_CONFIG.CATCHMENT_SECONDS * DEFAULT_CONFIG.WALK_SPEED,
        deps: {
          spacingAt: (c) => spacingAt(fit, Math.max(acc(c).res, acc(c).com)),
          accessAt: acc,
          isWater,
        },
        seedPrefix: city,
        cfg: DEFAULT_CONFIG,
      });
      session.field = {
        city, sites, graph, opps, fit, hash: computeStructuralHash(routes), water, waterFailed,
      };
      return sites;
    }, (sites) => `${sites.length} sites`);
    refreshHeatmap();
  }

  /**
   * Tier 2 — day-end weight refresh (spec §8): re-derive schedule weights +
   * opportunities from getRoutes() (never getTrains()), refresh cached site
   * access. Promotes to Tier 1 when the structural hash changed (route edits
   * fire NO hook — this is the primary edit detector).
   */
  async function refreshFieldWeights(): Promise<void> {
    const session = ensureSession();
    const f = session.field;
    const city = key();
    const dd = api.gameState.getDemandData();
    if (!f || f.city !== city || !dd) { await rebuildField(); return; }
    const routes = liveRoutes();
    if (computeStructuralHash(routes) !== f.hash) { await rebuildField(); return; }
    perf.track('tier2', PERF_BUDGETS.tier2, () => {
      const stations = inductionStations();
      const groups = api.gameState.getStationGroups?.() ?? [];
      f.graph = buildStationGraph(routes, stations, groups, DEFAULT_CONFIG);
      f.opps = computeOpportunities(f.graph, stationMasses(stations, dd.points.values(), DEFAULT_CONFIG), DEFAULT_CONFIG);
      refreshSiteAccess(f.sites, (c) => accessAt(c, f.opps, DEFAULT_CONFIG));
    });
  }

  /** Debounced Tier 1 for route hooks (bursts on batch edits). */
  let fieldRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFieldRebuild(): void {
    if (fieldRebuildTimer) clearTimeout(fieldRebuildTimer);
    fieldRebuildTimer = setTimeout(() => {
      fieldRebuildTimer = null;
      if (isCurrent()) void rebuildField();
    }, 500);
  }

  function refreshHeatmap(): void {
    const s = overlayStore.get();
    const view = (s.heatView ?? 'off') as HeatView;
    const f = wSession[SESSION_KEY]?.field;
    if (view === 'off' || !f || f.city !== key()) { setHeatmapVisible(api, false); return; }
    updateHeatmap(api, buildHeatFeatures(f.sites, ledger, view, DEFAULT_CONFIG));
    setHeatmapVisible(api, true);
  }
```

Subscribe the heatmap to the store: in `refreshOverlay()` add a final `refreshHeatmap();` line.

Also in `refreshOverlay()`, replace Task 10's zero-access bridge in the `buildOverlay` call with field-backed access, so the targeting view shows real scores again:

```ts
    const fieldForOverlay = wSession[SESSION_KEY]?.field;
    const fc = buildOverlay(
      dd,
      (p) => {
        if (!fieldForOverlay || fieldForOverlay.city !== key()) return { res: 0, com: 0 };
        return accessAt(p.location, fieldForOverlay.opps, DEFAULT_CONFIG);
      },
      s.view, s.metric, DEFAULT_CONFIG,
    );
```

- [ ] **Step 4: Load order.** In `ensureReconcile(dd)` insert as the FIRST statements (before `reconcileBaselines`):

```ts
    // Materialized points FIRST: the load dropped them (city-file-authoritative
    // merge), and roster pops may reference induced-pt:* endpoints.
    const mat = recreateMaterializedPoints(dd, ledger);
    if (mat.recreated || mat.dropped) {
      console.log(`${TAG} materialized points: recreated ${mat.recreated}, GC'd ${mat.dropped}`);
    }
```

- [ ] **Step 5: Day loop.** In `onDayChange`, replace the `runDay(...)` call (and its Task-10 placeholder) with:

```ts
    // Tier 2 (or hash-promoted Tier 1) BEFORE growth — no growth day on stale weights.
    try {
      await refreshFieldWeights();
    } catch (e) {
      console.error(`${TAG} field refresh failed`, e);
    }
    const field = wSession[SESSION_KEY]?.field;
    let result: DayResult = { added: 0, removed: 0, newPoints: 0, deltas: {} };
    if (field && field.city === key()) {
      const jitterDep = (pid: string, nominal: Coordinate, rM: number): Coordinate =>
        jitterPosition(pid, nominal, rM, DEFAULT_CONFIG.J_FRAC, (c) => {
          if (field.water?.isWater(c)) return true;
          // Soft spacing vs every existing point (few k points × ≤ ~17 checks/day).
          // Access (→ spacing) computed ONCE per candidate position, not per point.
          const a = accessAt(c, field.opps, DEFAULT_CONFIG);
          const softR = (1 - DEFAULT_CONFIG.J_FRAC) * spacingAt(field.fit, Math.max(a.res, a.com));
          for (const p of dd.points.values()) {
            if (haversine(c, p.location) < softR) return true;
          }
          return false;
        });
      try {
        result = perf.track('day', PERF_BUDGETS.day, () => runDay(
          dd, field.sites, ledger, DEFAULT_CONFIG,
          makeRng(hashSeed(currentCity(), day)),
          {
            massAt: (a) => massAt(field.fit, a),
            spacingAt: (a) => spacingAt(field.fit, a),
            jitter: jitterDep,
          },
          liveSlotSet(), drivingModel(),
        ), (r) => `+${r.added}/-${r.removed}/${r.newPoints}pt`);
      } catch (e) {
        console.error(`${TAG} runDay failed on day ${day}`, e);
      }
    } else if (DEBUG) {
      console.log(`${TAG} day ${day}: field not ready — growth skipped this day`);
    }
```

Make the `onDayChange` callback `async` to allow the `await`. Add `result.newPoints > 0` to the conditions that call `refreshNativeDemandDots()` and `persistLedgerToStore()` (new points must both render and persist promptly), and add `refreshHeatmap();` after `syncPanelState();`. The debug heartbeat gains `newPts ${result.newPoints}`.

- [ ] **Step 6: Hooks + registration + panel.**

```ts
  api.hooks.onRouteCreated(() => { if (isCurrent()) scheduleFieldRebuild(); });
  api.hooks.onRouteDeleted(() => { if (isCurrent()) scheduleFieldRebuild(); });
```

In `registerToolbarPanel()` add `registerHeatmap(api);` after `registerOverlay(api);`. Update the `createPanel` call in `refreshPanelRender()` to pass `() => perf.summary()` as the new last argument. In `init()`, after `ready = true;`, add `void rebuildField();`.

- [ ] **Step 7: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean; all tests PASS.

- [ ] **Step 8: Build the bundle**

Run: `npm run build`
Expected: bundles `dist/index.js`, postbuild copies to `%APPDATA%\metro-maker4\mods\induced-demand`.

- [ ] **Step 9: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire access field into the day loop with two-tier recalculation"
```

---

### Task 13: Docs + version

**Files:**
- Modify: `docs/DEMAND_API.md`
- Modify: `package.json`, `src/version.ts`

- [ ] **Step 1: Document the decompile-verified facts** in `docs/DEMAND_API.md` — add a section after the commute-times section:

```markdown
## Route scheduling & timings (verified 2026-07-17)

- `Route.stComboTimings[]` (`{stNodeId, stNodeIndex, arrivalTime, departureTime}`)
  carries the game's own per-stop timings; cycle time = last entry's
  `arrivalTime` (the game's `getRouteCycleTime`, fallback
  `RULES.TRAIN_SCHEDULE_TRANSITION_WINDOW`).
- `Route.trainSchedule.{highDemand, mediumDemand, lowDemand, veryLowDemand?}`
  are **train counts** (the game takes `Math.max` of them for fleet math), NOT
  headway seconds.
- Timetable mode: `Route.timetableSchedule.mode === 'timetable'` with
  `periods[].headwaySeconds`; the game's `computeTrainCountFromHeadway` is
  `floor(cycle/headway)`.
- Do NOT derive service level from `getTrains()` — live counts sample whichever
  demand period is currently running.

## Hook coverage for route changes (verified 2026-07-17)

`triggerRouteCreated` fires only from `generateRoute` (brand-new routes) and
`triggerRouteDeleted` only from `deleteRoute`. The temp-route commit path
(`tempParentId`) fires **no hook** — route EDITS are invisible to events. Any
mod needing to react to route edits must poll a structural signature (route ids
+ per-route station-id lists); this mod compares one at each day end.
```

- [ ] **Step 2: Bump version** — `package.json` `"version"` to `1.1.0` and matching value in `src/version.ts`.

- [ ] **Step 3: Full suite + commit**

Run: `npm test` — all PASS.

```bash
git add docs/DEMAND_API.md package.json src/version.ts
git commit -m "docs: schedule/timing semantics and hook coverage; bump to 1.1.0"
```

---

### Task 14: Final verification

- [ ] **Step 1: Whole-tree checks**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: everything green; bundle copied to the mods directory.

- [ ] **Step 2: In-game verification checklist** (from spec §10 — requires the game; report results to the user rather than assuming):
  1. `stComboTimings` populated on live routes (`api.gameState.getRoutes({includeTempRoutes:false})[0].stComboTimings` in DevTools).
  2. Native demand-dot layer picks up materialized points after a day with `newPoints > 0` (the nudge fires).
  3. Commute worker tolerates mid-session point additions (no "Residence and/or job coords not found" batch errors).
  4. `ocean_depth_index` loads for the current city (console shows the water perf line, not the fallback warning).
  5. Structural hash detects an in-place route edit by the next day end (edit a route's stops; expect a tier1 rebuild log).
  6. Perf budgets hold on a large city (NYC): watch for `[InducedDemand][perf]` warnings.
  7. Cold-restart round-trip: materialized points + their pops reappear (`recreated N` log), and clearing induced demand + reloading GCs them (`GC'd N`).

- [ ] **Step 3: Update memory** — record implementation completion state in the project memory file per its conventions.

---

## Self-review notes (already applied)

- Spec coverage: §1 field (T8), §2 access v2 (T4+T5), §3 fit/creep (T6), §4 sampler/jitter/water (T3+T7), §5 engine (T10), §6 ledger/persistence (T9 + T12 load order), §7 heatmap (T11), §8 tiers/hash (T12), §9 modules (T2–T11), §10 perf+tests (T2 + per-task), §11 config/typings (T1). Relocation (`PHI`) removal is an intentional simplification called out in T10.
- Type consistency: `Site` defined once in field.ts (T8) and imported by engine (T10), heatmap (T11), main (T12). `RunDayDeps` defined in engine (T10), used in T12. `DirectionalAccess` from opportunity (T5) used by field deps (T8). `DayResult.newPoints` added in T10, consumed in T12.
- Ordering hazard: T10 Step 5 keeps `main.ts` compiling with a zero-access bridge so every task boundary has a green tree.
