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

## Commute departure times (verified 2026-07-12)

How the game assigns `homeDepartureTime` / `workDepartureTime`, from
`assignCommuteTimes` → `generateTimeSlots` → `generateDepartureTimeBasedOnDemand`
(v1.4.10 bundle). Emulated in `src/model/commuteTimes.ts`.

**Time-of-day table** (`TIME_OF_DAY_RANGES`, live via
`api.popTiming.getCommuteTimeRanges()`). Multipliers:
`VERY_LOW 0.15, LOW 0.3, LOW_MEDIUM 0.8, MEDIUM 1, HIGH 2.5`.

| hours | key | home× | work× |
|-------|-----|-------|-------|
| 0-3 | Night | 0.15 | 0.15 |
| 3-6 | EarlyMorning | 0.3 | 0.3 |
| 6-7 | EarlyMorningRush | 1 | 0.3 |
| 7-10 | PeakMorningRush | **2.5** | 0.3 |
| 10-11 | LateMorningRush | 1 | 0.8 |
| 11-15 | Midday | 0.8 | 0.8 |
| 15-16 | EarlyEveningRush | 0.8 | 1 |
| 16-19 | PeakEveningRush | 0.3 | **2.5** |
| 19-20 | LateEveningRush | 0.3 | 1 |
| 20-23 | EarlyNight | 0.3 | 0.3 |
| 23-24 | LateNight | 0.15 | 0.15 |

**Slot construction.** Per-hour multiplier = `max` over covering ranges, then
optional dampening (`m*(1-d) + avg*d`) and mirroring (`home = work = mean`), then
contiguous equal hours are run-length-encoded into bins, then each bin is
normalized to `multiplier × width / Σ(multiplier × width)`. Note the RLE **merges
adjacent equal-multiplier bands**, so the resulting bins are not the table rows —
e.g. home 11-15 and 15-16 (both 0.8) become one 11-16 bin.

Resulting default bins (probability of a departure landing in the bin):

```
home: 0-3 2.63%  3-6 5.26%  6-7 5.85%  7-10 43.86%  10-11 5.85%  11-16 23.39%  16-23 12.28%  23-24 0.88%
work: 0-3 2.63%  3-10 12.28%  10-15 23.39%  15-16 5.85%  16-19 43.86%  19-20 5.85%  20-23 5.26%  23-24 0.88%
```

**Drawing one departure:** pick a bin by probability, pick an hour uniformly
inside it, a uniform second inside that hour, add jitter `(rand−0.5)×900` s
(±7.5 min), clamp to `[startHour×3600, endHour×3600 − 1]`. So the distribution is
piecewise-uniform per bin, NOT peaked within a bin.

**Pairing rules:** home is drawn once; work is redrawn (up to 100×, then the home
time is redrawn) until `|work − home| ≥ 90 min` (`MIN_GAP_MINUTES = 90`) and
`work !== home`. There is **no ordering constraint** — work-before-home pops are
normal and the game produces them too (night shifts).

**Pop kinds** are selected by **`jobId` prefix**, not the residence:

| prefix | slots |
|--------|-------|
| `AIR_` | dampened by `getAirportDampening()` (default **0.5**) **and mirrored** |
| `UNI_` | dampened by `getStudentDampening()` (default **0.3**) |
| other | the plain table |

**`popTiming` API shape correction:** the docs describe `CommuteTimeRange` as
`{start, end}` with defaults `[{7,9},{17,19}]`. That is wrong:
`getCommuteTimeRanges()` returns the 11 full-day bands above including both
multipliers, and `setCommuteTimeRanges` rejects entries missing any of the four
numeric fields. `popTiming` also exposes `get/setStudentDampening`,
`get/setAirportDampening`, `resetCommuteDampening` (undocumented in our v1.0.0
typings; now marked optional + feature-detected).

Anchors: `assignCommuteTimes`, `generateTimeSlots`,
`generateDepartureTimeBasedOnDemand`, `TIME_OF_DAY_RANGES`, `MIN_GAP_MINUTES`.

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

## `utils.loadCityData` is broken (v1.4.10) — read the data server instead

`api.utils.loadCityData(path)` can never succeed in this build. Its body does:

```js
const { loadData } = await import("./helpers/loadData");
```

Under the game's `file://` origin that specifier resolves to a path that does not
exist, so every call fails with:

```
GET file:///…/Programs/Subway Builder/game/reso…  net::ERR_FILE_NOT_FOUND
[Modding API] loadCityData failed for path: /data/DEN/roads.geojson
    TypeError: Failed to fetch dynamically imported module
```

This is path-independent: no mod can read city data through the API.

**What the game itself does** (`loadData`, which the API only *wraps*): it asks the
main process for a local HTTP data-server port and fetches the file from it,
preferring a gzipped sibling:

```js
const port = await window.electronAPI.getDataServerPort();          // cached per page
const base = `http://127.0.0.1:${port}${path}?useDownloaded=true`;  // USE_DOWNLOADED_CITY_DATA === true
// for a non-.gz path, try `${path}.gz` first:
const buf  = await (await fetch(`${base_gz}`)).arrayBuffer();
const text = await new Response(
  new Response(buf).body.pipeThrough(new DecompressionStream('gzip'))).text();
JSON.parse(text);
```

Same server, same bytes, no extra privilege — it is what serves the map's own
roads. Replicated in `src/game/cityData.ts` (`loadCityJson`). Caveat: the API route
shows the user a "mod is reading city data" notice, and going direct skips it, so
log what you read.

`loadDataFileAbsolute` (the absolute-path branch of `loadData`) is **not** exposed
by the preload, so that branch is dead too.

Anchors: `loadCityData`, `loadData`, `resolveDataPath`, `getDataServerPort`,
`decompressGzip`, `USE_DOWNLOADED_CITY_DATA`.

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
