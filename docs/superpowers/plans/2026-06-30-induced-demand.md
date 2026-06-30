# Induced Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Subway Builder "Induced Demand" mod that, once per in-game day, grows residential and commercial demand near well-served stations by adding fixed-size (200-person) residence↔job commuter pops, keeping full residents↔jobs accounting.

**Architecture:** A pure-function model core (`src/model/*`) — geometry, access scoring, logistic growth, integer allocation, gravity pairing, pop factory, ledger — orchestrated by `engine.runDay()`, wired to the game via `src/main.ts` hooks. All math is unit-tested in isolation with `node:test`; the engine has an integration test over a mock `demandData`. The mod reads mode share + catchment, writes only demand (`residents`/`jobs`/pops).

**Tech Stack:** TypeScript, Vite (rolldown-vite, IIFE bundle → `dist/index.js`), `node:test` via `tsx`, `api.storage` for persistence. Mirrors the Improved Schematics mod's toolchain.

**Spec:** [docs/superpowers/specs/2026-06-30-induced-demand-model-design.md](../specs/2026-06-30-induced-demand-model-design.md). API reference: [docs/DEMAND_API.md](../../DEMAND_API.md).

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore` | Build/test tooling |
| `manifest.json`, `src/version.ts` | Mod metadata |
| `scripts/install.ts` | Postbuild copy into the game mods folder |
| `src/types/*.d.ts` | Game API types (already ported) |
| `src/model/config.ts` | `InducedDemandConfig` + `DEFAULT_CONFIG` |
| `src/model/util.ts` | `clamp`, `clamp01` |
| `src/model/geo.ts` | `haversine`, `walkSeconds` |
| `src/model/access.ts` | `access()` catchment-connectivity score |
| `src/model/score.ts` | `transitFraction`, `residentialScore`, `commercialScore` |
| `src/model/growth.ts` | `cap()`, `logisticDelta()` |
| `src/model/allocate.ts` | `reconcile()`, `allocateInteger()` |
| `src/model/gravity.ts` | `makeRng()`, `pairByGravity()` |
| `src/model/popFactory.ts` | `makeInducedPop`, `addInducedPop`, `removeInducedPop`, `isInduced` |
| `src/model/ledger.ts` | baseline capture, persistence, reconciliation |
| `src/model/engine.ts` | `runDay()` per-day orchestration |
| `src/main.ts` | hook wiring (entry; built to `dist/index.js`) |

> Naming note: the spec's "`index.ts` wiring module" is `src/main.ts` here (the Vite entry), matching the Improved Schematics convention; the built artifact is `dist/index.js` referenced by `manifest.main`.

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `manifest.json`, `src/version.ts`, `scripts/install.ts`

- [ ] **Step 1: Initialize git** (commits in later tasks require it)

Run: `git init`
Expected: `Initialized empty Git repository`

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "subwaybuilder-induced-demand",
  "version": "0.1.0",
  "description": "Models long-run transit-induced demand for Subway Builder",
  "main": "dist/index.js",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "postbuild": "tsx scripts/install.ts",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test \"src/**/*.test.ts\""
  },
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^25.0.9",
    "@types/react": "^19.2.9",
    "maplibre-gl": "^5.18.0",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3",
    "vite": "npm:rolldown-vite@latest",
    "vite-plugin-static-copy": "^3.0.0"
  }
}
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: Create `src/version.ts`**

```ts
export const MOD_VERSION = '0.1.0';
```

- [ ] **Step 6: Create `manifest.json`**

```json
{
  "id": "induced-demand",
  "name": "Induced Demand",
  "description": "Models long-run transit-induced demand: grows residential and commercial demand near well-served stations by adding commuter pops.",
  "version": "0.1.0",
  "author": { "name": "darkdiamond" },
  "main": "index.js",
  "dependencies": { "subway-builder": ">= 1.3.0" }
}
```

- [ ] **Step 7: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'path';
import { MOD_VERSION } from './src/version';

function syncVersion() {
  return {
    name: 'sync-mod-version',
    buildStart() {
      for (const file of ['manifest.json', 'package.json']) {
        const p = path.resolve(__dirname, file);
        const content = readFileSync(p, 'utf-8');
        const updated = content.replace(/("version":\s*)"[^"]*"/, `$1"${MOD_VERSION}"`);
        if (updated !== content) writeFileSync(p, updated);
      }
    },
  };
}

export default defineConfig({
  esbuild: { keepNames: true },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['iife'],
      name: 'SubwayInducedDemand',
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  },
  plugins: [
    syncVersion(),
    viteStaticCopy({ targets: [{ src: 'manifest.json', dest: '.' }] }),
  ],
});
```

- [ ] **Step 8: Create `scripts/install.ts`**

```ts
/** Copy dist/ into the game's mods folder. Runs after `build` via `postbuild`. */
import { existsSync, mkdirSync, rmSync, cpSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';

const MODS_PATHS: Record<string, string> = {
  darwin: `${process.env.HOME}/Library/Application Support/metro-maker4/mods`,
  win32: `${process.env.APPDATA}\\metro-maker4\\mods`,
  linux: `${process.env.HOME}/.config/metro-maker4/mods`,
};

function getModId(): string {
  const manifestPath = join(process.cwd(), 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const parts: string[] = manifest.id?.split('.') || [];
      return parts[parts.length - 1] || 'my-mod';
    } catch { /* fall through */ }
  }
  return 'my-mod';
}

const modsPath = MODS_PATHS[process.platform];
if (!modsPath) { console.error(`Unsupported platform: ${process.platform}`); process.exit(1); }
const distPath = join(process.cwd(), 'dist');
const targetPath = join(modsPath, getModId());
if (!existsSync(distPath)) { console.error('dist/ not found. Run build first.'); process.exit(1); }
if (!existsSync(modsPath)) mkdirSync(modsPath, { recursive: true });
if (existsSync(targetPath)) { lstatSync(targetPath); rmSync(targetPath, { recursive: true, force: true }); }
cpSync(distPath, targetPath, { recursive: true });
console.log(`Installed mod to: ${targetPath}`);
```

- [ ] **Step 9: Install dependencies**

Run: `npm install`
Expected: completes, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 10: Verify typecheck passes on the ported types**

Run: `npm run typecheck`
Expected: exits 0, no output (the `src/types/*.d.ts` resolve with `@types/react` + `maplibre-gl` installed).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold induced-demand mod (build, test, install tooling)"
```

---

## Task 2: Config and small utils

**Files:**
- Create: `src/model/config.ts`, `src/model/util.ts`, `src/model/util.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/util.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, clamp01 } from './util';
import { DEFAULT_CONFIG } from './config';

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test('clamp01 bounds to [0,1]', () => {
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(0.4), 0.4);
});

test('DEFAULT_CONFIG: pop size 200, decay slower than growth', () => {
  assert.equal(DEFAULT_CONFIG.POP_SIZE, 200);
  assert.ok(DEFAULT_CONFIG.R_DECAY < DEFAULT_CONFIG.R_GROW);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/util.test.ts`
Expected: FAIL — cannot find module `./util` / `./config`.

- [ ] **Step 3: Create `src/model/util.ts`**

```ts
export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
```

- [ ] **Step 4: Create `src/model/config.ts`**

```ts
export type ReconcileRule = 'average' | 'min' | 'residential' | 'commercial';

export interface InducedDemandConfig {
  /** People per pop — fixed game unit. */
  POP_SIZE: number;
  /** Max induced fraction at score=1 (cap = baseline*(1+K_MAX*score)). */
  K_MAX: number;
  /** Logistic growth rate per day. */
  R_GROW: number;
  /** Decay rate per day when over cap (slower than growth). */
  R_DECAY: number;
  /** Net-equal reconciliation rule for the daily pop count. */
  RECONCILE: ReconcileRule;
  /** Relocation fraction (0 = pure additive). */
  PHI: number;
  /** Max magnitude held in an accumulator (people). */
  ACCUM_CAP: number;
  /** Walk seconds beyond which a station is out of catchment. */
  CATCHMENT_SECONDS: number;
  /** Gaussian walk-time decay scale for access. */
  TAU_ACCESS: number;
  /** Distinct lines in catchment for full connectivity credit. */
  CONNECTIVITY_REF: number;
  /** Minimum access credit for a single-line point. */
  ACCESS_CONN_FLOOR: number;
  /** Walking speed (m/s) for access walk-time. */
  WALK_SPEED: number;
  /** Driving speed (m/s) for new-pop driving estimate. */
  DRIVE_SPEED: number;
  /** Straight-line -> road distance factor. */
  DETOUR_FACTOR: number;
  /** Gravity distance-decay exponent. */
  BETA: number;
  /** Gravity distance floor (m). */
  DIST_MIN: number;
  /** Default home departure time for a new pop (seconds into day). */
  DEFAULT_HOME_DEPART_SEC: number;
  /** Default work departure time for a new pop (seconds into day). */
  DEFAULT_WORK_DEPART_SEC: number;
}

export const DEFAULT_CONFIG: InducedDemandConfig = {
  POP_SIZE: 200,
  K_MAX: 1.0,
  R_GROW: 0.002,
  R_DECAY: 0.0008,
  RECONCILE: 'average',
  PHI: 0,
  ACCUM_CAP: 1000,
  CATCHMENT_SECONDS: 1800,
  TAU_ACCESS: 600,
  CONNECTIVITY_REF: 3,
  ACCESS_CONN_FLOOR: 0.5,
  WALK_SPEED: 1.0,
  DRIVE_SPEED: 11,
  DETOUR_FACTOR: 1.3,
  BETA: 2.0,
  DIST_MIN: 100,
  DEFAULT_HOME_DEPART_SEC: 8 * 3600,
  DEFAULT_WORK_DEPART_SEC: 17 * 3600,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/model/util.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(model): config constants and clamp utils"
```

---

## Task 3: Geometry (`geo.ts`)

**Files:**
- Create: `src/model/geo.ts`, `src/model/geo.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/geo.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, walkSeconds } from './geo';
import type { Coordinate } from '../types/core';

const O: Coordinate = [0, 0];

test('haversine: zero distance for same point', () => {
  assert.equal(haversine(O, O), 0);
});

test('haversine: ~111km per degree of latitude', () => {
  const d = haversine(O, [0, 1]);
  assert.ok(Math.abs(d - 111195) < 500, `got ${d}`);
});

test('walkSeconds: distance / speed', () => {
  const d = haversine(O, [0, 1]);
  assert.ok(Math.abs(walkSeconds(O, [0, 1], 1) - d) < 1e-6);
  assert.ok(Math.abs(walkSeconds(O, [0, 1], 2) - d / 2) < 1e-6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/geo.test.ts`
Expected: FAIL — cannot find module `./geo`.

- [ ] **Step 3: Create `src/model/geo.ts`**

```ts
import type { Coordinate } from '../types/core';

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters between two [lon, lat] points. */
export function haversine(a: Coordinate, b: Coordinate): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Walking time in seconds at `walkSpeed` m/s. */
export function walkSeconds(a: Coordinate, b: Coordinate, walkSpeed: number): number {
  return haversine(a, b) / walkSpeed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/geo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): haversine + walkSeconds geometry"
```

---

## Task 4: Access metric (`access.ts`)

**Files:**
- Create: `src/model/access.ts`, `src/model/access.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/access.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, type AccessStation } from './access';
import { DEFAULT_CONFIG } from './config';
import type { Coordinate } from '../types/core';

const P: Coordinate = [0, 0];

test('access: zero when no stations', () => {
  assert.equal(access(P, [], DEFAULT_CONFIG), 0);
});

test('access: zero when nearest station is beyond catchment', () => {
  const far: AccessStation = { coords: [0, 1], lineIds: ['r1'] }; // ~111km
  assert.equal(access(P, [far], DEFAULT_CONFIG), 0);
});

test('access: ~1 for an on-point station with 3+ lines', () => {
  const s: AccessStation = { coords: [0, 0], lineIds: ['r1', 'r2', 'r3'] };
  assert.ok(Math.abs(access(P, [s], DEFAULT_CONFIG) - 1) < 1e-9);
});

test('access: single-line on-point station uses the connectivity floor', () => {
  const s: AccessStation = { coords: [0, 0], lineIds: ['r1'] };
  // walkProx=1; connectivity=1/3; access = 0.5 + 0.5*(1/3)
  assert.ok(Math.abs(access(P, [s], DEFAULT_CONFIG) - (0.5 + 0.5 / 3)) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/access.test.ts`
Expected: FAIL — cannot find module `./access`.

- [ ] **Step 3: Create `src/model/access.ts`**

```ts
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import { walkSeconds } from './geo';

export interface AccessStation {
  coords: Coordinate;
  /** Distinct line/route ids serving this station. */
  lineIds: string[];
}

/**
 * Catchment-connectivity score in [0,1] for a demand point.
 * 0 when no station is within catchment (gates growth).
 */
export function access(
  pointLoc: Coordinate,
  stations: AccessStation[],
  cfg: InducedDemandConfig,
): number {
  let walkProx = 0;
  const lines = new Set<string>();
  for (const s of stations) {
    const t = walkSeconds(pointLoc, s.coords, cfg.WALK_SPEED);
    if (t > cfg.CATCHMENT_SECONDS) continue;
    const d = Math.exp(-((t / cfg.TAU_ACCESS) ** 2));
    if (d > walkProx) walkProx = d;
    for (const id of s.lineIds) lines.add(id);
  }
  if (walkProx === 0) return 0;
  const connectivity = Math.min(1, lines.size / cfg.CONNECTIVITY_REF);
  return walkProx * (cfg.ACCESS_CONN_FLOOR + (1 - cfg.ACCESS_CONN_FLOOR) * connectivity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/access.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): catchment-connectivity access metric"
```

---

## Task 5: Score (`score.ts`)

**Files:**
- Create: `src/model/score.ts`, `src/model/score.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/score.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/score.test.ts`
Expected: FAIL — cannot find module `./score`.

- [ ] **Step 3: Create `src/model/score.ts`**

```ts
import type { DemandPoint, ModeChoiceStats } from '../types/game-state';
import { clamp01 } from './util';

/** Transit share as a fraction in [0,1]. Works whether stats are counts or shares. */
export function transitFraction(m: ModeChoiceStats): number {
  const total = m.walking + m.driving + m.transit + m.unknown;
  return total > 0 ? m.transit / total : 0;
}

export function residentialScore(point: DemandPoint, accessValue: number): number {
  return clamp01(transitFraction(point.residentModeShare)) * accessValue;
}

export function commercialScore(point: DemandPoint, accessValue: number): number {
  return clamp01(transitFraction(point.workerModeShare)) * accessValue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/score.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): residential/commercial transit-attractiveness score"
```

---

## Task 6: Growth (`growth.ts`)

**Files:**
- Create: `src/model/growth.ts`, `src/model/growth.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/growth.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cap, logisticDelta } from './growth';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

test('cap scales baseline by (1 + K_MAX*score)', () => {
  assert.equal(cap(1000, 0.5, 1), 1500);
  assert.equal(cap(1000, 0, 1), 1000);
});

test('logisticDelta: positive below cap, zero at cap', () => {
  assert.ok(logisticDelta(1000, 1000, 1500, 0.5, cfg) > 0);
  assert.equal(logisticDelta(1000, 1500, 1500, 0.5, cfg), 0);
});

test('logisticDelta: no growth when score is 0 and under cap', () => {
  assert.equal(logisticDelta(1000, 1000, 1000, 0, cfg), 0);
});

test('logisticDelta: decays at R_DECAY when over cap, even at score 0', () => {
  // current 600 > cap 400 -> -R_DECAY*(600-400)
  assert.ok(Math.abs(logisticDelta(400, 600, 400, 0, cfg) - -cfg.R_DECAY * 200) < 1e-9);
});

test('logisticDelta: zero when cap is non-positive', () => {
  assert.equal(logisticDelta(0, 0, 0, 0.5, cfg), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/growth.test.ts`
Expected: FAIL — cannot find module `./growth`.

- [ ] **Step 3: Create `src/model/growth.ts`**

```ts
import type { InducedDemandConfig } from './config';

/** Per-point ceiling: baseline scaled by transit attractiveness. */
export function cap(baseline: number, score: number, kMax: number): number {
  return baseline * (1 + kMax * score);
}

/**
 * One day's signed pressure for a side.
 * Below cap: logistic growth (scaled by score). Above cap: slow decay
 * proportional to the overshoot, independent of score.
 */
export function logisticDelta(
  baseline: number,
  current: number,
  capValue: number,
  score: number,
  cfg: InducedDemandConfig,
): number {
  if (capValue <= 0) return 0;
  if (current <= capValue) {
    return cfg.R_GROW * score * current * (1 - current / capValue);
  }
  return -cfg.R_DECAY * (current - capValue);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/growth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): logistic growth + over-cap decay"
```

---

## Task 7: Allocation (`allocate.ts`)

**Files:**
- Create: `src/model/allocate.ts`, `src/model/allocate.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/allocate.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, allocateInteger } from './allocate';

test('reconcile rules', () => {
  assert.equal(reconcile(10, 20, 'average'), 15);
  assert.equal(reconcile(10, 20, 'min'), 10);
  assert.equal(reconcile(10, 20, 'residential'), 10);
  assert.equal(reconcile(10, 20, 'commercial'), 20);
});

test('allocateInteger: proportional, sums to total', () => {
  assert.deepEqual(allocateInteger([1, 1], 4, [10, 10]), [2, 2]);
  assert.deepEqual(allocateInteger([3, 1], 4, [10, 10]), [3, 1]);
});

test('allocateInteger: respects per-point caps', () => {
  assert.deepEqual(allocateInteger([1, 1], 10, [2, 2]), [2, 2]); // capped to 4 total
});

test('allocateInteger: zero weights -> zeros', () => {
  assert.deepEqual(allocateInteger([0, 0], 5, [3, 3]), [0, 0]);
});

test('allocateInteger: distributes remainder by largest fraction', () => {
  // ideal [1.5, 1.5] for total 3 -> floors [1,1], one leftover to first by tie/order
  const r = allocateInteger([1, 1], 3, [9, 9]);
  assert.equal(r[0] + r[1], 3);
  assert.ok(Math.abs(r[0] - r[1]) === 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/allocate.test.ts`
Expected: FAIL — cannot find module `./allocate`.

- [ ] **Step 3: Create `src/model/allocate.ts`**

```ts
import type { ReconcileRule } from './config';

/** Reconcile residential vs commercial pressure into one common total. */
export function reconcile(rp: number, jp: number, rule: ReconcileRule): number {
  switch (rule) {
    case 'min': return Math.min(rp, jp);
    case 'residential': return rp;
    case 'commercial': return jp;
    case 'average':
    default: return (rp + jp) / 2;
  }
}

/**
 * Largest-remainder apportionment of `total` integer units across indices,
 * proportional to non-negative `weights`, capped per index by `perPointMax`.
 * Result sums to min(total, sum(perPointMax)).
 */
export function allocateInteger(
  weights: number[],
  total: number,
  perPointMax: number[],
): number[] {
  const n = weights.length;
  const result = new Array<number>(n).fill(0);
  const caps = perPointMax.map((c) => Math.max(0, Math.floor(c)));
  const capSum = caps.reduce((a, b) => a + b, 0);
  const remaining = Math.min(Math.max(0, Math.floor(total)), capSum);
  const w = weights.map((x) => Math.max(0, x));
  const wSum = w.reduce((a, b) => a + b, 0);
  if (remaining <= 0 || wSum <= 0) return result;

  const frac: { i: number; f: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ideal = (remaining * w[i]) / wSum;
    result[i] = Math.min(Math.floor(ideal), caps[i]);
    frac.push({ i, f: ideal - Math.floor(ideal) });
  }
  let leftover = remaining - result.reduce((a, b) => a + b, 0);
  frac.sort((a, b) => b.f - a.f);
  while (leftover > 0) {
    let placed = false;
    for (const { i } of frac) {
      if (result[i] < caps[i]) {
        result[i]++; leftover--; placed = true;
        if (leftover === 0) break;
      }
    }
    if (!placed) break;
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/allocate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): reconcile + capped largest-remainder allocation"
```

---

## Task 8: Gravity pairing (`gravity.ts`)

**Files:**
- Create: `src/model/gravity.ts`, `src/model/gravity.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/gravity.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, pairByGravity } from './gravity';
import { DEFAULT_CONFIG } from './config';
import type { Coordinate } from '../types/core';

test('makeRng is deterministic for a seed', () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('pairByGravity pairs each residence with the overwhelmingly nearer job', () => {
  const loc = new Map<string, Coordinate>([
    ['H', [0, 0]],
    ['near', [0, 0.001]], // ~111m
    ['far', [0, 5]],      // ~555km, negligible weight
  ]);
  const pairs = pairByGravity(['H'], ['near', 'far'], loc, DEFAULT_CONFIG, makeRng(1));
  assert.deepEqual(pairs, [['H', 'near']]);
});

test('pairByGravity returns min(pool) pairs and consumes jobs once', () => {
  const loc = new Map<string, Coordinate>([
    ['H1', [0, 0]], ['H2', [0, 0]], ['W', [0, 0.001]],
  ]);
  const pairs = pairByGravity(['H1', 'H2'], ['W'], loc, DEFAULT_CONFIG, makeRng(1));
  assert.equal(pairs.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/gravity.test.ts`
Expected: FAIL — cannot find module `./gravity`.

- [ ] **Step 3: Create `src/model/gravity.ts`**

```ts
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

/** Deterministic mulberry32 PRNG in [0,1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pair each residence id with a job id drawn (without replacement) with
 * probability ∝ 1 / dist^BETA. Returns min(pool lengths) [residence, job] pairs.
 */
export function pairByGravity(
  residencePool: string[],
  jobPool: string[],
  locations: Map<string, Coordinate>,
  cfg: InducedDemandConfig,
  rng: () => number,
): [string, string][] {
  const jobs = [...jobPool];
  const pairs: [string, string][] = [];
  for (const h of residencePool) {
    if (jobs.length === 0) break;
    const hLoc = locations.get(h);
    if (!hLoc) continue;
    const weights = jobs.map((w) => {
      const wLoc = locations.get(w);
      if (!wLoc) return 0;
      const d = Math.max(cfg.DIST_MIN, haversine(hLoc, wLoc));
      return 1 / Math.pow(d, cfg.BETA);
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    let idx = 0;
    if (sum > 0) {
      let r = rng() * sum;
      for (; idx < weights.length; idx++) {
        r -= weights[idx];
        if (r <= 0) break;
      }
      if (idx >= jobs.length) idx = jobs.length - 1;
    }
    pairs.push([h, jobs[idx]]);
    jobs.splice(idx, 1);
  }
  return pairs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/gravity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): seeded RNG + gravity pairing"
```

---

## Task 9: Pop factory (`popFactory.ts`)

**Files:**
- Create: `src/model/popFactory.ts`, `src/model/popFactory.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/popFactory.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInduced, addInducedPop, removeInducedPop } from './popFactory';
import { DEFAULT_CONFIG } from './config';
import type { DemandData, DemandPoint } from '../types/game-state';

function point(id: string): DemandPoint {
  return {
    id, location: id === 'H' ? [0, 0] : [0, 0.01], jobs: 0, residents: 0, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}
function demand(): DemandData {
  const points = new Map<string, DemandPoint>([['H', point('H')], ['W', point('W')]]);
  return { points, popsMap: new Map() };
}

test('isInduced detects our prefix', () => {
  assert.equal(isInduced('induced:1'), true);
  assert.equal(isInduced('base-42'), false);
});

test('addInducedPop adds 200 residents/jobs and links both endpoints', () => {
  const dd = demand();
  const ok = addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  assert.equal(ok, true);
  assert.equal(dd.points.get('H')!.residents, 200);
  assert.equal(dd.points.get('W')!.jobs, 200);
  assert.equal(dd.points.get('H')!.jobs, 0);
  assert.equal(dd.points.get('W')!.residents, 0);
  assert.deepEqual(dd.points.get('H')!.popIds, ['induced:1']);
  assert.deepEqual(dd.points.get('W')!.popIds, ['induced:1']);
  const pop = dd.popsMap.get('induced:1')!;
  assert.equal(pop.size, 200);
  assert.equal(pop.residenceId, 'H');
  assert.equal(pop.jobId, 'W');
});

test('removeInducedPop reverses the add exactly', () => {
  const dd = demand();
  addInducedPop(dd, 'H', 'W', 'induced:1', DEFAULT_CONFIG);
  const ok = removeInducedPop(dd, 'induced:1', DEFAULT_CONFIG);
  assert.equal(ok, true);
  assert.equal(dd.points.get('H')!.residents, 0);
  assert.equal(dd.points.get('W')!.jobs, 0);
  assert.deepEqual(dd.points.get('H')!.popIds, []);
  assert.deepEqual(dd.points.get('W')!.popIds, []);
  assert.equal(dd.popsMap.size, 0);
});

test('removeInducedPop refuses non-induced ids', () => {
  const dd = demand();
  dd.popsMap.set('base-1', { id: 'base-1', size: 200, residenceId: 'H', jobId: 'W' } as never);
  assert.equal(removeInducedPop(dd, 'base-1', DEFAULT_CONFIG), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/popFactory.test.ts`
Expected: FAIL — cannot find module `./popFactory`.

- [ ] **Step 3: Create `src/model/popFactory.ts`**

```ts
import type { Coordinate } from '../types/core';
import type { DemandData, Pop } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

export const INDUCED_PREFIX = 'induced:';

export function isInduced(popId: string): boolean {
  return popId.startsWith(INDUCED_PREFIX);
}

/**
 * Build a 200-person induced pop. `lastCommute` and `drivingPath` are left for
 * the game sim to populate (see spec §13.4), so we cast the literal to Pop.
 */
export function makeInducedPop(
  id: string,
  residenceId: string,
  jobId: string,
  resLoc: Coordinate,
  jobLoc: Coordinate,
  cfg: InducedDemandConfig,
): Pop {
  const drivingDistance = haversine(resLoc, jobLoc) * cfg.DETOUR_FACTOR;
  return {
    id,
    size: cfg.POP_SIZE,
    residenceId,
    jobId,
    drivingDistance,
    drivingSeconds: drivingDistance / cfg.DRIVE_SPEED,
    homeDepartureTime: cfg.DEFAULT_HOME_DEPART_SEC,
    workDepartureTime: cfg.DEFAULT_WORK_DEPART_SEC,
  } as Pop;
}

/** Add one induced pop; +POP_SIZE residents at residence, +POP_SIZE jobs at job. */
export function addInducedPop(
  dd: DemandData,
  residenceId: string,
  jobId: string,
  id: string,
  cfg: InducedDemandConfig,
): boolean {
  const res = dd.points.get(residenceId);
  const job = dd.points.get(jobId);
  if (!res || !job) return false;
  dd.popsMap.set(id, makeInducedPop(id, residenceId, jobId, res.location, job.location, cfg));
  res.popIds.push(id);
  job.popIds.push(id);
  res.residents += cfg.POP_SIZE;
  job.jobs += cfg.POP_SIZE;
  return true;
}

/** Remove an induced pop, reversing its residents/jobs/popIds effects. */
export function removeInducedPop(dd: DemandData, id: string, cfg: InducedDemandConfig): boolean {
  if (!isInduced(id)) return false;
  const pop = dd.popsMap.get(id);
  if (!pop) return false;
  const res = dd.points.get(pop.residenceId);
  const job = dd.points.get(pop.jobId);
  if (res) { res.residents -= cfg.POP_SIZE; dropId(res.popIds, id); }
  if (job) { job.jobs -= cfg.POP_SIZE; dropId(job.popIds, id); }
  dd.popsMap.delete(id);
  return true;
}

function dropId(arr: string[], id: string): void {
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/popFactory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): induced pop factory (add/remove with accounting)"
```

---

## Task 10: Ledger (`ledger.ts`)

**Files:**
- Create: `src/model/ledger.ts`, `src/model/ledger.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/ledger.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newLedger, captureBaselines, reconcileBaselines,
  serialize, deserialize, loadLedger, saveLedger, type ModStorage,
} from './ledger';
import type { DemandData, DemandPoint, Pop } from '../types/game-state';

function point(id: string, residents: number, jobs: number, popIds: string[] = []): DemandPoint {
  return {
    id, location: [0, 0], residents, jobs, popIds,
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

test('captureBaselines records new points once and does not overwrite', () => {
  const dd: DemandData = { points: new Map([['p', point('p', 400, 100)]]), popsMap: new Map() };
  const led = newLedger();
  captureBaselines(dd, led);
  led.points['p'].resAccum = 5;
  dd.points.get('p')!.residents = 999;
  captureBaselines(dd, led); // no-op for existing
  assert.equal(led.points['p'].baselineResidents, 400);
  assert.equal(led.points['p'].resAccum, 5);
});

test('serialize/deserialize round-trips', () => {
  const led = newLedger();
  led.points['p'] = { baselineResidents: 1, baselineJobs: 2, resAccum: 3, jobAccum: 4 };
  led.seq = 7;
  const back = deserialize(serialize(led));
  assert.deepEqual(back, led);
});

test('deserialize tolerates empty/garbage', () => {
  assert.deepEqual(deserialize(''), newLedger());
  assert.deepEqual(deserialize('not json'), newLedger());
});

test('reconcileBaselines recovers baseline = current - induced', () => {
  const pop: Pop = { id: 'induced:1', size: 200, residenceId: 'p', jobId: 'p' } as Pop;
  const dd: DemandData = {
    points: new Map([['p', point('p', 600, 200, ['induced:1'])]]),
    popsMap: new Map([['induced:1', pop]]),
  };
  const led = newLedger();
  reconcileBaselines(dd, led);
  assert.equal(led.points['p'].baselineResidents, 400); // 600 - 200
  assert.equal(led.points['p'].baselineJobs, 0);        // 200 - 200
});

test('loadLedger/saveLedger via a fake storage', async () => {
  const store = new Map<string, unknown>();
  const storage: ModStorage = {
    async get<T>(k: string, def?: T) { return (store.has(k) ? (store.get(k) as T) : (def as T)); },
    async set(k: string, v: unknown) { store.set(k, v); },
  };
  const led = newLedger();
  led.seq = 3;
  await saveLedger(storage, 'sea:save1', led);
  const back = await loadLedger(storage, 'sea:save1');
  assert.equal(back.seq, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/ledger.test.ts`
Expected: FAIL — cannot find module `./ledger`.

- [ ] **Step 3: Create `src/model/ledger.ts`**

```ts
import type { DemandData } from '../types/game-state';
import { INDUCED_PREFIX } from './popFactory';

export interface PointLedger {
  baselineResidents: number;
  baselineJobs: number;
  resAccum: number;
  jobAccum: number;
}

export interface LedgerState {
  points: Record<string, PointLedger>;
  /** Monotonic counter for induced pop ids. */
  seq: number;
}

/** Minimal slice of `api.storage` we depend on (keeps ledger testable). */
export interface ModStorage {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
}

export function newLedger(): LedgerState {
  return { points: {}, seq: 0 };
}

/** Record baselines for points not yet in the ledger. Never overwrites. */
export function captureBaselines(dd: DemandData, ledger: LedgerState): void {
  for (const p of dd.points.values()) {
    if (!ledger.points[p.id]) {
      ledger.points[p.id] = {
        baselineResidents: p.residents,
        baselineJobs: p.jobs,
        resAccum: 0,
        jobAccum: 0,
      };
    }
  }
}

/**
 * Self-heal: when a save already contains induced pops but the ledger is
 * missing (e.g. storage cleared), recover baseline = current − induced.
 */
export function reconcileBaselines(dd: DemandData, ledger: LedgerState): void {
  const indRes: Record<string, number> = {};
  const indJob: Record<string, number> = {};
  for (const pop of dd.popsMap.values()) {
    if (!pop.id.startsWith(INDUCED_PREFIX)) continue;
    indRes[pop.residenceId] = (indRes[pop.residenceId] ?? 0) + pop.size;
    indJob[pop.jobId] = (indJob[pop.jobId] ?? 0) + pop.size;
  }
  for (const p of dd.points.values()) {
    if (!ledger.points[p.id]) {
      ledger.points[p.id] = {
        baselineResidents: p.residents - (indRes[p.id] ?? 0),
        baselineJobs: p.jobs - (indJob[p.id] ?? 0),
        resAccum: 0,
        jobAccum: 0,
      };
    }
  }
}

export function serialize(ledger: LedgerState): string {
  return JSON.stringify(ledger);
}

export function deserialize(s: string | null | undefined): LedgerState {
  if (!s) return newLedger();
  try {
    const o = JSON.parse(s);
    return { points: o.points ?? {}, seq: typeof o.seq === 'number' ? o.seq : 0 };
  } catch {
    return newLedger();
  }
}

export async function loadLedger(storage: ModStorage, key: string): Promise<LedgerState> {
  const raw = await storage.get<string>(key, '');
  return deserialize(raw);
}

export async function saveLedger(storage: ModStorage, key: string, ledger: LedgerState): Promise<void> {
  await storage.set(key, serialize(ledger));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/ledger.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(model): ledger (baselines, persistence, self-heal)"
```

---

## Task 11: Engine (`engine.ts`)

**Files:**
- Create: `src/model/engine.ts`, `src/model/engine.test.ts`

- [ ] **Step 1: Write the failing test** — `src/model/engine.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDay } from './engine';
import { newLedger, captureBaselines, type LedgerState } from './ledger';
import { isInduced } from './popFactory';
import { makeRng } from './gravity';
import { DEFAULT_CONFIG, type InducedDemandConfig } from './config';
import type { DemandData, DemandPoint, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';

const ms = (transit: number) => ({ walking: 0, driving: 100 - transit, transit, unknown: 0 });
function point(id: string, loc: Coordinate, residents: number, jobs: number, rt: number, wt: number): DemandPoint {
  return { id, location: loc, residents, jobs, popIds: [], residentModeShare: ms(rt), workerModeShare: ms(wt) };
}
function station(id: string, coords: Coordinate, routeIds: string[]): Station {
  return { id, coords, routeIds } as unknown as Station;
}
function world(): DemandData {
  const points = new Map<string, DemandPoint>([
    ['H', point('H', [0, 0], 400, 0, 50, 0)],          // residential, transit-heavy
    ['W', point('W', [0, 0.001], 0, 400, 0, 50)],      // commercial, transit-heavy
    ['Z', point('Z', [1, 1], 400, 400, 50, 50)],       // far from transit
  ]);
  return { points, popsMap: new Map() };
}

// Faster convergence for the test; same shapes as DEFAULT_CONFIG.
const cfg: InducedDemandConfig = { ...DEFAULT_CONFIG, R_GROW: 0.05, R_DECAY: 0.02 };

function inducedResidentsAt(dd: DemandData, id: string): number {
  let n = 0;
  for (const pop of dd.popsMap.values()) if (isInduced(pop.id) && pop.residenceId === id) n += pop.size;
  return n;
}
function inducedJobsAt(dd: DemandData, id: string): number {
  let n = 0;
  for (const pop of dd.popsMap.values()) if (isInduced(pop.id) && pop.jobId === id) n += pop.size;
  return n;
}

test('engine grows residents at served home points and jobs at served job points', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const stations = [station('s', [0, 0], ['r1', 'r2', 'r3'])];
  let added = 0;
  for (let day = 0; day < 400; day++) added += runDay(dd, stations, led, cfg, makeRng(day)).added;

  // H residential cap = 400*(1+0.5) = 600; W commercial cap = 600.
  assert.equal(dd.points.get('H')!.residents, 600);
  assert.equal(dd.points.get('W')!.jobs, 600);
  // No spurious growth on the unconnected point.
  assert.equal(dd.points.get('Z')!.residents, 400);
  assert.equal(dd.points.get('Z')!.jobs, 400);
  // Delta accounting: residents delta == 200 * induced resident-pops; net-equal residents/jobs added.
  assert.equal(dd.points.get('H')!.residents - led.points['H'].baselineResidents, inducedResidentsAt(dd, 'H'));
  assert.equal(dd.points.get('W')!.jobs - led.points['W'].baselineJobs, inducedJobsAt(dd, 'W'));
  let totalRes = 0, totalJob = 0;
  for (const pop of dd.popsMap.values()) if (isInduced(pop.id)) { totalRes += pop.size; totalJob += pop.size; }
  assert.equal(totalRes, totalJob);
  // Every induced pop is exactly POP_SIZE.
  for (const pop of dd.popsMap.values()) if (isInduced(pop.id)) assert.equal(pop.size, 200);
  assert.ok(added >= 1);
});

test('engine decays induced demand when the station is removed, never below baseline', () => {
  const dd = world();
  const led: LedgerState = newLedger();
  captureBaselines(dd, led);
  const stations = [station('s', [0, 0], ['r1', 'r2', 'r3'])];
  for (let day = 0; day < 400; day++) runDay(dd, stations, led, cfg, makeRng(day));
  assert.equal(dd.points.get('H')!.residents, 600);

  // Remove all transit; access -> 0 -> caps fall to baseline -> decay.
  for (let day = 0; day < 400; day++) runDay(dd, [], led, cfg, makeRng(1000 + day));
  assert.equal(dd.points.get('H')!.residents, 400);
  assert.equal(dd.points.get('W')!.jobs, 400);
  for (const pop of dd.popsMap.values()) assert.equal(isInduced(pop.id), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/model/engine.test.ts`
Expected: FAIL — cannot find module `./engine`.

- [ ] **Step 3: Create `src/model/engine.ts`**

```ts
import type { DemandData, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import type { LedgerState } from './ledger';
import { access, type AccessStation } from './access';
import { residentialScore, commercialScore } from './score';
import { cap, logisticDelta } from './growth';
import { reconcile, allocateInteger } from './allocate';
import { pairByGravity } from './gravity';
import { addInducedPop, removeInducedPop, INDUCED_PREFIX } from './popFactory';
import { clamp } from './util';

export interface DayResult {
  added: number;
  removed: number;
}

/** Advance the induced-demand model one in-game day, mutating `dd` and `ledger`. */
export function runDay(
  dd: DemandData,
  stations: Station[],
  ledger: LedgerState,
  cfg: InducedDemandConfig,
  rng: () => number,
): DayResult {
  const points = [...dd.points.values()];
  const accessStations: AccessStation[] = stations.map((s) => ({
    coords: s.coords,
    lineIds: s.routeIds ?? [],
  }));
  const locations = new Map<string, Coordinate>();
  for (const p of points) locations.set(p.id, p.location);
  const capRes = new Map<string, number>();
  const capJob = new Map<string, number>();
  const scoreSum = new Map<string, number>();

  // A. accumulate pressure
  for (const p of points) {
    let e = ledger.points[p.id];
    if (!e) {
      e = ledger.points[p.id] = {
        baselineResidents: p.residents,
        baselineJobs: p.jobs,
        resAccum: 0,
        jobAccum: 0,
      };
    }
    const a = access(p.location, accessStations, cfg);
    const sRes = residentialScore(p, a);
    const sJob = commercialScore(p, a);
    const cR = cap(e.baselineResidents, sRes, cfg.K_MAX);
    const cJ = cap(e.baselineJobs, sJob, cfg.K_MAX);
    capRes.set(p.id, cR);
    capJob.set(p.id, cJ);
    scoreSum.set(p.id, sRes + sJob);
    e.resAccum = clamp(
      e.resAccum + logisticDelta(e.baselineResidents, p.residents, cR, sRes, cfg),
      -cfg.ACCUM_CAP,
      cfg.ACCUM_CAP,
    );
    e.jobAccum = clamp(
      e.jobAccum + logisticDelta(e.baselineJobs, p.jobs, cJ, sJob, cfg),
      -cfg.ACCUM_CAP,
      cfg.ACCUM_CAP,
    );
  }

  // B. optional relocation: trim growth pressure at the lowest-score points
  if (cfg.PHI > 0) applyRelocation(points, ledger, scoreSum, cfg);

  // C. growth — net-equal, cap-respecting, gravity-paired
  let added = 0;
  const ids = points.map((p) => p.id);
  const resWeights = points.map((p) => Math.max(0, ledger.points[p.id].resAccum));
  const jobWeights = points.map((p) => Math.max(0, ledger.points[p.id].jobAccum));
  const rp = resWeights.reduce((a, b) => a + b, 0);
  const jp = jobWeights.reduce((a, b) => a + b, 0);
  const N = Math.floor(reconcile(rp, jp, cfg.RECONCILE) / cfg.POP_SIZE);
  if (N > 0) {
    const remCapRes = points.map((p) =>
      Math.max(0, Math.floor((capRes.get(p.id)! - p.residents) / cfg.POP_SIZE)),
    );
    const remCapJob = points.map((p) =>
      Math.max(0, Math.floor((capJob.get(p.id)! - p.jobs) / cfg.POP_SIZE)),
    );
    const resPool = expand(ids, allocateInteger(resWeights, N, remCapRes));
    const jobPool = expand(ids, allocateInteger(jobWeights, N, remCapJob));
    for (const [h, w] of pairByGravity(resPool, jobPool, locations, cfg, rng)) {
      const id = `${INDUCED_PREFIX}${ledger.seq++}`;
      if (addInducedPop(dd, h, w, id, cfg)) {
        ledger.points[h].resAccum = Math.max(0, ledger.points[h].resAccum - cfg.POP_SIZE);
        ledger.points[w].jobAccum = Math.max(0, ledger.points[w].jobAccum - cfg.POP_SIZE);
        added++;
      }
    }
  }

  // D. decay (rare) — gradual removal of induced pops while accumulator is below −POP_SIZE
  let removed = 0;
  for (const p of points) {
    const e = ledger.points[p.id];
    while (e.resAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, p.id, 'residence');
      if (!id) { e.resAccum = -cfg.POP_SIZE + 1; break; }
      removeInducedPop(dd, id, cfg);
      e.resAccum += cfg.POP_SIZE;
      removed++;
    }
    while (e.jobAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, p.id, 'job');
      if (!id) { e.jobAccum = -cfg.POP_SIZE + 1; break; }
      removeInducedPop(dd, id, cfg);
      e.jobAccum += cfg.POP_SIZE;
      removed++;
    }
  }

  return { added, removed };
}

function expand(ids: string[], slots: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) for (let k = 0; k < slots[i]; k++) out.push(ids[i]);
  return out;
}

function findInduced(dd: DemandData, pointId: string, side: 'residence' | 'job'): string | null {
  const p = dd.points.get(pointId);
  if (!p) return null;
  for (let i = p.popIds.length - 1; i >= 0; i--) {
    const id = p.popIds[i];
    if (!id.startsWith(INDUCED_PREFIX)) continue;
    const pop = dd.popsMap.get(id);
    if (!pop) continue;
    if (side === 'residence' && pop.residenceId === pointId) return id;
    if (side === 'job' && pop.jobId === pointId) return id;
  }
  return null;
}

function applyRelocation(
  points: { id: string }[],
  ledger: LedgerState,
  scoreSum: Map<string, number>,
  cfg: InducedDemandConfig,
): void {
  const gross = points.reduce(
    (s, p) =>
      s + Math.max(0, ledger.points[p.id].resAccum) + Math.max(0, ledger.points[p.id].jobAccum),
    0,
  );
  let budget = cfg.PHI * gross;
  if (budget <= 0) return;
  const sorted = [...points].sort(
    (a, b) => (scoreSum.get(a.id) ?? 0) - (scoreSum.get(b.id) ?? 0),
  );
  for (const p of sorted) {
    if (budget <= 0) break;
    const e = ledger.points[p.id];
    const takeR = Math.min(budget, Math.max(0, e.resAccum));
    e.resAccum -= takeR;
    budget -= takeR;
    const takeJ = Math.min(budget, Math.max(0, e.jobAccum));
    e.jobAccum -= takeJ;
    budget -= takeJ;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/model/engine.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm test`
Expected: all test files pass.
Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(model): per-day engine (score -> grow -> pair -> apply -> decay)"
```

---

## Task 12: Hook wiring + build + install verification

**Files:**
- Create: `src/main.ts`

- [ ] **Step 1: Create `src/main.ts`**

```ts
/**
 * Induced Demand — entry point. Wires the per-day model engine to the game hooks.
 * Reads mode share + catchment; writes only demand (residents/jobs/pops).
 */
import { runDay } from './model/engine';
import { DEFAULT_CONFIG } from './model/config';
import { makeRng } from './model/gravity';
import {
  loadLedger, saveLedger, captureBaselines, reconcileBaselines,
  newLedger, type LedgerState, type ModStorage,
} from './model/ledger';

const TAG = '[InducedDemand]';
const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found.`);
} else {
  let ledger: LedgerState = newLedger();
  let cityCode = '';
  let saveName = '';
  const storage = api.storage as ModStorage;
  const key = () => `${cityCode}:${saveName}`;

  const hashSeed = (s: string, day: number): number => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h ^ day) >>> 0;
  };

  api.hooks.onCityLoad((code) => {
    cityCode = code;
  });

  api.hooks.onMapReady(async () => {
    try {
      saveName = api.gameState.getSaveName?.() ?? '';
      ledger = await loadLedger(storage, key());
      const dd = api.gameState.getDemandData();
      if (dd) {
        reconcileBaselines(dd, ledger);
        captureBaselines(dd, ledger);
      }
      console.log(`${TAG} ready for ${key()}`);
    } catch (e) {
      console.error(`${TAG} init failed`, e);
    }
  });

  api.hooks.onDayChange((day) => {
    try {
      const dd = api.gameState.getDemandData();
      if (!dd) return;
      captureBaselines(dd, ledger);
      const result = runDay(dd, api.gameState.getStations(), ledger, DEFAULT_CONFIG, makeRng(hashSeed(cityCode, day)));
      if (result.added || result.removed) {
        console.log(`${TAG} day ${day}: +${result.added} -${result.removed} pops`);
      }
    } catch (e) {
      console.error(`${TAG} day step failed`, e);
    }
  });

  api.hooks.onGameSaved(async (name) => {
    saveName = name;
    try {
      await saveLedger(storage, key(), ledger);
    } catch (e) {
      console.error(`${TAG} save failed`, e);
    }
  });

  api.hooks.onGameLoaded(async (name) => {
    saveName = name;
    try {
      ledger = await loadLedger(storage, key());
      const dd = api.gameState.getDemandData();
      if (dd) reconcileBaselines(dd, ledger);
    } catch (e) {
      console.error(`${TAG} load failed`, e);
    }
  });
}
```

- [ ] **Step 2: Typecheck the entry**

Run: `npm run typecheck`
Expected: exits 0 (the `window.SubwayBuilderAPI` global resolves via `src/types/index.d.ts`).

- [ ] **Step 3: Build the bundle**

Run: `npm run build`
Expected: writes `dist/index.js` and `dist/manifest.json`; the `postbuild` step prints `Installed mod to: ...\metro-maker4\mods\induced-demand`.

- [ ] **Step 4: Sanity-check the artifact**

Run: `node -e "const s=require('fs').readFileSync('dist/index.js','utf8'); if(!s.includes('SubwayBuilderAPI')) throw new Error('entry missing API hook'); console.log('OK', s.length, 'bytes')"`
Expected: `OK <n> bytes`.

- [ ] **Step 5: Manual in-game verification** (record result in the commit message)

1. Launch Subway Builder; open the dev console (the mod logs `[InducedDemand] ready for <city>:<save>`).
2. Load a city, build a line through a dense area, and let several in-game days pass at speed.
3. Confirm `[InducedDemand] day N: +X -Y pops` logs appear, and that `residents`/`jobs` near served stations rise over days while unserved areas stay flat.
4. Click an induced residence pop → trace to its job → back to a residence, confirming the accounting linkage holds in the UI.
5. Verify items in spec §13 against live data (pop size 200; `popIds` on both endpoints; `ModeChoiceStats` counts-vs-fractions). If any differ, open a follow-up to adjust `transitFraction`/`popFactory` accordingly.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire induced-demand engine to game hooks + build entry"
```

---

## Self-review

**Spec coverage:**
- §4 score → Tasks 4–5 (`access`, `score`). ✓
- §5 growth/cap/decay → Task 6 (`growth`) + Task 11 decay loop. ✓
- §5.4 relocation → Task 11 `applyRelocation` (simplified to growth-pressure trim; `PHI=0` default). Noted limitation; full pop-level relocation deferred (spec §14-adjacent). ✓
- §6 materialization (net-equal `N`, cap-respecting allocation, gravity pairing, 200-person pops, accounting) → Tasks 7–9 + Task 11 §C. ✓
- §7 ledger/persistence/reconciliation → Task 10. ✓
- §8 config → Task 2 (adds `CATCHMENT_SECONDS`, `DEFAULT_*_DEPART_SEC` elaborating the table). ✓
- §9 modules → one task per module. ✓
- §10 algorithm → Task 11 `runDay`. ✓
- §11 edge cases → covered in engine (null dd guard in `main`; empty stations; cap saturation; min-absorb via pool lengths). ✓
- §12 testing → tests in every model task + engine integration. ✓
- §13 verification → Task 12 Step 5 manual checks. ✓

**Placeholder scan:** No TBD/TODO; every step has complete code or a concrete command. The one simplification (relocation) ships as working code, not a stub.

**Type consistency:** `InducedDemandConfig`/`DEFAULT_CONFIG`, `AccessStation`, `LedgerState`/`PointLedger`/`ModStorage`, `INDUCED_PREFIX`, and the `addInducedPop`/`removeInducedPop`/`runDay` signatures are used identically across tasks. `runDay(dd, stations, ledger, cfg, rng)` matches its call in `main.ts`. Pop size flows through `cfg.POP_SIZE` everywhere.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-induced-demand.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
