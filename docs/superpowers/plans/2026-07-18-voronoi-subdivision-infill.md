# Voronoi-Subdivision Infill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blue-noise candidate infill with deficit-driven Voronoi subdivision: cells anchored by live demand points split slowly into new points at access-weighted centroids, making native-first growth structural and starving walking pairs.

**Architecture:** A coarse lattice (~250 m) over the access-positive area assigns each sample to its nearest demand point (no polygon geometry), yielding per-cell supported mass and access-weighted centroid. Split pressure accrues per cell ∝ `deficit × fill`; crossing the threshold materializes a new `induced-pt:*` at a valid sample near the centroid. The engine loses its empty-candidate branch entirely; `sampler.ts`, the spacing index, `ledger.sites`, and the `densify` multiplier are deleted. Spec: `docs/superpowers/specs/2026-07-18-voronoi-subdivision-infill-design.md`.

**Tech Stack:** TypeScript (ESM, zero deps), node:test via tsx, MapLibre via the modding API. Verify: `npx tsc --noEmit`, `npm test`, `npm run build`. NEVER bump version numbers. NEVER stage `src/game/routePathServer.*` or the two untracked map-loader docs (unrelated dirty work).

**Ordering note:** tasks are sequenced additive-first so the tree stays green at every boundary: new modules land before the engine swap; deletions (sampler, densify, legacy config/ledger fields) come after nothing references them.

---

### Task 1: Config additions + supported density

**Files:**
- Modify: `src/model/config.ts`
- Modify: `src/model/densityFit.ts`
- Test: `src/model/densityFit.test.ts` (append)

- [ ] **Step 1: Append to `InducedDemandConfig`** (do NOT remove anything yet — `J_FRAC`, `RHO_DENSIFY`, `SAT_THRESHOLD` still have consumers until Task 7):

```ts
  // --- Voronoi subdivision (spec 2026-07-18) ---
  /** Lattice sample pitch (m) for cell integration. */
  LATTICE_M: number;
  /** Split-pressure gain per day: pressure += SPLIT_RATE * deficit * fill. */
  SPLIT_RATE: number;
  /** Pressure (people-days) at which a cell may split; also the accumulator cap. */
  SPLIT_THRESHOLD: number;
  /** Global cap on cell splits per day. */
  MAX_SPLITS_PER_DAY: number;
```

And to `DEFAULT_CONFIG`:

```ts
  LATTICE_M: 250,
  SPLIT_RATE: 1,
  SPLIT_THRESHOLD: 50_000,
  MAX_SPLITS_PER_DAY: 3,
```

- [ ] **Step 2: Write the failing test** — append to `src/model/densityFit.test.ts`:

```ts
// --- supported density (Voronoi subdivision) --------------------------------

import { supportedDensityAt } from './densityFit';

test('supportedDensityAt: massAt / spacingAt² (people per m²), higher where access is higher', () => {
  const fit = fitDensity(city(), cfg);
  const dHigh = supportedDensityAt(fit, 0.9);
  const dLow = supportedDensityAt(fit, 0.1);
  assert.ok(Math.abs(dHigh - massAt(fit, 0.9) / spacingAt(fit, 0.9) ** 2) < 1e-12);
  assert.ok(dHigh > dLow, `${dHigh} > ${dLow}`);
  // sanity: a plausible urban magnitude (people per m² is small)
  assert.ok(dHigh > 0 && dHigh < 1);
});
```

(The file already imports `fitDensity`, `spacingAt`, `massAt`, `cfg`, and the `city()` fixture.)

- [ ] **Step 3: Run to verify failure**

Run: `npx tsx --test src/model/densityFit.test.ts`
Expected: FAIL — `supportedDensityAt` not exported.

- [ ] **Step 4: Implement** — append to `src/model/densityFit.ts`:

```ts
/**
 * Areal density the access level supports: people per m², derived from the two
 * fitted curves (mass per point ÷ the area one point serves at that spacing).
 * Feeds the lattice's per-cell supported-mass integral (spec 2026-07-18).
 */
export function supportedDensityAt(fit: DensityFit, access: number): number {
  const r = spacingAt(fit, access);
  return massAt(fit, access) / (r * r);
}
```

- [ ] **Step 5: Verify + commit**

Run: `npx tsx --test src/model/densityFit.test.ts && npx tsc --noEmit && npm test`
Expected: all PASS.

```bash
git add src/model/config.ts src/model/densityFit.ts src/model/densityFit.test.ts
git commit -m "feat: subdivision config knobs and supported areal density"
```

---

### Task 2: Lattice module — cell integration and cut placement

**Files:**
- Create: `src/model/lattice.ts`
- Test: `src/model/lattice.test.ts`

The lattice is the whole "no polygon geometry" trick: fixed global grid (origin 0,0; steps derived from `LATTICE_M` at a reference latitude), samples enumerated per routed-station bounding box with dedupe, each sample assigned to its nearest anchor.

- [ ] **Step 1: Write the failing test** (`src/model/lattice.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Coordinate } from '../types/core';
import { haversine } from './geo';
import {
  createAnchorIndex, integrateCells, findCut, type LatticeDeps,
} from './lattice';

// Flat access everywhere inside catchments; constant density/spacing for
// hand-checkable integrals: supportedDensity = 1e-3 people/m².
const DEPS: LatticeDeps = {
  accessAt: () => ({ res: 0.8, com: 0.8 }),
  isWater: () => false,
  supportedDensity: () => 1e-3,
  spacingAt: () => 300,
  minAccess: 0.05,
};

const anchors = (locs: [string, number, number][]): { id: string; location: Coordinate }[] =>
  locs.map(([id, lon, lat]) => ({ id, location: [lon, lat] }));

test('createAnchorIndex: nearest anchor, deterministic tie-break by id', () => {
  const idx = createAnchorIndex(anchors([['b', 0.01, 0], ['a', -0.01, 0]]));
  assert.equal(idx.nearest([0.009, 0])!.id, 'b');
  assert.equal(idx.nearest([-0.009, 0])!.id, 'a');
  // exact midpoint: equal distance → lexicographically smaller id
  assert.equal(idx.nearest([0, 0])!.id, 'a');
});

test('integrateCells: single anchor, single station — mass ≈ density × catchment area', () => {
  const a = anchors([['p1', 0, 0]]);
  const cells = integrateCells({
    anchors: a,
    stations: [[0, 0]],
    catchmentM: 1000,
    latticeM: 250,
    deps: DEPS,
  });
  const cell = cells.get('p1')!;
  // π·1000² m² × 1e-3 people/m² ≈ 3141 people; lattice discretization ±20%
  assert.ok(cell.supportedMass > 2500 && cell.supportedMass < 3800, `${cell.supportedMass}`);
  // uniform access → centroid ≈ the station/anchor position
  assert.ok(haversine(cell.centroid!, [0, 0]) < 250);
});

test('integrateCells: two anchors split the mass; samples beyond minAccess are excluded', () => {
  const a = anchors([['west', -0.005, 0], ['east', 0.005, 0]]);
  const gated: LatticeDeps = {
    ...DEPS,
    accessAt: (c) => (c[0] < 0 ? { res: 0.8, com: 0.8 } : { res: 0.01, com: 0.01 }),
  };
  const cells = integrateCells({
    anchors: a, stations: [[-0.005, 0], [0.005, 0]], catchmentM: 800, latticeM: 250, deps: gated,
  });
  // East side is below minAccess → east cell integrates ~nothing.
  assert.ok((cells.get('west')?.supportedMass ?? 0) > 0);
  assert.ok((cells.get('east')?.supportedMass ?? 0) < (cells.get('west')?.supportedMass ?? 0) / 4);
});

test('integrateCells: deterministic across calls', () => {
  const a = anchors([['p1', 0, 0], ['p2', 0.004, 0.003]]);
  const run = () => integrateCells({
    anchors: a, stations: [[0, 0], [0.004, 0.003]], catchmentM: 1200, latticeM: 250, deps: DEPS,
  });
  const c1 = run(), c2 = run();
  assert.deepEqual([...c1.entries()], [...c2.entries()]);
});

test('findCut: returns a dry, min-spaced sample in the cell near the centroid', () => {
  const a = anchors([['p1', 0, 0]]);
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 1200, latticeM: 250, deps: DEPS,
  });
  const cut = findCut({
    anchorId: 'p1',
    centroid: cells.get('p1')!.centroid!,
    anchors: a,
    latticeM: 250,
    deps: DEPS,
  });
  assert.ok(cut, 'a cut exists');
  // must respect min spacing from every anchor
  assert.ok(haversine(cut!, [0, 0]) >= 300 - 1, `${haversine(cut!, [0, 0])}`);
});

test('findCut: null when water or spacing exclude every sample', () => {
  const a = anchors([['p1', 0, 0]]);
  const wet: LatticeDeps = { ...DEPS, isWater: () => true };
  const cells = integrateCells({
    anchors: a, stations: [[0, 0]], catchmentM: 800, latticeM: 250, deps: DEPS,
  });
  const cut = findCut({
    anchorId: 'p1', centroid: cells.get('p1')!.centroid!, anchors: a, latticeM: 250, deps: wet,
  });
  assert.equal(cut, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/lattice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/model/lattice.ts`):

```ts
/**
 * Voronoi-cell integration WITHOUT polygon geometry (spec 2026-07-18): cell
 * membership is "this anchor is my nearest live demand point", evaluated on a
 * fixed coarse lattice covering the access-positive area. One pass yields each
 * cell's supported mass (∫ supportedDensity over its area) and access-weighted
 * centroid. Cut placement re-scans only the splitting cell's neighborhood at
 * split time (splits are rare by design).
 *
 * Determinism: fixed global grid origin (0,0), steps derived from LATTICE_M at
 * a reference latitude (first station), samples visited per-station in input
 * order with index-dedupe, nearest-anchor ties broken by id.
 */
import type { Coordinate } from '../types/core';
import type { DirectionalAccess } from './opportunity';
import { haversine } from './geo';

const M_PER_DEG_LAT = 111194.9;

export interface LatticeDeps {
  accessAt(c: Coordinate): DirectionalAccess;
  isWater(c: Coordinate): boolean;
  /** People per m² the access level supports (densityFit.supportedDensityAt). */
  supportedDensity(access: number): number;
  /** Min distance (m) a cut must keep from every existing point. */
  spacingAt(access: number): number;
  /** Samples below this max(res, com) access are outside the lattice. */
  minAccess: number;
}

export interface AnchorIndex {
  nearest(c: Coordinate): { id: string; location: Coordinate } | null;
  /** All anchors within `radiusM` of `c`. */
  within(c: Coordinate, radiusM: number): { id: string; location: Coordinate }[];
}

/** Spatial grid over anchors; expanding-ring nearest with id tie-break. */
export function createAnchorIndex(
  anchors: { id: string; location: Coordinate }[],
): AnchorIndex {
  const CELL_M = 500;
  const refLat = anchors[0]?.location[1] ?? 0;
  const mPerLon = M_PER_DEG_LAT * Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
  const cellOf = (c: Coordinate): { cx: number; cy: number } => ({
    cx: Math.floor((c[0] * mPerLon) / CELL_M),
    cy: Math.floor((c[1] * M_PER_DEG_LAT) / CELL_M),
  });
  const grid = new Map<string, { id: string; location: Coordinate }[]>();
  for (const a of anchors) {
    const { cx, cy } = cellOf(a.location);
    const k = `${cx},${cy}`;
    const b = grid.get(k);
    if (b) b.push(a); else grid.set(k, [a]);
  }
  const ringHas = (cx: number, cy: number, r: number): boolean => {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (grid.has(`${cx + dx},${cy + dy}`)) return true;
      }
    }
    return false;
  };
  const scanRings = (c: Coordinate, maxRing: number): { id: string; location: Coordinate } | null => {
    const { cx, cy } = cellOf(c);
    let firstHit = -1;
    let best: { id: string; location: Coordinate } | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      if (firstHit >= 0 && r > firstHit + 1) break; // ring r+1 guard covers diagonal cases
      if (!ringHas(cx, cy, r)) continue;
      if (firstHit < 0) firstHit = r;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const a of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            const d = haversine(c, a.location);
            if (d < bestD || (d === bestD && best !== null && a.id < best.id)) {
              bestD = d;
              best = a;
            }
          }
        }
      }
    }
    return best;
  };
  return {
    nearest: (c) => (anchors.length === 0 ? null : scanRings(c, 4000)),
    within: (c, radiusM) => {
      const { cx, cy } = cellOf(c);
      const ring = Math.ceil(radiusM / CELL_M) + 1;
      const out: { id: string; location: Coordinate }[] = [];
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (const a of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (haversine(c, a.location) <= radiusM) out.push(a);
          }
        }
      }
      return out;
    },
  };
}

export interface CellIntegral {
  /** People the cell's access-positive area can support. */
  supportedMass: number;
  /** Access-weighted centroid of the cell, or null if it holds no samples. */
  centroid: Coordinate | null;
}

interface LatticeFrame {
  stepLon: number;
  stepLat: number;
}

function latticeFrame(latticeM: number, refLat: number): LatticeFrame {
  const mPerLon = M_PER_DEG_LAT * Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
  return { stepLon: latticeM / mPerLon, stepLat: latticeM / M_PER_DEG_LAT };
}

/** Visit each unique lattice sample within `radiusM` of any center, in order. */
function enumerateSamples(
  centers: Coordinate[],
  radiusM: number,
  latticeM: number,
  visit: (sample: Coordinate) => void,
): void {
  if (centers.length === 0) return;
  const frame = latticeFrame(latticeM, centers[0][1]);
  const seen = new Set<string>();
  for (const c of centers) {
    const i0 = Math.floor((c[0] - radiusM * frame.stepLon / latticeM) / frame.stepLon);
    const i1 = Math.ceil((c[0] + radiusM * frame.stepLon / latticeM) / frame.stepLon);
    const j0 = Math.floor((c[1] - radiusM * frame.stepLat / latticeM) / frame.stepLat);
    const j1 = Math.ceil((c[1] + radiusM * frame.stepLat / latticeM) / frame.stepLat);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = `${i},${j}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const sample: Coordinate = [(i + 0.5) * frame.stepLon, (j + 0.5) * frame.stepLat];
        if (haversine(sample, c) > radiusM) continue; // outside THIS center; another may claim it later
        visit(sample);
      }
    }
  }
}

export interface IntegrateOpts {
  anchors: { id: string; location: Coordinate }[];
  /** Routed-station coordinates — the lattice domain is their catchment union. */
  stations: Coordinate[];
  catchmentM: number;
  latticeM: number;
  deps: LatticeDeps;
}

export function integrateCells(opts: IntegrateOpts): Map<string, CellIntegral> {
  const { deps } = opts;
  const index = createAnchorIndex(opts.anchors);
  const cells = new Map<string, CellIntegral & { wSum: number; lonSum: number; latSum: number }>();
  const sampleArea = opts.latticeM * opts.latticeM;
  enumerateSamples(opts.stations, opts.catchmentM, opts.latticeM, (sample) => {
    const a = deps.accessAt(sample);
    const access = Math.max(a.res, a.com);
    if (access < deps.minAccess) return;
    const anchor = index.nearest(sample);
    if (!anchor) return;
    const density = deps.supportedDensity(access);
    let cell = cells.get(anchor.id);
    if (!cell) {
      cell = { supportedMass: 0, centroid: null, wSum: 0, lonSum: 0, latSum: 0 };
      cells.set(anchor.id, cell);
    }
    cell.supportedMass += density * sampleArea;
    cell.wSum += density;
    cell.lonSum += density * sample[0];
    cell.latSum += density * sample[1];
  });
  const out = new Map<string, CellIntegral>();
  for (const [id, c] of cells) {
    out.set(id, {
      supportedMass: c.supportedMass,
      centroid: c.wSum > 0 ? [c.lonSum / c.wSum, c.latSum / c.wSum] : null,
    });
  }
  return out;
}

export interface FindCutOpts {
  anchorId: string;
  centroid: Coordinate;
  anchors: { id: string; location: Coordinate }[];
  latticeM: number;
  deps: LatticeDeps;
}

/**
 * The cut location for a splitting cell: the valid lattice sample nearest the
 * access-weighted centroid. Valid = access ≥ minAccess, dry, inside the cell
 * (nearest anchor is the splitting anchor), and ≥ spacingAt(access) from every
 * existing point. Null when nothing qualifies (the cell cannot split yet).
 */
export function findCut(opts: FindCutOpts): Coordinate | null {
  const { deps } = opts;
  const index = createAnchorIndex(opts.anchors);
  const anchor = opts.anchors.find((a) => a.id === opts.anchorId);
  if (!anchor) return null;
  const spacingHint = deps.spacingAt(Math.max(
    deps.accessAt(opts.centroid).res, deps.accessAt(opts.centroid).com,
  ));
  const searchR = Math.max(
    3 * spacingHint,
    2 * haversine(anchor.location, opts.centroid),
    4 * opts.latticeM,
  );
  let best: Coordinate | null = null;
  let bestD = Infinity;
  enumerateSamples([opts.centroid], searchR, opts.latticeM, (sample) => {
    const a = deps.accessAt(sample);
    const access = Math.max(a.res, a.com);
    if (access < deps.minAccess) return;
    if (deps.isWater(sample)) return;
    if (index.nearest(sample)?.id !== opts.anchorId) return; // outside the cell
    const minDist = deps.spacingAt(access);
    for (const other of index.within(sample, minDist)) {
      if (haversine(sample, other.location) < minDist) return;
    }
    const d = haversine(sample, opts.centroid);
    if (d < bestD) { bestD = d; best = sample; }
  });
  return best;
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/model/lattice.test.ts`
Expected: 6 PASS. (If the single-anchor mass lands outside 2500–3800, check the sample-dedupe and the per-center radius filter — every in-disc sample must be visited exactly once.)

- [ ] **Step 5: Full suite + commit**

Run: `npx tsc --noEmit && npm test` — all PASS.

```bash
git add src/model/lattice.ts src/model/lattice.test.ts
git commit -m "feat: lattice cell integration and cut placement (no polygon geometry)"
```

---

### Task 3: Ledger — split-pressure cells (additive)

**Files:**
- Modify: `src/model/ledger.ts`
- Test: `src/model/ledger.test.ts` (append)

Additive only: `cells` accumulators + making `materialized[].siteId` optional. Legacy `sites`/`densify` handling stays until Task 7.

- [ ] **Step 1: Write the failing tests** — append to `src/model/ledger.test.ts`:

```ts
// --- Voronoi subdivision: split-pressure cells -------------------------------

test('serialize round-trips cells sparsely (zeros pruned)', () => {
  const led = newLedger();
  led.cells = { 'induced-pt:0': 1200, n1: 0 };
  const back = deserializeFromStore(serializeForStore(led));
  assert.deepEqual(back.cells, { 'induced-pt:0': 1200 });
});

test('materialized records without siteId round-trip and recreate', () => {
  const led = newLedger();
  led.pops['induced:0'] = { residenceId: 'induced-pt:0', jobId: 'induced-pt:0' };
  led.materialized = { 'induced-pt:0': { location: [1, 2] } };
  const back = deserializeFromStore(serializeForStore(led));
  assert.deepEqual(back.materialized, led.materialized);
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const r = recreateMaterializedPoints(dd, back);
  assert.equal(r.recreated, 1);
  assert.deepEqual(dd.points.get('induced-pt:0')!.location, [1, 2]);
});

test('clearAllInduced drops cells', () => {
  const dd: DemandData = { points: new Map(), popsMap: new Map() };
  const led = newLedger();
  led.cells = { x: 500 };
  const { ledger: fresh } = clearAllInduced(dd, led, DEFAULT_CONFIG);
  assert.equal(fresh.cells, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/model/ledger.test.ts`
Expected: FAIL — `cells` not serialized; `siteId` type error.

- [ ] **Step 3: Implement** in `src/model/ledger.ts`:

1. `LedgerState`: change `materialized` value type to `{ location: [number, number]; siteId?: string }` (siteId legacy-optional, no longer written) and add:

```ts
  /**
   * Split-pressure accumulators per Voronoi cell, keyed by anchor point id.
   * Sparse (nonzero only). Pressure accrues ∝ deficit × fill (spec 2026-07-18)
   * and a split consumes SPLIT_THRESHOLD.
   */
  cells?: Record<string, number>;
```

2. `serializeForStore` — after the `materialized` block:

```ts
  if (ledger.cells) {
    const cells: Record<string, number> = {};
    for (const [id, v] of Object.entries(ledger.cells)) if (v !== 0) cells[id] = v;
    if (Object.keys(cells).length > 0) payload.cells = cells;
  }
```

3. `deserializeFromStore` — after the `materialized` line:

```ts
    if (o.cells && typeof o.cells === 'object') led.cells = o.cells;
```

4. `clearAllInduced` — nothing to add: `fresh` is a `newLedger()` and `cells` is deliberately not carried (add the comment `// cells (split pressure) deliberately dropped with materialized/sites`).

- [ ] **Step 4: Verify + commit**

Run: `npx tsx --test src/model/ledger.test.ts && npx tsc --noEmit && npm test`
Expected: all PASS.

```bash
git add src/model/ledger.ts src/model/ledger.test.ts
git commit -m "feat: ledger split-pressure cells; materialized siteId now optional"
```

---

### Task 4: Engine — remove candidates, add the split step

**Files:**
- Modify: `src/model/engine.ts`
- Modify: `src/model/engine.test.ts`
- Modify: `src/main.ts` (compile bridge only)

The heart of the change. `runDay` operates on occupied sites only; a new section D applies split pressure and performs the day's splits. The old empty-candidate branch, lazy `materialize` during pairing, and the densify/saturation step are all removed.

- [ ] **Step 1: New `runDay`** — rewrite `src/model/engine.ts`'s interfaces and sections A/B/D (section C decay and the helpers `recordRemoval`/`expand`/`findInduced`/`bumpDelta` are unchanged; shown where they differ):

Replace `RunDayDeps` and `DayResult`:

```ts
export interface DayResult {
  added: number;
  removed: number;
  /** Cells split (points materialized) this day. */
  newPoints: number;
  deltas: Record<string, DayDelta>;
}

/** Injected field/fit context for one day (built by main.ts from the field state). */
export interface RunDayDeps {
  /** People cap for a materialized point at a given access. */
  massAt(access: number): number;
  /** Latest lattice integrals per anchor point id; null = lattice not ready (no splits). */
  cells: Map<string, CellIntegral> | null;
  /** Valid cut location for a splitting cell, or null (cell cannot split now). */
  findCut(anchorId: string, centroid: Coordinate): Coordinate | null;
}
```

with `import type { CellIntegral } from './lattice';` and the now-unused imports removed (`MODE_SHARE_FLOOR`, `creepDensify` — keep `creepDensify` import OUT; it is deleted in Task 7).

Section A becomes occupied-only (delete the entire `else` branch and the `satFilled`/`satCapacity` accounting; `densify` is gone — native caps are plain `cap(baseline, score, K_MAX)`):

```ts
  // A. accumulate pressure per point
  for (const s of sites) {
    if (!s.pointId) continue; // occupied-only field; defensive for stale lists
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
    const cR = isMat ? cfg.RES_SHARE * deps.massAt(s.accessRes) : cap(e.baselineResidents, sRes, cfg.K_MAX);
    const cJ = isMat ? cfg.JOB_SHARE * deps.massAt(s.accessCom) : cap(e.baselineJobs, sJob, cfg.K_MAX);
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
  }
```

Section B: delete `materialize`/`pointIdFor` entirely — pairing resolves ids directly (occupied sites: `site.id === site.pointId`):

```ts
    for (const [h, w] of pairByGravity(resPool, jobPool, locations, cfg, rng)) {
      const id = `${INDUCED_PREFIX}${ledger.seq}`;
      if (addInducedPop(dd, h, w, id, cfg, slots, driving)) {
        ledger.pops[id] = { residenceId: h, jobId: w };
        ledger.seq++;
        addedThisDay.add(id);
        const eh = ledger.points[h];
        const ew = ledger.points[w];
        if (eh) eh.resAccum = Math.max(0, eh.resAccum - cfg.POP_SIZE);
        if (ew) ew.jobAccum = Math.max(0, ew.jobAccum - cfg.POP_SIZE);
        bumpDelta(deltas, h, 'ar');
        bumpDelta(deltas, w, 'aj');
        added++;
      }
    }
```

(`remCapRes`/`remCapJob` keep their shape; the `current` reads are always from the point since every site is occupied.)

Replace section D (densify) with the split step, after decay:

```ts
  // D. Voronoi subdivision (spec 2026-07-18): split pressure accrues per cell
  // ∝ deficit × fill; the top cells at threshold split into a new point at a
  // valid sample near the access-weighted centroid. Slow by construction —
  // SPLIT_RATE/SPLIT_THRESHOLD/MAX_SPLITS_PER_DAY are the tuning knobs.
  let newPoints = 0;
  if (deps.cells) {
    if (!ledger.cells) ledger.cells = {};
    // prune pressure for anchors that no longer exist
    for (const id of Object.keys(ledger.cells)) {
      if (!dd.points.has(id)) delete ledger.cells[id];
    }
    const ready: { id: string; pressure: number; centroid: Coordinate }[] = [];
    for (const [id, integral] of deps.cells) {
      const p = dd.points.get(id);
      if (!p || !integral.centroid) continue;
      const capTotal = (capRes.get(id) ?? 0) + (capJob.get(id) ?? 0);
      if (capTotal <= 0) continue;
      const deficit = Math.max(0, integral.supportedMass - capTotal);
      const fill = Math.min(1, Math.max(0, (p.residents + p.jobs) / capTotal));
      const next = Math.min(
        cfg.SPLIT_THRESHOLD,
        (ledger.cells[id] ?? 0) + cfg.SPLIT_RATE * deficit * fill,
      );
      if (next !== 0) ledger.cells[id] = next; else delete ledger.cells[id];
      if (next >= cfg.SPLIT_THRESHOLD) ready.push({ id, pressure: next, centroid: integral.centroid });
    }
    ready.sort((a, b) => (b.pressure - a.pressure) || (a.id < b.id ? -1 : 1));
    for (const cell of ready.slice(0, cfg.MAX_SPLITS_PER_DAY)) {
      const cut = deps.findCut(cell.id, cell.centroid);
      if (!cut) continue; // pressure stays capped; retries when geometry/access changes
      const pid = `${INDUCED_POINT_PREFIX}${ledger.ptSeq ?? 0}`;
      ledger.ptSeq = (ledger.ptSeq ?? 0) + 1;
      createInducedPoint(dd, pid, cut);
      if (!ledger.materialized) ledger.materialized = {};
      ledger.materialized[pid] = { location: [cut[0], cut[1]] };
      ledger.points[pid] = { baselineResidents: 0, baselineJobs: 0, resAccum: 0, jobAccum: 0 };
      ledger.cells[cell.id] -= cfg.SPLIT_THRESHOLD;
      if (ledger.cells[cell.id] === 0) delete ledger.cells[cell.id];
      newPoints++;
    }
  }

  return { added, removed, newPoints, deltas };
```

Delete the `import { creepDensify } ...` line and the `densify` const.

- [ ] **Step 2: Migrate `engine.test.ts`.** The `candidate()` helper and every test built on empty sites is removed (empty-site pressure, "never decay below zero", the condensation-during-pairing test, densify creep). `DAY_DEPS` becomes:

```ts
const DAY_DEPS: RunDayDeps = {
  massAt: () => 2000,
  cells: null,
  findCut: () => null,
};
```

All surviving `runDay(...)` calls keep their shape (the deps object is the only change). Add the new split tests:

```ts
test('split: pressure accrues ∝ deficit × fill and splits at threshold', () => {
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  // Huge supported mass + full anchor → one day crosses a small threshold.
  const cfgFast = { ...DEFAULT_CONFIG, SPLIT_THRESHOLD: 1000, SPLIT_RATE: 1 };
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number] }]]);
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 1);
  const pid = 'induced-pt:0';
  assert.ok(dd.points.get(pid), 'point materialized at the cut');
  assert.deepEqual(dd.points.get(pid)!.location, [0.01, 0]);
  assert.ok(ledger.materialized?.[pid]);
  assert.equal(ledger.points[pid].baselineResidents, 0);
});

test('split: empty anchor (fill 0) never splits regardless of deficit', () => {
  const dd = makeDD([point('n1', 0, 0, 0, 0)]);
  dd.points.get('n1')!.residents = 0;
  dd.points.get('n1')!.jobs = 0;
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number] }]]);
  runDay(dd, sites, ledger, DEFAULT_CONFIG, makeRng(1), {
    massAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(ledger.cells?.n1 ?? 0, 0);
});

test('split: budget caps splits per day, highest pressure first', () => {
  const pts = [point('a', 0, 0, 1000, 1000), point('b', 0.1, 0, 1000, 1000),
    point('c', 0.2, 0, 1000, 1000), point('d', 0.3, 0, 1000, 1000)];
  const dd = makeDD(pts);
  const ledger = newLedger();
  ledger.cells = { a: 999, b: 999, c: 999, d: 999 };
  const sites = pts.map((p) => siteOf(dd.points.get(p.id)!, 0.8));
  const cfgFast = { ...DEFAULT_CONFIG, SPLIT_THRESHOLD: 1000, MAX_SPLITS_PER_DAY: 2 };
  const cells = new Map(pts.map((p) => [p.id,
    { supportedMass: 1e6, centroid: [p.location[0] + 0.01, 0] as [number, number] }]));
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massAt: () => 2000, cells, findCut: (_id, c) => c,
  });
  assert.equal(r.newPoints, 2);
});

test('split: findCut null leaves pressure capped, no point', () => {
  const dd = makeDD([point('n1', 0, 0, 1000, 1000)]);
  const ledger = newLedger();
  const sites = [siteOf(dd.points.get('n1')!, 0.8)];
  const cfgFast = { ...DEFAULT_CONFIG, SPLIT_THRESHOLD: 1000 };
  const cells = new Map([['n1', { supportedMass: 1e6, centroid: [0.01, 0] as [number, number] }]]);
  const r = runDay(dd, sites, ledger, cfgFast, makeRng(1), {
    massAt: () => 2000, cells, findCut: () => null,
  });
  assert.equal(r.newPoints, 0);
  assert.equal(ledger.cells?.n1, 1000); // capped at threshold, retries later
});
```

- [ ] **Step 3: main.ts compile bridge.** In the day loop, replace the `runDay` deps object with the temporary bridge (Task 6 wires the real lattice):

```ts
          {
            massAt: (a) => massAt(field.fit, a),
            cells: null,      // TEMPORARY (Task 4): lattice wired in Task 6
            findCut: () => null,
          },
```

and delete the now-unused `jitterDep` closure and the `jitterPosition`/`haversine` imports if unreferenced (grep first; `haversine` may have other uses).

- [ ] **Step 4: Verify + commit**

Run: `npx tsx --test src/model/engine.test.ts && npx tsc --noEmit && npm test`
Expected: all PASS (candidate tests removed, 4 split tests added).

```bash
git add src/model/engine.ts src/model/engine.test.ts src/main.ts
git commit -m "feat: engine splits Voronoi cells instead of growing candidates"
```

---

### Task 5: Field — point sites only; delete the sampler

**Files:**
- Modify: `src/model/field.ts`
- Modify: `src/model/field.test.ts`
- Delete: `src/model/sampler.ts`, `src/model/sampler.test.ts`

- [ ] **Step 1: Rewrite `field.ts`'s site building.** Delete `createSiteBuilder`, `buildSites`, `SiteBuilder`, `BuildSitesOpts`, `FieldDeps`, and the sampler imports. `Site.pointId` becomes non-nullable. Add:

```ts
export interface Site {
  /** The demand point's id (sites are exactly the live demand points). */
  id: string;
  pointId: string;
  location: Coordinate;
  accessRes: number;
  accessCom: number;
}

/** The site list is exactly the live demand points with cached access. */
export function buildPointSites(
  dd: DemandData,
  accessAt: (c: Coordinate) => DirectionalAccess,
): Site[] {
  const sites: Site[] = [];
  for (const p of dd.points.values()) {
    const a = accessAt(p.location);
    sites.push({ id: p.id, pointId: p.id, location: p.location, accessRes: a.res, accessCom: a.com });
  }
  return sites;
}
```

`refreshSiteAccess`, `computeStructuralHash`, `computeServiceHash` are unchanged.

- [ ] **Step 2: Rewrite `field.test.ts`**: drop every sampling test; keep/adjust the hash tests and `refreshSiteAccess`; add:

```ts
test('buildPointSites: one occupied site per demand point with cached access', () => {
  const data = dd([point('n1', 0.001, 0.001), point('n2', 0.5, 0.5)]);
  const sites = buildPointSites(data, (c) => (c[0] < 0.1 ? { res: 0.8, com: 0.6 } : { res: 0, com: 0 }));
  assert.equal(sites.length, 2);
  const s1 = sites.find((s) => s.id === 'n1')!;
  assert.equal(s1.pointId, 'n1');
  assert.equal(s1.accessRes, 0.8);
  assert.equal(sites.find((s) => s.id === 'n2')!.accessRes, 0);
});
```

- [ ] **Step 3: Delete the sampler**

```bash
git rm src/model/sampler.ts src/model/sampler.test.ts
```

- [ ] **Step 4: Fix remaining references.** `grep -rn "sampler\|jitterPosition\|createSpacingIndex\|buildSites\|createSiteBuilder" src/` — expected hits only in `main.ts` (imports + the Tier-1 builder loop) and `heatmap.ts` (`Site` import is type-only, fine). In `main.ts`: remove sampler imports; replace the chunked Phase B/C site-building with `const sites = buildPointSites(dd, (c) => weights.accessIdx.at(c));` (the chunk loop over the builder disappears — Task 6 re-adds chunking for the lattice instead); same one-liner in `rebuildFieldSync`.

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit && npm test`
Expected: all PASS.

```bash
git add src/model/field.ts src/model/field.test.ts src/main.ts
git commit -m "feat: sites are exactly the live demand points; drop blue-noise sampler"
```

---

### Task 6: main.ts — lattice in the rebuild, split deps in the day loop

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Session field state.** In `PersistentSession.field`, remove nothing yet; add:

```ts
      /** Latest lattice integrals per anchor point id; null until the pass runs. */
      cells: Map<string, CellIntegral> | null;
```

with `import { integrateCells, findCut, type CellIntegral } from './model/lattice';` and `import { supportedDensityAt } from './model/densityFit';`.

- [ ] **Step 2: Lattice deps helper** (near `prepareBuild`):

```ts
  function latticeDeps(
    accessIdx: AccessIndex,
    fit: DensityFit,
    water: WaterIndex | null,
  ): import('./model/lattice').LatticeDeps {
    return {
      accessAt: (c) => accessIdx.at(c),
      isWater: (c) => water?.isWater(c) ?? false,
      supportedDensity: (a) => supportedDensityAt(fit, a),
      spacingAt: (a) => spacingAt(fit, a),
      minAccess: DEFAULT_CONFIG.MIN_SITE_ACCESS,
    };
  }
```

- [ ] **Step 3: Tier 1 lattice phase.** In the chunked `rebuildField`, after the sites are built (Phase B), replace the old sampling Phase C with a chunked lattice pass — chunk by station batches:

```ts
    // Phase C: lattice integration. One integrateCells call over ALL stations
    // (its internal dedupe requires a single pass — batching stations would
    // double-count overlapping catchment edges). ~50-100ms in one chunk:
    // same budget class as the old sampling phase, amortized by the rebuild's
    // other yields; split into finer slices only if the perf line complains.
    const stationCoords = weights.stations
      .filter((s) => (s.routeIds?.length ?? 0) > 0)
      .map((s) => s.coords);
    const anchors = [...dd.points.values()].map((p) => ({ id: p.id, location: p.location }));
    const cells = integrateCells({
      anchors,
      stations: stationCoords,
      catchmentM: DEFAULT_CONFIG.CATCHMENT_SECONDS * DEFAULT_CONFIG.WALK_SPEED,
      latticeM: DEFAULT_CONFIG.LATTICE_M,
      deps: latticeDeps(weights.accessIdx, fit, water),
    });
    await yieldToLoop();
    if (stale()) return;
```

and include `cells` in the swapped `session.field = { ... , cells, ... }`. In `rebuildFieldSync`, run the same `integrateCells` call synchronously and store it. (Record the lattice duration in the tier1 perf info string: `` `${sites.length} sites, ${cells.size} cells, ...` ``.)

- [ ] **Step 4: Day-loop deps.** Replace the Task-4 bridge:

```ts
          {
            massAt: (a) => massAt(field.fit, a),
            cells: field.cells,
            findCut: (anchorId, centroid) => findCut({
              anchorId,
              centroid,
              anchors: [...dd.points.values()].map((p) => ({ id: p.id, location: p.location })),
              latticeM: DEFAULT_CONFIG.LATTICE_M,
              deps: latticeDeps(field.accessIdx, field.fit, field.water),
            }),
          },
```

- [ ] **Step 5: Post-split refresh.** After the day's `runDay` result handling, next to the existing `massDrift` update:

```ts
      if (result.newPoints > 0) {
        // New anchors reshape the tessellation; refresh in the background.
        scheduleFieldRebuild();
      }
```

(The rebuild also rebuilds the site list, which is how the new point starts receiving pops — one debounced 500 ms delay after the split day is fine.)

- [ ] **Step 6: Verify + build + commit**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all PASS; bundle installs.

```bash
git add src/main.ts
git commit -m "feat: wire lattice integrals and split deps into the day loop"
```

---

### Task 7: Cleanup — delete densify, legacy candidate fields, dead config

**Files:**
- Modify: `src/model/config.ts`, `src/model/densityFit.ts`, `src/model/densityFit.test.ts`, `src/model/ledger.ts`, `src/model/ledger.test.ts`

- [ ] **Step 1: Config.** Remove `J_FRAC`, `RHO_DENSIFY`, `SAT_THRESHOLD` from the interface and defaults. `grep -rn "J_FRAC\|RHO_DENSIFY\|SAT_THRESHOLD" src/` must show no remaining consumers (if any remain, fix them first — expected: none after Tasks 4–6).

- [ ] **Step 2: densityFit.** Delete `creepDensify` and its tests (the `creepDensify: grows only above threshold...` test block).

- [ ] **Step 3: Ledger.** Remove the `sites` and `densify` fields from `LedgerState`, their blocks in `serializeForStore` and `deserializeFromStore` (old payloads now drop them silently by construction), and the `ledger.sites`-consuming branch in `src/overlay/heatmap.ts`'s `rawValue` (pressure reads `ledger.points` only — sites are always occupied now):

```ts
function rawValue(s: Site, ledger: LedgerState, view: Exclude<HeatView, 'off'>, cfg: InducedDemandConfig): number {
  if (view === 'accessRes') return clamp01(s.accessRes);
  if (view === 'accessCom') return clamp01(s.accessCom);
  const e = ledger.points[s.pointId];
  return clamp01(Math.max(e?.resAccum ?? 0, e?.jobAccum ?? 0, 0) / cfg.POP_SIZE);
}
```

- [ ] **Step 4: Ledger tests.** Replace the old `sites`/`densify` round-trip assertions with silent-drop coverage:

```ts
test('legacy payloads: sites and densify are dropped silently', () => {
  const legacy = JSON.stringify({ seq: 3, pops: {}, accum: {}, sites: { x: [5, 0] }, densify: 1.2 });
  const led = deserializeFromStore(legacy);
  assert.equal((led as Record<string, unknown>).sites, undefined);
  assert.equal((led as Record<string, unknown>).densify, undefined);
  assert.equal(led.seq, 3);
});
```

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all PASS.

```bash
git add src/model/config.ts src/model/densityFit.ts src/model/densityFit.test.ts src/model/ledger.ts src/model/ledger.test.ts src/overlay/heatmap.ts
git commit -m "chore: remove densify machinery, candidate accumulators, dead config"
```

---

### Task 8: Heatmap — split pressure at prospective cuts

**Files:**
- Modify: `src/overlay/heatmap.ts`
- Modify: `src/overlay/heatmap.test.ts`
- Modify: `src/main.ts` (pass cuts)

- [ ] **Step 1: Write the failing test** — append to `src/overlay/heatmap.test.ts`:

```ts
test('pressure view: prospective cuts render with t = pressure/threshold', () => {
  const led = newLedger();
  led.points.a = { baselineResidents: 0, baselineJobs: 0, resAccum: 100, jobAccum: 0 };
  const cuts = [{ location: [3, 3] as [number, number], t: 0.6 }];
  const fc = buildHeatFeatures(sites, led, 'pressure', DEFAULT_CONFIG, cuts);
  const cut = fc.features.find((f) => f.properties.id === 'cut:0');
  assert.ok(cut, 'cut feature present');
  assert.equal(cut!.properties.t, 0.6);
  assert.deepEqual(cut!.geometry.coordinates, [3, 3]);
});

test('access views ignore cuts', () => {
  const cuts = [{ location: [3, 3] as [number, number], t: 0.6 }];
  const fc = buildHeatFeatures(sites, newLedger(), 'accessRes', DEFAULT_CONFIG, cuts);
  assert.ok(!fc.features.some((f) => f.properties.id.startsWith('cut:')));
});
```

- [ ] **Step 2: Implement.** `buildHeatFeatures` gains a trailing optional parameter and appends cut features in the pressure view:

```ts
export interface ProspectiveCut { location: [number, number]; t: number }

export function buildHeatFeatures(
  sites: Site[],
  ledger: LedgerState,
  view: Exclude<HeatView, 'off'>,
  cfg: InducedDemandConfig,
  cuts: ProspectiveCut[] = [],
): HeatFeatureCollection {
  // ... existing per-site loop unchanged ...
  if (view === 'pressure') {
    cuts.forEach((c, i) => {
      if (c.t < MIN_VALUE) return;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c.location },
        properties: { id: `cut:${i}`, t: clamp01(c.t) },
      });
      if (c.t > maxValue) maxValue = c.t;
    });
  }
  return { type: 'FeatureCollection', features, maxValue };
}
```

- [ ] **Step 3: main.ts.** In `doHeatmapRefresh`, build cuts from the field's cells + ledger pressure and pass them:

```ts
      const cuts = view !== 'pressure' || !f.cells ? [] : [...f.cells.entries()]
        .filter(([id, cell]) => cell.centroid && (ledger.cells?.[id] ?? 0) > 0)
        .map(([id, cell]) => ({
          location: [cell.centroid![0], cell.centroid![1]] as [number, number],
          t: (ledger.cells![id] ?? 0) / DEFAULT_CONFIG.SPLIT_THRESHOLD,
        }));
      const fc = buildHeatFeatures(f.sites, ledger, view, DEFAULT_CONFIG, cuts);
```

- [ ] **Step 4: Verify + commit**

Run: `npx tsx --test src/overlay/heatmap.test.ts && npx tsc --noEmit && npm test && npm run build`
Expected: all PASS.

```bash
git add src/overlay/heatmap.ts src/overlay/heatmap.test.ts src/main.ts
git commit -m "feat: pressure view shows split pressure at prospective cut locations"
```

---

### Task 9: Final verification

- [ ] **Step 1: Whole-tree gates**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: everything green; bundle installed. Confirm `grep -rn "sampler\|J_FRAC\|densify\|RHO_DENSIFY\|SAT_THRESHOLD\|ledger.sites" src/` returns nothing (case-sensitive; `densityFit` matches are fine).

- [ ] **Step 2: In-game verification checklist** (report results, don't assume):
  1. Day log: `newPts` stays 0 for many days after a fresh line (fill factor gating), then splits appear near the line — slowly (≤ `MAX_SPLITS_PER_DAY`).
  2. Pressure heat view shows building split pressure at prospective cut locations before points appear there.
  3. New split points receive pops on subsequent days (post-split rebuild refreshes the site list).
  4. Walking share of new induced pops drops vs. the candidate build (spot-check pop details near infill).
  5. Cold restart: split-created points recreate (`recreated N` log) with their pops; `ledger.cells` pressure survives.
  6. Perf lines: tier1 total in budget with the lattice phase; day loop under 50 ms on split days.
  7. Tune `SPLIT_RATE`/`SPLIT_THRESHOLD`/`MAX_SPLITS_PER_DAY` with the user if pacing feels off — do NOT bump any version.

- [ ] **Step 3: Update project memory** with implementation state per its conventions.

---

## Self-review notes (already applied)

- Spec coverage: three layers (T4/T6), lattice trick (T2), split dynamics incl. fill gating + budget + tie-break (T4), cut placement + validity (T2), engine simplification (T4/T5), persistence/migration (T3/T7), cadence/perf (T6), overlay (T8), config (T1/T7), testing (each task + T9).
- Type consistency: `CellIntegral` defined in T2, consumed by T4 deps and T6; `Site.pointId: string` tightened in T5 with heatmap updated in T7; `ProspectiveCut` in T8; `supportedDensityAt` T1 → T6 deps.
- Ordering: additive (T1–T3) → engine swap with bridge (T4) → deletions (T5, T7) — tree green at every boundary.
- Known accepted losses: pending candidate pressure from `ledger.sites` is dropped once at upgrade (spec-sanctioned); a split point starts receiving pops only after the debounced post-split rebuild (~next day).
