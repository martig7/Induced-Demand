# Induced-Demand Map Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable map overlay that visualizes induced demand — a circle layer driven by a toolbar panel with View (realized / targeting) × Metric (residential / commercial / combined) selectors and a legend.

**Architecture:** A pure `buildOverlay()` turns the model's state into a normalized GeoJSON FeatureCollection; `overlay.ts` owns the MapLibre source/layer; a tiny observable `state.ts` holds the selectors; `panel.ts` renders the toolbar control via `api.utils.React.createElement` (no JSX, so the build config is unchanged); `main.ts` wires them and refreshes on selector change and each in-game day. The pure model under `src/model/*` is not modified — the overlay only reads from it.

**Tech Stack:** TypeScript, MapLibre (`circle` layer via `api.map.*` + `utils.getMap()`), `node:test` via `tsx`, Vite build.

**Spec:** [docs/superpowers/specs/2026-06-30-induced-demand-map-mode-design.md](../specs/2026-06-30-induced-demand-map-mode-design.md). Branch: `feat/map-mode`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/overlay/types.ts` | `OverlayView`, `OverlayMetric`, `OverlayFeatureCollection` |
| `src/overlay/featureCollection.ts` | pure `buildOverlay(...)` → normalized GeoJSON |
| `src/overlay/state.ts` | `OverlayState` + `createOverlayStore` observable |
| `src/overlay/overlay.ts` | MapLibre source/layer: register, update, visibility; ramp + id constants |
| `src/ui/panel.ts` | toolbar panel via `createElement` (selectors + legend) |
| `src/main.ts` | (modify) register overlay + panel on map-ready; refresh on change/day |

---

## Task 1: Overlay types + pure FeatureCollection builder

**Files:**
- Create: `src/overlay/types.ts`, `src/overlay/featureCollection.ts`, `src/overlay/featureCollection.test.ts`

- [ ] **Step 1: Write the failing test** — `src/overlay/featureCollection.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverlay } from './featureCollection';
import { DEFAULT_CONFIG } from '../model/config';
import { newLedger, type LedgerState } from '../model/ledger';
import type { DemandData, DemandPoint, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';

const ms = (transit: number) => ({ walking: 0, driving: 100 - transit, transit, unknown: 0 });
function pt(id: string, loc: Coordinate, residents: number, jobs: number, rt: number, wt: number): DemandPoint {
  return { id, location: loc, residents, jobs, popIds: [], residentModeShare: ms(rt), workerModeShare: ms(wt) };
}
function station(coords: Coordinate, routeIds: string[]): Station {
  return { id: 's', coords, routeIds } as unknown as Station;
}
function ledgerWith(baselines: Record<string, [number, number]>): LedgerState {
  const led = newLedger();
  for (const [id, [r, j]] of Object.entries(baselines)) {
    led.points[id] = { baselineResidents: r, baselineJobs: j, resAccum: 0, jobAccum: 0 };
  }
  return led;
}

test('realized combined = induced residents + induced jobs from ledger baselines', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 600, 600, 0, 0)]]), popsMap: new Map() };
  const led = ledgerWith({ H: [400, 400] });
  const fc = buildOverlay(dd, led, [], 'realized', 'combined', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.value, 400); // (600-400)+(600-400)
  assert.equal(fc.maxValue, 400);
  assert.equal(fc.features[0].properties.t, 1);
  assert.deepEqual(fc.features[0].geometry.coordinates, [0, 0]);
});

test('realized residential vs commercial pick the right side', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 600, 500, 0, 0)]]), popsMap: new Map() };
  const led = ledgerWith({ H: [400, 400] });
  assert.equal(buildOverlay(dd, led, [], 'realized', 'residential', DEFAULT_CONFIG).features[0].properties.value, 200);
  assert.equal(buildOverlay(dd, led, [], 'realized', 'commercial', DEFAULT_CONFIG).features[0].properties.value, 100);
});

test('value > 0 filter drops points with no induced growth', () => {
  const dd: DemandData = { points: new Map([['Z', pt('Z', [1, 1], 400, 400, 0, 0)]]), popsMap: new Map() };
  const led = ledgerWith({ Z: [400, 400] });
  const fc = buildOverlay(dd, led, [], 'realized', 'combined', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 0);
  assert.equal(fc.maxValue, 0);
});

test('targeting uses the model score (point at a served station)', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 400, 0, 50, 0)]]), popsMap: new Map() };
  const fc = buildOverlay(dd, newLedger(), [station([0, 0], ['r1', 'r2', 'r3'])], 'targeting', 'residential', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 1);
  // residentialScore = transitFraction(0.5) * access(~1) ~= 0.5
  assert.ok(Math.abs(fc.features[0].properties.value - 0.5) < 1e-6);
});

test('normalization sets t = value / maxValue across points', () => {
  const dd: DemandData = {
    points: new Map([
      ['A', pt('A', [0, 0], 500, 400, 0, 0)], // induced res 100
      ['B', pt('B', [0, 1], 600, 400, 0, 0)], // induced res 200
    ]),
    popsMap: new Map(),
  };
  const led = ledgerWith({ A: [400, 400], B: [400, 400] });
  const fc = buildOverlay(dd, led, [], 'realized', 'residential', DEFAULT_CONFIG);
  assert.equal(fc.maxValue, 200);
  const byId = Object.fromEntries(fc.features.map((f) => [f.properties.id, f.properties.t]));
  assert.equal(byId['B'], 1);
  assert.equal(byId['A'], 0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/overlay/featureCollection.test.ts`
Expected: FAIL — cannot find module `./featureCollection`.

- [ ] **Step 3: Create `src/overlay/types.ts`**

```ts
import type { Coordinate } from '../types/core';

export type OverlayView = 'realized' | 'targeting';
export type OverlayMetric = 'residential' | 'commercial' | 'combined';

export interface OverlayFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: Coordinate };
  properties: { id: string; value: number; t: number };
}

export interface OverlayFeatureCollection {
  type: 'FeatureCollection';
  features: OverlayFeature[];
  /** Max raw value across included features (0 if none) — used for the legend and normalization. */
  maxValue: number;
}
```

- [ ] **Step 4: Create `src/overlay/featureCollection.ts`**

```ts
import type { DemandData, Station } from '../types/game-state';
import type { InducedDemandConfig } from '../model/config';
import type { LedgerState } from '../model/ledger';
import { access, type AccessStation } from '../model/access';
import { residentialScore, commercialScore } from '../model/score';
import type { OverlayView, OverlayMetric, OverlayFeature, OverlayFeatureCollection } from './types';

/** Build a normalized GeoJSON FeatureCollection for the selected view + metric. Pure. */
export function buildOverlay(
  dd: DemandData,
  ledger: LedgerState,
  stations: Station[],
  view: OverlayView,
  metric: OverlayMetric,
  cfg: InducedDemandConfig,
): OverlayFeatureCollection {
  const accessStations: AccessStation[] = stations.map((s) => ({ coords: s.coords, lineIds: s.routeIds ?? [] }));
  const features: OverlayFeature[] = [];
  let maxValue = 0;

  for (const p of dd.points.values()) {
    let value: number;
    if (view === 'realized') {
      const e = ledger.points[p.id];
      const baseRes = e ? e.baselineResidents : p.residents;
      const baseJob = e ? e.baselineJobs : p.jobs;
      const indRes = Math.max(0, p.residents - baseRes);
      const indJob = Math.max(0, p.jobs - baseJob);
      value = metric === 'residential' ? indRes : metric === 'commercial' ? indJob : indRes + indJob;
    } else {
      const a = access(p.location, accessStations, cfg);
      const sRes = residentialScore(p, a);
      const sJob = commercialScore(p, a);
      value = metric === 'residential' ? sRes : metric === 'commercial' ? sJob : sRes + sJob;
    }
    if (value > 0) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.location }, properties: { id: p.id, value, t: 0 } });
      if (value > maxValue) maxValue = value;
    }
  }

  for (const f of features) f.properties.t = maxValue > 0 ? f.properties.value / maxValue : 0;
  return { type: 'FeatureCollection', features, maxValue };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/overlay/featureCollection.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/overlay/types.ts src/overlay/featureCollection.ts src/overlay/featureCollection.test.ts
git commit -m "feat(overlay): pure FeatureCollection builder for the map mode"
```

---

## Task 2: Overlay state store

**Files:**
- Create: `src/overlay/state.ts`, `src/overlay/state.test.ts`

- [ ] **Step 1: Write the failing test** — `src/overlay/state.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayStore } from './state';

test('store merges patches and notifies subscribers', () => {
  const store = createOverlayStore({ enabled: false, view: 'realized', metric: 'combined' });
  let n = 0;
  const unsub = store.subscribe(() => { n++; });

  store.set({ enabled: true });
  assert.equal(store.get().enabled, true);
  assert.equal(n, 1);

  store.set({ view: 'targeting' });
  assert.equal(store.get().view, 'targeting');
  assert.equal(store.get().enabled, true); // patch merges, doesn't replace
  assert.equal(n, 2);

  unsub();
  store.set({ metric: 'residential' });
  assert.equal(n, 2); // no notify after unsubscribe
  assert.equal(store.get().metric, 'residential');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/overlay/state.test.ts`
Expected: FAIL — cannot find module `./state`.

- [ ] **Step 3: Create `src/overlay/state.ts`**

```ts
import type { OverlayView, OverlayMetric } from './types';

export interface OverlayState {
  enabled: boolean;
  view: OverlayView;
  metric: OverlayMetric;
}

export interface OverlayStore {
  get(): OverlayState;
  set(patch: Partial<OverlayState>): void;
  subscribe(fn: () => void): () => void;
}

export function createOverlayStore(initial: OverlayState): OverlayStore {
  let state: OverlayState = { ...initial };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      for (const fn of subs) fn();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/overlay/state.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/overlay/state.ts src/overlay/state.test.ts
git commit -m "feat(overlay): observable state store for view/metric/enabled"
```

---

## Task 3: MapLibre source/layer glue

**Files:**
- Create: `src/overlay/overlay.ts`, `src/overlay/overlay.test.ts`

- [ ] **Step 1: Write the failing test** — `src/overlay/overlay.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerOverlay, updateOverlay, setOverlayVisible, SOURCE_ID, LAYER_ID } from './overlay';
import type { ModdingAPI } from '../types/api';
import type { OverlayFeatureCollection } from './types';

function mockApi() {
  const calls = {
    sources: [] as Array<[string, unknown]>,
    layers: [] as unknown[],
    setData: [] as Array<[string, unknown]>,
    layout: [] as Array<[string, string, unknown]>,
  };
  const map = {
    getSource: (id: string) => ({ setData: (d: unknown) => calls.setData.push([id, d]) }),
    getLayer: (id: string) => ({ id }),
    setLayoutProperty: (id: string, k: string, v: unknown) => calls.layout.push([id, k, v]),
  };
  const api = {
    map: {
      registerSource: (id: string, cfg: unknown) => calls.sources.push([id, cfg]),
      registerLayer: (cfg: unknown) => calls.layers.push(cfg),
    },
    utils: { getMap: () => map },
  } as unknown as ModdingAPI;
  return { api, calls };
}

test('registerOverlay registers a geojson source and a hidden circle layer', () => {
  const { api, calls } = mockApi();
  registerOverlay(api);
  assert.equal(calls.sources.length, 1);
  assert.equal(calls.sources[0][0], SOURCE_ID);
  assert.equal((calls.sources[0][1] as { type: string }).type, 'geojson');
  assert.equal(calls.layers.length, 1);
  const layer = calls.layers[0] as { id: string; type: string; source: string; layout: { visibility: string } };
  assert.equal(layer.id, LAYER_ID);
  assert.equal(layer.type, 'circle');
  assert.equal(layer.source, SOURCE_ID);
  assert.equal(layer.layout.visibility, 'none');
});

test('updateOverlay pushes data to the source', () => {
  const { api, calls } = mockApi();
  const fc: OverlayFeatureCollection = { type: 'FeatureCollection', features: [], maxValue: 0 };
  updateOverlay(api, fc);
  assert.deepEqual(calls.setData, [[SOURCE_ID, fc]]);
});

test('setOverlayVisible toggles the layer visibility', () => {
  const { api, calls } = mockApi();
  setOverlayVisible(api, true);
  setOverlayVisible(api, false);
  assert.deepEqual(calls.layout, [
    [LAYER_ID, 'visibility', 'visible'],
    [LAYER_ID, 'visibility', 'none'],
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/overlay/overlay.test.ts`
Expected: FAIL — cannot find module `./overlay`.

- [ ] **Step 3: Create `src/overlay/overlay.ts`**

```ts
import type { ModdingAPI } from '../types/api';
import type { OverlayFeatureCollection } from './types';

export const SOURCE_ID = 'induced-demand-source';
export const LAYER_ID = 'induced-demand-circles';

/** Sequential ramp, deliberately distinct from the game's built-in demand palette. */
export const RAMP_LOW = '#edf8fb';
export const RAMP_MID = '#8c96c6';
export const RAMP_HIGH = '#810f7c';

const EMPTY_FC: OverlayFeatureCollection = { type: 'FeatureCollection', features: [], maxValue: 0 };

/** Register the GeoJSON source and the (initially hidden) circle layer. Idempotent via the API's upsert. */
export function registerOverlay(api: ModdingAPI): void {
  api.map.registerSource(SOURCE_ID, { type: 'geojson', data: EMPTY_FC });
  api.map.registerLayer({
    id: LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 't'], 0, 3, 1, 18],
      'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, RAMP_LOW, 0.5, RAMP_MID, 1, RAMP_HIGH],
      'circle-opacity': 0.85,
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#00000055',
    },
  });
}

/** Push a new FeatureCollection to the live source. */
export function updateOverlay(api: ModdingAPI, fc: OverlayFeatureCollection): void {
  const map = api.utils.getMap();
  const src = map?.getSource(SOURCE_ID) as unknown as { setData?: (d: unknown) => void } | undefined;
  src?.setData?.(fc);
}

/** Show or hide the circle layer. */
export function setOverlayVisible(api: ModdingAPI, visible: boolean): void {
  const map = api.utils.getMap();
  if (map && map.getLayer(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/overlay/overlay.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck (confirms the maplibre/api casts hold)**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/overlay/overlay.ts src/overlay/overlay.test.ts
git commit -m "feat(overlay): MapLibre source/layer registration + update + visibility"
```

---

## Task 4: Toolbar panel

**Files:**
- Create: `src/ui/panel.ts`, `src/ui/panel.test.ts`

- [ ] **Step 1: Write the failing test** — `src/ui/panel.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitsLabel, createPanel } from './panel';
import { createOverlayStore } from '../overlay/state';
import type { ModdingAPI } from '../types/api';

test('unitsLabel describes the active view', () => {
  assert.equal(unitsLabel('realized'), 'people (induced)');
  assert.equal(unitsLabel('targeting'), 'attractiveness score');
});

test('createPanel returns a component function (does not throw to construct)', () => {
  const store = createOverlayStore({ enabled: false, view: 'realized', metric: 'combined' });
  const api = { utils: { React: { createElement: () => ({}), useReducer: () => [0, () => {}], useEffect: () => {} } } } as unknown as ModdingAPI;
  const Panel = createPanel(api, store, () => 0);
  assert.equal(typeof Panel, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/ui/panel.test.ts`
Expected: FAIL — cannot find module `./panel`.

- [ ] **Step 3: Create `src/ui/panel.ts`**

```ts
import type { ModdingAPI } from '../types/api';
import type { OverlayStore } from '../overlay/state';
import type { OverlayView, OverlayMetric } from '../overlay/types';
import { RAMP_LOW, RAMP_MID, RAMP_HIGH } from '../overlay/overlay';

export function unitsLabel(view: OverlayView): string {
  return view === 'realized' ? 'people (induced)' : 'attractiveness score';
}

/**
 * Build the toolbar-panel render function. Uses `api.utils.React.createElement`
 * (no JSX). The returned component re-renders when the store changes.
 * `getMax()` returns the most recent FeatureCollection's maxValue for the legend.
 */
export function createPanel(api: ModdingAPI, store: OverlayStore, getMax: () => number): () => unknown {
  const React = api.utils.React as unknown as {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
    useReducer: (r: (x: number) => number, i: number) => [number, () => void];
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => void;
  };
  const h = React.createElement;

  const seg = (label: string, active: boolean, onClick: () => void): unknown =>
    h('button', {
      onClick,
      style: {
        padding: '2px 8px', marginRight: '4px', borderRadius: '4px', cursor: 'pointer',
        border: '1px solid #8c96c6',
        background: active ? RAMP_MID : 'transparent',
        color: active ? '#fff' : 'inherit',
        fontSize: '12px',
      },
    }, label);

  return function Panel(): unknown {
    const [, force] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => store.subscribe(force), []);
    const s = store.get();
    const setView = (view: OverlayView) => store.set({ view });
    const setMetric = (metric: OverlayMetric) => store.set({ metric });

    const row = (label: string, children: unknown[]): unknown =>
      h('div', { style: { display: 'flex', alignItems: 'center', margin: '6px 0' } },
        h('span', { style: { width: '54px', fontSize: '12px', opacity: 0.8 } }, label),
        h('div', null, ...children));

    const legend = h('div', { style: { marginTop: '8px' } },
      h('div', {
        style: {
          height: '10px', borderRadius: '4px',
          background: `linear-gradient(to right, ${RAMP_LOW}, ${RAMP_MID}, ${RAMP_HIGH})`,
        },
      }),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', opacity: 0.8 } },
        h('span', null, '0'),
        h('span', null, String(Math.round(getMax())))),
      h('div', { style: { fontSize: '11px', opacity: 0.7, marginTop: '2px' } }, unitsLabel(s.view)));

    return h('div', { style: { padding: '8px', minWidth: '220px' } },
      row('Show', [seg('On', s.enabled, () => store.set({ enabled: true })), seg('Off', !s.enabled, () => store.set({ enabled: false }))]),
      row('View', [seg('Realized', s.view === 'realized', () => setView('realized')), seg('Targeting', s.view === 'targeting', () => setView('targeting'))]),
      row('Metric', [
        seg('Res', s.metric === 'residential', () => setMetric('residential')),
        seg('Com', s.metric === 'commercial', () => setMetric('commercial')),
        seg('Both', s.metric === 'combined', () => setMetric('combined')),
      ]),
      legend);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/ui/panel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/ui/panel.ts src/ui/panel.test.ts
git commit -m "feat(ui): toolbar panel with view/metric selectors + legend"
```

---

## Task 5: Wire into `main.ts`, build, verify

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add the overlay imports** to the top of `src/main.ts` (after the existing imports, before `const TAG`)

```ts
import { buildOverlay } from './overlay/featureCollection';
import { registerOverlay, updateOverlay, setOverlayVisible } from './overlay/overlay';
import { createOverlayStore } from './overlay/state';
import { createPanel } from './ui/panel';
```

- [ ] **Step 2: Add overlay state + refresh inside the `else` block**, right after the line `let loggedSample = false;`

```ts
  let overlayRegistered = false;
  let lastMax = 0;
  const overlayStore = createOverlayStore({ enabled: false, view: 'realized', metric: 'combined' });

  function refreshOverlay(): void {
    if (!overlayStore.get().enabled) { setOverlayVisible(api, false); return; }
    const dd = api.gameState.getDemandData();
    if (!dd) return;
    const s = overlayStore.get();
    const fc = buildOverlay(dd, ledger, api.gameState.getStations(), s.view, s.metric, DEFAULT_CONFIG);
    lastMax = fc.maxValue;
    updateOverlay(api, fc);
    setOverlayVisible(api, true);
  }
  overlayStore.subscribe(refreshOverlay);
```

- [ ] **Step 3: Register the overlay + panel** by replacing the existing `onMapReady` registration:

Find:
```ts
  api.hooks.onMapReady(() => { if (!isCurrent()) return; void init(); });
```
Replace with:
```ts
  api.hooks.onMapReady(() => {
    if (!isCurrent()) return;
    if (!overlayRegistered) {
      overlayRegistered = true;
      try {
        registerOverlay(api);
        api.ui.addToolbarPanel({
          id: 'induced-demand-map-mode',
          icon: 'TrendingUp',
          tooltip: 'Induced Demand',
          title: 'Induced Demand',
          width: 260,
          render: createPanel(api, overlayStore, () => lastMax),
        });
      } catch (e) {
        console.error(`${TAG} overlay/panel registration failed`, e);
      }
    }
    void init();
  });
```

- [ ] **Step 4: Refresh the overlay each day** — in the `onDayChange` handler, add a refresh at the very end of the `try`/body, right after the DEBUG heartbeat block (i.e., as the last statement inside the `onDayChange` callback, after the `if (DEBUG) { … } else if (…) { … }`):

```ts
    if (overlayStore.get().enabled) refreshOverlay();
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0. (`api.ui.addToolbarPanel`, `api.utils.React`, and the overlay imports all resolve.)

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all tests pass (model 37 + overlay/ui additions = ~46).

- [ ] **Step 7: Build + install**

Run: `npm run build`
Expected: writes `dist/index.js`, postbuild prints `Installed mod to: …\metro-maker4\mods\induced-demand`.

- [ ] **Step 8: Manual in-game verification** (record results in the commit body)

1. Reload the game; a new toolbar button (TrendingUp icon, "Induced Demand") appears.
2. Open it → panel shows Show On/Off, View Realized/Targeting, Metric Res/Com/Both, and a legend.
3. Turn it On with **Targeting** selected → circles appear at served points (immediately, even before growth), sized/colored by score.
4. Switch to **Realized** → circles show only where induced demand has accrued; they grow day-over-day.
5. Switch Metric Res/Com/Both → the distribution and legend max update.
6. Turn Off → circles disappear.
7. Confirm §9 spec items: `addToolbarPanel` renders the `createElement` panel (hooks work / it re-renders on selector change); `getSource().setData()` updates circles live; no id collision with built-in layers. If `addToolbarPanel` does not render a hook-using component, switch the panel to subscribe + `api.ui.forceUpdate()` and note it.

- [ ] **Step 9: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire induced-demand map mode (overlay + toolbar panel)"
```

---

## Self-review

**Spec coverage:**
- §2 six values → Task 1 `buildOverlay` (realized res/com/combined from ledger baselines; targeting via `access`+score). ✓
- §3 circle layer + `t`-normalization + ramp → Task 1 (`t`) + Task 3 (paint/ramp). ✓
- §4 toolbar panel (on/off, view, metric, legend) → Task 4. ✓
- §5 lifecycle (register on map-ready, refresh on change + day, visibility toggle) → Task 5 (steps 2–4) + Task 3 `setOverlayVisible`. ✓
- §6 module breakdown → one file per module, model untouched. ✓
- §7 testing → pure builder + state + overlay(mock) + panel helper tested; panel/main manual. ✓
- §9 runtime items → Task 5 step 8. ✓

**Placeholder scan:** none — every step has complete code or an exact command. The only "if it doesn't work" note (step 8.7) is a concrete fallback, not a deferred decision.

**Type consistency:** `buildOverlay(dd, ledger, stations, view, metric, cfg)`, `OverlayFeatureCollection { features, maxValue }`, `properties { id, value, t }`, `SOURCE_ID`/`LAYER_ID`/`RAMP_*`, `createOverlayStore`/`OverlayStore.{get,set,subscribe}`, `registerOverlay/updateOverlay/setOverlayVisible(api, …)`, and `createPanel(api, store, () => number)` are used identically across tasks and in `main.ts`. The overlay reads the live module-scope `ledger` in `main.ts` (which is reassigned on load), so `refreshOverlay` closes over it rather than capturing a snapshot.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-induced-demand-map-mode.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — tasks in this session with checkpoints.

Which approach?
