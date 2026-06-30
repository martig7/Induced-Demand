# Induced-Demand Map Mode — Design Spec

- **Status:** Draft for review
- **Date:** 2026-06-30
- **Project:** Induced Demand (Subway Builder mod)
- **Depends on:** the implemented model ([model spec](2026-06-30-induced-demand-model-design.md)) — the ledger (`baseline*`), `demandData` (`current`), and the pure `access`/`score` functions.
- **Map API survey:** confirmed in the shipped build — see [DEMAND_API.md](../../DEMAND_API.md) and §8 below.

## 1. Goal & non-goals

**Goal.** A toggleable map overlay ("map mode") that visualizes where the mod is inducing demand. A toolbar button opens a small panel with two selectors and a legend; while enabled, each demand point with a nonzero value renders as a circle whose size and color encode the selected value, refreshed each in-game day.

**Two switches:**
- **View:** `Realized` | `Targeting`
- **Metric:** `Residential` | `Commercial` | `Combined`

**Non-goals (v1).** No per-point click/inspector, no time-scrubbing/animation, no separate base-demand layer, no heatmap variant. The pure model (`src/model/*`) is not modified — the overlay only reads from it.

## 2. The six values (per demand point `p`)

`access(p) = access(p.location, accessStations, cfg)` where `accessStations` is built from `getStations()` (`coords` + `routeIds` as `lineIds`) — identical to the engine.

| View | Residential | Commercial | Combined |
|---|---|---|---|
| **Realized** | `max(0, p.residents − baselineResidents)` | `max(0, p.jobs − baselineJobs)` | residential + commercial |
| **Targeting** | `residentialScore(p, access(p))` | `commercialScore(p, access(p))` | residential + commercial (0–2) |

- Realized baselines come from `ledger.points[p.id]`; a point with no ledger entry → baseline = current → realized value 0.
- Targeting reuses the model's pure `access`, `residentialScore`, `commercialScore` (no duplicated logic).
- **A point is included only if its value > 0** (realized → where growth happened; targeting → points the model is actively scoring).

## 3. Visual encoding

One MapLibre **`circle`** layer over one GeoJSON source.

Realized (people, 0–thousands) and targeting (score, 0–2) live on different scales, so each refresh computes the included features' **max** and stores a normalized `t = value / max` (0 when max is 0) plus the raw `value` per feature. The fixed paint spec interpolates on `t`, so one spec serves all six states:

```
circle-radius:  ['interpolate', ['linear'], ['get','t'], 0, 3, 1, 18]
circle-color:   ['interpolate', ['linear'], ['get','t'], 0, RAMP_LOW, 0.5, RAMP_MID, 1, RAMP_HIGH]
circle-opacity: 0.85
circle-stroke-width: 0.5
circle-stroke-color: '#00000055'
```

`RAMP_LOW/MID/HIGH` are a sequential ramp deliberately distinct from the game's built-in demand palette (proposed BuPu-style: `#edf8fb` → `#8c96c6` → `#810f7c`), defined as constants so they're trivially tweakable. The raw `value` stays in feature properties for the legend/hover.

## 4. Control panel (toolbar)

`ui.addToolbarPanel({ id, icon, tooltip, title, width, render })` → a panel built with `api.utils.React.createElement` (no JSX, so the Vite/TSX build config is left unchanged) and the shared `api.utils.components`. Contents:
- **On/off** control (master enable).
- **View** selector: Realized | Targeting.
- **Metric** selector: Residential | Commercial | Combined.
- **Legend:** the color ramp as a gradient bar with `0 … {max}` labels for the active view, and a one-line description of the current value's meaning/units (people vs score).

Any selector change updates shared state, which triggers an immediate overlay rebuild + redraw.

## 5. Lifecycle / refresh

- `onMapReady`: `map.registerSource(SOURCE_ID, { type:'geojson', data: emptyFC })` + `map.registerLayer({ id: LAYER_ID, type:'circle', source: SOURCE_ID, paint })`, then hide it; register the toolbar panel.
- **Refresh** (rebuild FeatureCollection + `getMap().getSource(SOURCE_ID).setData(fc)`) on: a selector change, and each `onDayChange` **while enabled**.
- On/off toggles the layer via `setLayoutProperty(LAYER_ID, 'visibility', enabled ? 'visible' : 'none')`.
- The overlay reuses the model's `ledger` (already held in `main.ts`) and the live `getDemandData()` / `getStations()`.

## 6. Module breakdown & interfaces

The pure model under `src/model/*` is untouched; the overlay imports from it (never the reverse).

| File | Responsibility | Tested |
|---|---|---|
| `src/overlay/types.ts` | `OverlayView`, `OverlayMetric`, `OverlayFeatureCollection` | — |
| `src/overlay/featureCollection.ts` | **pure** `buildOverlay(dd, ledger, stations, view, metric, cfg) → OverlayFeatureCollection` (value calc, value>0 filter, normalization) | **unit** |
| `src/overlay/overlay.ts` | owns the source/layer: `registerOverlay(api)`, `updateOverlay(api, fc)`, `setOverlayVisible(api, on)` | manual |
| `src/overlay/state.ts` | `OverlayState { enabled, view, metric }` + tiny `get/set/subscribe` observable | unit (optional) |
| `src/ui/panel.ts` | the toolbar panel (`createElement`): selectors + legend, wired to state | manual |
| `src/main.ts` | register overlay + panel on map-ready; `refresh()` on state change and on day change when enabled | — |

Key signatures:
```ts
// types.ts
export type OverlayView = 'realized' | 'targeting';
export type OverlayMetric = 'residential' | 'commercial' | 'combined';
export interface OverlayFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: Coordinate };
    properties: { id: string; value: number; t: number };
  }>;
  maxValue: number;
}
// featureCollection.ts
export function buildOverlay(
  dd: DemandData, ledger: LedgerState, stations: Station[],
  view: OverlayView, metric: OverlayMetric, cfg: InducedDemandConfig,
): OverlayFeatureCollection;
```

## 7. Testing

- **`featureCollection.test.ts` (pure):** realized combined = inducedResidents + inducedJobs from ledger baselines; targeting uses `residentialScore`/`commercialScore`; only value>0 points included; geometry coordinates = `point.location`; `t = value/maxValue` and `maxValue` correct; empty/zero input → empty FeatureCollection with `maxValue 0`.
- **`state.test.ts` (optional):** set patches state and notifies subscribers.
- **Manual / in-game:** panel opens from toolbar; toggling on shows circles; switching View/Metric redraws; circles grow as induced demand grows day-over-day; on/off hides cleanly.

## 8. Map API used (verified in the build)

- `map.registerSource(id, {type:'geojson', data})` — stored in `customSources`, re-applied on style (re)load; only adds if absent (so updates go through the live source, not re-registration).
- `map.registerLayer(layer, beforeId?)` — upserts into `customLayers`, re-applied on style reload, adds immediately if the map is ready (removing any existing same-id layer first). `circle` is a supported layer type.
- `utils.getMap()` → live MapLibre `Map` for `getSource(id).setData(fc)` and `setLayoutProperty(id,'visibility',…)`.
- `ui.addToolbarPanel({...render})` — toolbar button that opens a custom-rendered panel.
- `utils.React` + `utils.components` — React runtime + shared UI components for the panel.
- `hooks.onMapReady(map => …)` — attach source/layer/panel once the map exists.

## 9. Runtime-verification items (check while building)

1. `ui.addToolbarPanel` `render` return type — confirm it expects a React element from `createElement` and the panel mounts.
2. `getMap().getSource(SOURCE_ID).setData(fc)` updates the rendered circles live.
3. `SOURCE_ID` / `LAYER_ID` don't collide with built-in game layer ids (prefix them, e.g. `induced-demand-*`).
4. Circle `paint` data-expressions evaluate against our string/number `properties` as expected.

## 10. Out of scope (future)
Per-point hover/click inspector; base-demand comparison layer; heatmap encoding; animation/history scrub; persisting the panel's selected view/metric across sessions.
