# Driving distance, time and directions for induced pops — design plan (v2)

**Date:** 2026-07-12
**Status:** phases 1 and 2 built (2026-07-17); phase 3 deliberately not built
**Supersedes:** v1 of this file, which wrongly concluded the game never displays a
driving path and recommended a statistical model instead of real routing.

## Correction to v1

v1 claimed "directions are a no-op" from a single fact: `pop.drivingPath` is read
nowhere. That fact is true, but the conclusion was wrong — **the game does display
a commute path, it just does not source it from that field**:

```js
// GameMain, usePopDetailsLayers (pop-details view)
getRoutePathForPop(cityCode, selectedPop.id).then(setRoutePath);
const commuteLineData = routePath ? [routePath] : [
  { type: 'Feature', geometry: { type: 'LineString',
    coordinates: [homeDemandPoint.location, jobDemandPoint.location] } } ];   // fallback
new GeoJsonLayer({ id: 'pop-details-commute-path', data: commuteLineData,
                   getLineColor: [255, 0, 0, 255], getLineWidth: 4, ... });
```

`getRoutePathForPop` fetches `map://paths/<cityCode>/<popId>` and expects
`{coordinates}`, caching per pop.

Three further facts, all verified:

1. The main process's `map://` handler implements **only `/tiles/`** (its strings:
   `/tiles/`, "Rejected tile request to unauthorized host", "Unauthorized tile
   server"). There is no `/paths/` route.
2. **No city bundle ships path data** — DEN's tarball contains only
   `demand_data`, `roads.geojson`, `buildings_index`, `coastline`,
   `ocean_depth_index`, `runways_taxiways`.
3. Therefore `getRoutePathForPop` always fails → `routePath === null` → **every
   pop in this build, native and induced alike, renders the straight-line red
   fallback.**

So driving directions are a *dormant* feature with a live client and no server.
That reframes the opportunity: we are not "adding a field nothing reads", we can
**answer a request the game already makes**.

## What the game does for driving (verified)

Native pops ship precomputed in `demand_data.json`:
`{id, size, residenceId, jobId, drivingSeconds, drivingDistance}` — real road
routing done offline by the city pipeline. No path, no runtime recompute.

Consumption (`popCommuteWorker`, per commute):

| consumer | formula |
|---|---|
| mode choice: driving time | `pop.drivingSeconds` (as-is) |
| mode choice: walk time | `pop.drivingDistance / 1.5` (`WALKING_SPEED_ACCURATE_PATH`; airport pops at half speed) |
| mode choice: money cost | `drivingDistance / 1000 × 0.65` (`DRIVING_COST_PER_KM`) |
| park-and-ride access speed | `(drivingDistance / drivingSeconds) / congestion` |

`drivingDistance` doubles as the **walking** distance. Congestion
(`DRIVING_TIMES`: 0.7 / 0.85 / 1 / 1.15 / 1.3 by the departure hour's band) applies
**only** to park-and-ride access — never fold it into `drivingSeconds`.

## The bug

`makeInducedPop` fabricates both numbers: `haversine × 1.30`, then `÷ 11 m/s`.
Measured against real pops (medians by straight-line band):

| band | real detour | real speed | ours |
|------|------------|-----------|------|
| 0-2 km | 1.51 | 8.9 m/s | 1.30 / 11 |
| 5-10 km | 1.38 | 13.0 m/s | 1.30 / 11 |
| 20 km+ | 1.29 | 18.2 m/s | 1.30 / 11 |
| **overall** | **1.35** | **14.6 m/s** | 1.30 / 11 |

Speed is **~33% too low**, so driving looks worse than it is and our pops choose
**transit more often than comparable native pops** — inflating the ridership our
own mod reports. Both quantities also vary with trip length; we model them flat.
A flat model additionally cannot know about barriers: a trip across a bay gets
1.30 when reality is 3×.

## Feasibility: measured, not assumed

Prototype built against real DEN data (`scratchpad/router_proto.cjs`):

| fact | value |
|---|---|
| `roads.geojson` | 25.7 MB raw (5.6 MB gz), 60,301 ways |
| properties | `roadClass` ∈ {highway, major, minor}, `structure` (always "normal"), `name` — **no oneway, no maxspeed** |
| graph after splitting ways at junctions | 124,751 nodes / 349,300 directed edges |
| parse + build | 0.26 s + 1.7 s ≈ **2 s, once per city** |
| A* (time-weighted, haversine/vmax heuristic) | **4.5 ms/query**, ~8.5k heap pops |
| unroutable (snap or disconnect) | 5/300 = 1.7% |

Accuracy after fitting the three class speeds by least squares against native
pops (`secs ≈ Σ Lclass / vclass`), two passes:

```
fitted speeds: highway 20.3 m/s (73 km/h), major 12.7 (46), minor 8.4 (30)
routed/real DISTANCE   p10 0.896   median 0.988   p90 1.090
routed/real TIME       p10 0.757   median 0.940   p90 1.084
detour: routed 1.324 vs real 1.341   (flat model: 1.30)
```

**Distance lands within 1.2% of the game's own routing at the median.** Note
routing on *distance* instead of time gives median 0.942 — the game's router
minimizes time, so ours must too.

Data access: `api.utils.loadCityData('/data/<CITY>/roads.geojson')` — the same
`loadData` helper the game uses, transparently handling `.gz` via the local data
server. It emits a one-time user-visible security notice ("mod … is reading city
data"), which is acceptable and honest.

## On contraction hierarchies

CH is the right tool when queries are many and preprocessing amortizes. Our
workload is the opposite, so the numbers do not support it:

| workload | A* @4.5 ms | CH @~0.1 ms |
|---|---|---|
| steady state (~17 new pops/day) | 77 ms/day | 2 ms/day |
| one-time backfill of ~1,400 legacy pops | 6.3 s (chunkable) | 0.14 s |
| calibration sample (300 pairs) | 1.4 s | 0.03 s |
| pop-details click | 4.5 ms | 0.1 ms |
| **preprocessing** | **0** | **tens of seconds on 125k nodes in JS, + hundreds of MB, per city, at load** |

We would pay ~30-60 s of preprocessing to save ~6 s of routing. That is a net
loss at this volume, and it lands on the renderer thread at load — the worst
possible moment. **Recommendation: A* now.**

What we *do* take from the hierarchical idea, at near-zero cost:

- **Degree-2 chain contraction** — already in the prototype: ways are split only
  at junction nodes, which is what keeps the graph at 125k nodes instead of 557k
  (a 4.5× reduction, and the single biggest win available).
- **OD-pair cache** keyed `residenceId→jobId`; gravity pairing reuses point pairs,
  so hits are free.
- **Class-pruned search** (optional, if profiling ever demands it): once beyond a
  radius of both endpoints, restrict expansion to `major`/`highway`. This is the
  cheap 80% of "hierarchical decomposition" with no preprocessing.

The router will sit behind a `DrivingRouter` interface (`route(a, b) → {distance,
seconds, path}`) so a CH implementation can replace A* without touching callers,
**if** a future workload justifies it (e.g. routing all 9k native pops every load,
or a live "reroute everything" feature). Revisit then, with a profile.

## Design

**`src/model/roadGraph.ts` (pure).** `buildRoadGraph(geojson) → RoadGraph`:
splits ways at junction nodes into typed arrays (`to`, `len`, `class`, `next`,
`head`), plus a coordinate grid for snapping. No game imports.

**`src/model/router.ts` (pure).** `createRouter(graph, speeds) → DrivingRouter`
with `route(from, to)` doing time-weighted A* (haversine/vmax heuristic, binary
heap), returning `{ distance, seconds, path }` or `null`. Includes the snap
distance in `distance`, as the prototype does.

**`src/model/speedFit.ts` (pure).** `fitSpeeds(router, samples) → {highway,
major, minor}`: least-squares on per-class path lengths vs native `drivingSeconds`,
2 passes, clamped to [2, 45] m/s, then a **median-ratio correction** so
`median(routed/real time)` lands on 1.00 rather than 0.94. Sample = up to 300
native pops, deterministic (sorted by pop id).

**`src/model/drivingModel.ts`.** Owns lifecycle and fallbacks:
`route(resId, jobId, resLoc, jobLoc)` → cache → router → on failure the v1
**bootstrap fallback** (resample detour/speed from native pops in the same
distance band, seeded by pop id), and if even that is unavailable, the constant
band table. So a city with no roads data still improves on today's flat model.

**Wiring.** Mirrors the existing `SlotSet` threading: built in `main.ts` per city,
passed into `makeInducedPop`/`addInducedPop`/`runDay`/`reconcileInducedPops` with
a default. `DETOUR_FACTOR`/`DRIVE_SPEED` retire from `config.ts` into the fallback
table.

**Lifecycle.** The graph is built **lazily on first use** and cached per city on
the window session object (survives mod reload, like the ledger). Loading and
building happen off the critical path (`requestIdleCallback`), and pop creation
uses the fallback until the graph is ready — never block the renderer for 2 s at
load.

**Rescue.** Driving values become deterministic per pop id, so `commuteRescue`'s
existing rule extends unchanged: recompute, compare, repair **in place**. This
retroactively fixes the ~1,400 legacy pops carrying 11 m/s values. As with
commute times: never delete/re-add.

## Directions (phase 2) — BUILT

With a router we can answer the request the game already makes. `window.fetch` is
patched **narrowly**:

- intercept **only** `map://paths/<city>/induced:*` — never native pops, never any
  other URL;
- try the real fetch first and only synthesize on failure, so if the game ever
  ships real paths, its data wins;
- return `{coordinates}` from the cached route; on any error fall through to the
  game's straight-line fallback (i.e. today's behavior).

Precedent: we already patch `console.error` for `movementRepair`. Cost is one
route per pop-details click (4.5 ms, cached). Effect: clicking an induced pop
draws its **real road route** in red instead of a straight line — strictly better
than native pops, which still get the straight line.

**As built** (`src/game/routePathServer.ts`, wired in `main.ts`): exactly the rules
above. Two things the implementation added that the plan missed:

- **Way geometry was needed.** The router contracts degree-2 chains, so a route's
  junction nodes alone cut every curve — measured on Denver, drawing junction-only
  would misstate the route length by up to **8.1%**. `buildRoadGraph` now takes
  `{ keepGeometry: true }` and `pathCoordinates(graph, route)` reassembles the true
  shape (drawn polyline vs routed distance: **0.000%** error over 195 real routes;
  ~329 shape points vs ~70 junctions per route). Geometry is opt-in because it costs
  ~50 MB of heap on Denver and only the drawing needs it.
- The path is drawn from the demand points themselves, not the road nodes we snapped
  to, so the line reaches the home and job markers.

`pop.drivingPath` remains unset — correctly, since nothing reads it.

## Testing

Pure modules, `node:test`:

- `buildRoadGraph`: junction splitting, degree-2 contraction, node dedupe,
  Multi/LineString handling, empty input;
- `router`: known toy graph shortest paths; time-weighting prefers the faster
  class over the shorter minor road; unroutable pairs return null; snapping
  picks the nearest node;
- `fitSpeeds`: recovers known speeds from synthetic samples; clamps; median
  correction centers the ratio;
- `drivingModel`: cache hits; deterministic per pop id; falls back to bootstrap
  then constants; induced pops are never calibration samples;
- rescue: legacy 1.30/11 pop repaired in place; identity, size, endpoints,
  `popsMap` membership and demand unchanged; idempotent.

**Acceptance (beyond unit tests):** re-run the prototype's comparison on a live
city and require `median(routed/real distance)` ∈ [0.95, 1.05] and
`median(routed/real time)` ∈ [0.95, 1.05] against native pops, per band. Ship the
comparison as a scratch script so it can be re-run per city.

## Staging

1. **Phase 1** — DONE. graph + A* + speed fit + `drivingModel` + rescue. Validated
   on holdout pops in DEN/NYC/SF: distance and time medians within 1%
   (`npx tsx scripts/validateDriving.ts`).
2. **Phase 2** — DONE. `map://paths/.../induced:*` is served, so the game draws our
   pops' real road routes instead of a straight line.
3. **Phase 3** — CH, still not justified at ~17 queries/day. Revisit with a profile.

## Open questions

1. **Phase 2 fetch patching** — acceptable, or keep the mod out of the game's
   network layer?
2. **Security notice** — `loadCityData` shows the user "mod … is reading city
   data (/data/DEN/roads.geojson)" once. Fine, or should the router be opt-in
   behind a panel toggle so the notice only appears if asked for?
3. **Time fit spread** — distance matches to ~1%, but time p10/p90 is 0.76/1.08.
   Accept (medians are what bias mode choice), or add per-class speeds that vary
   with trip length (more parameters, better tails)?
