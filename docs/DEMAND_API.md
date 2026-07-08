# Subway Builder — Demand API (reverse-engineering notes)

Findings from unpacking the shipped Electron build and tracing the demand
pipeline, for the **Induced Demand** mod. Everything a mod can touch goes
through the single global `window.SubwayBuilderAPI` (the only object the app
exposes to mods — the Zustand store `useMainStore` is **not** on `window`).

Source of truth: `resources/app.asar` →
`dist/renderer/public/index-*.js` (modding API + main store) and
`popCommuteWorker.worker-*.js` (commute/catchment sim). The bundle is
string-array-obfuscated, but object keys (API method names) are literal.

## TL;DR for the mod

- **Read demand:** `api.gameState.getDemandData()` → `{ points: Map, popsMap: Map }`.
  This is the **live** store object, not a copy.
- **Change demand:** there is **no public setter**. Mutate the live Maps in
  place — adjust `DemandPoint.residents`/`.jobs` and (crucially) scale or add
  `Pop` entries. The next commute cycle reads the store live and picks the
  changes up.
- **Catchment is moddable** via station types
  (`api.stations.registerStationType` / `modifyStationType`):
  `catchmentMultiplier`, `transferRadiusMultiplier`, `walkSpeedMultiplier`,
  `catchmentOverride`. Base catchment ≈ **1800 s** (~30 min walk), transfer ≈
  **600 s** (~10 min).
- **React to time:** `api.hooks.onDayChange(day => …)` and
  `api.hooks.onDemandChange(popCount => …)`.

## Data model (verified against the build)

Runtime (`getDemandData()`):

```ts
DemandData = {
  points:  Map<string, DemandPoint>;
  popsMap: Map<string, Pop>;
}

DemandPoint = {
  id: string;
  location: [lon, lat];
  jobs: number;            // int >= 0
  residents: number;       // int >= 0
  popIds: string[];        // commuter groups anchored here
  residentModeShare: { walking; driving; transit; unknown };  // computed
  workerModeShare:   { walking; driving; transit; unknown };  // computed
}

Pop = {                    // a commuter GROUP (not one person)
  id: string;
  size: number;            // people making this trip  ← ridership lever
  residenceId: string;     // home DemandPoint id
  jobId: string;           // work DemandPoint id
  drivingSeconds: number;
  drivingDistance: number;
  drivingPath?: [lon,lat][];
  homeDepartureTime: number;   // runtime
  workDepartureTime: number;   // runtime
  lastCommute: CompletedPopCommute;  // runtime (mode choice, transit paths)
}
```

On-disk city file `…/demand_data.json` (validated by `DemandDataSchema`) uses a
**record** keyed by id and names the pops collection `pops` (not `popsMap`),
without the runtime-only fields:

```ts
DemandDataFile = {
  points: Record<id, { id; location; jobs; residents; popIds }>;
  pops:   Record<id, { id; size; residenceId; jobId; drivingSeconds; drivingDistance; drivingPath? }>;
}
```

`registerCity` / `cities.setCityDataFiles` point a city at its data files
(`demand_data.json` among them); `utils.loadCityData(path)` loads them in an
Electron-safe way.

## How demand drives ridership (the important part)

The commute simulation (`simulatePopCommutes` in `popCommuteWorker`) iterates
over **pops**, not over `residents`/`jobs`. For each pop it finds the stations
within the **catchment** of the residence and job demand points (by walking
time), runs RAPTOR pathfinding, picks a mode (walk / drive / transit), and the
transit riders become ridership.

Consequence for "induced demand": raising a `DemandPoint`'s `residents`/`jobs`
**alone does not add riders** — it only changes the displayed totals/mode-share.
To actually grow ridership you must grow the `Pop` population in the catchment:
scale `pop.size` for pops whose `residenceId`/`jobId` sits near a station, and/or
add new pops. Keep the demand-point aggregates in sync for the UI.

## The write path, precisely

`getDemandData()` returns the store's live object:

```js
getDemandData: () => useMainStore.getState().demandData || null
```

The commute store action reads that same object live, every cycle:

```js
simulateCommutes: async ({ popCommutes }) => {
  const s = useMainStore.getState();
  const result = await simulatePopCommutes({
    routes: s.routes, stations: s.stations, trains: s.trains,
    popsMap: s.demandData.popsMap,      // ← live
    demandPoints: s.demandData.points,  // ← live
    elapsedSeconds: s.timeConfig.elapsedSeconds,
    popMovementsMap: s.popMovementsMap, transitCost: s.transitCost,
  }, popCommutes);
  set({ demandData: { popsMap: result.newPopsMap, points: result.newDemandPoints }, … });
}
```

So: **mutate the Maps from `getDemandData()` in place** and the next cycle uses
them. There is an internal `setDemandData(data)` store action (also fires
`triggerDemandChange(points.size)`), but it is **not exposed to mods**.

⚠️ Each cycle **replaces** `demandData` with freshly-derived `points`/`popsMap`
(the sim writes `lastCommute`/mode-share back onto pops/points). The new Maps are
derived from your mutated inputs, so `size`/`residents`/`jobs` persist — but
**re-fetch `getDemandData()` each time** instead of caching the object across
cycles, since the reference changes.

## Catchment levers (station types)

`popCommuteWorker` resolves catchment per stop from its station type:

```js
STATION_TYPES.standard = {
  catchmentMultiplier: 1, transferRadiusMultiplier: 1,
  walkSpeedMultiplier: 1, extraDwellTime: 0,
}
getEffectiveCatchmentForStop(stop, cache) // → catchment radius (seconds), default 1800
```

`StationTypeConfig` (see `src/types/stations.d.ts`) exposes:
`catchmentMultiplier` (base 1800 s / 30 min), `transferRadiusMultiplier`
(base 600 s / 10 min), `walkSpeedMultiplier` (base 1 m/s), `dwellTime`,
and absolute overrides `catchmentOverride` / `transferRadiusOverride` /
`walkSpeedOverride`.

Time-of-day demand curves (`getTimeOfDayRanges`) use `homeDemandMultiplier` /
`workDemandMultiplier` per range (VERY_LOW 0.15 … HIGH 2.5). These are **global
rush-hour curves**, not per-point levers — useful context, not a mod hook.

## API delta vs. the ported v1.0.0 model

Added/corrected in `src/types` during this pass (all `@added`/`@verified`):

- `gameState.getStationGroups(): StationGroup[]` — was optional `?(): unknown`.
- `gameState.getTransferStationIds(): string[]` — **new**.
- `gameState.getSiblingStationIds(stationId): string[]` — **new**.
- `gameState.getSaveName(): string | null` — **new**.
- `gameState.getStations(options?)` / `getRoutes(options?)` — now take an
  options object (`includeTempRoutes`, name inferred).
- `utils.buildings.{encode, validate, load}` — **new** namespace.
- `game-state.d.ts`: added `StationGroup`; documented demand types and the
  runtime-vs-schema field/key differences.

No demand **mutation** method exists in the public API — read access only,
write via in-place mutation as above.

## Relevant hooks

- `hooks.onDayChange(day => …)` — natural cadence to apply induced-demand growth.
- `hooks.onDemandChange(popCount => …)` — fires when demand data is replaced.
- `hooks.onStationBuilt(station => …)` / `onStationDeleted(id => …)` — recompute
  affected catchments.
- `hooks.onCityLoad(code => …)` / `onMapReady(map => …)` — init.

Toolbar panels, `reloadMods()`, and save-reload hook behavior are documented in
[`MODDING_UI.md`](MODDING_UI.md) (unregister-before-add pattern; `addToolbarPanel`
does not dedupe by id).

## Re-deriving this later

Helper scripts live in `scripts/` (dependency-free, Node only):

```bash
node scripts/asar.js list    "<game>/resources/app.asar"                     # file tree
node scripts/asar.js extract "<game>/resources/app.asar" "dist/renderer/public/" out
node scripts/ctx.js out/dist/renderer/public/index-*.js "getDemandData" 700 5  # context window around matches
```

(`<game>` = `…/Programs/Subway Builder/game`.)

Anchors: `getDemandData`, `setDemandData`, `simulateCommutes`,
`simulatePopCommutes`, `getEffectiveCatchmentForStop`, `DemandPointSchema`.
