# Access-Field Infill — Design

**Date:** 2026-07-17
**Status:** Approved (brainstormed with user)

## Goal

Let induced demand create **new demand points in empty areas**, not just grow
existing ones. Growth becomes spatial: a single **access field** of sites drives
both infill (new points condense where access is high and land is empty) and
growth at existing points, through one unified daily loop. The targeting/debug
display becomes a heatmap of that same field.

Realism requirements from the user:

- Placement looks organic (Voronoi/blue-noise, not a grid), never on water.
- Density is calibrated from the city's own data, capped by what the map
  already exhibits, with slow densification as the city saturates.
- Access measures *reachability to opportunity* (transfers, city core), not
  just station proximity — and it is directional (residential vs commercial).
- Cheap: no per-day recomputation of anything expensive.

## Verified game facts this design rests on

1. **Save/load is city-file-authoritative** (decoded from `index-BPPTEB3h.js`):
   `compressDemandData` writes all pops/points unfiltered, but `loadSave`
   rebuilds demand from `demand_data.json` and overlays only runtime fields for
   ids the city file already contains. Mod-created points and pops are
   **silently dropped on every real load** → they must be re-created by the mod
   (ledger), and there is no save-corruption risk.
2. **Write path** is in-place mutation of the live Maps from
   `getDemandData()`; no schema validation on live data. New `points` entries
   are accepted by the sim, which reads the store live each cycle.
3. **`ocean_depth_index.json.gz`** ships per city (verified ATL: `cs`/`bbox`/
   `grid` + `cells` `[col,row,...polyIds]` + `depths[].p` polygon rings; covers
   lakes/rivers, not just ocean). O(1) water test: grid cell lookup →
   point-in-polygon against that cell's few polygons. Loads via the data server
   (`loadCityJson`, gz sibling), ~2.4 MB parsed, once per city.
4. **Real station-graph weights exist in the API**: `Route.stComboTimings`
   (per-stNode arrival/departure → ride times incl. dwell),
   `Station.nearbyStations` (`{stationId, walkingTime}` — the game's own
   transfer basis), `getStationGroups()`/`getSiblingStationIds()`
   (interchanges), `Route.trainSchedule` + `idealTrainCount` + `getTrains()`
   (headway → expected wait ≈ headway/2, cycle time from last timing arrival).
5. **Existing invariants carry over**: every pop in `popsMap` must reference
   live points (commute-worker throws otherwise); retired pops are size-0
   tombstone stubs, never deleted; `loadGuard` classifies real loads.

## Architecture

### 1. Site field

A **site** is a fixed location that can hold demand.

- **Native sites** — one per city demand point; born occupied; keep the
  baseline-multiplicative cap `baseline × (1 + K_MAX·score·densify)`.
- **Candidate sites** — blue-noise samples (Bridson Poisson-disc with
  spatially-varying radius `r(access)`) covering station catchments; born
  empty. Sampled **per-station-catchment**, seeded by `city + stationId`
  (deterministic), deduped across overlapping catchments by station age
  (older station wins), and rejected if in water. Existing demand points
  participate as prior samples so spacing respects the built city.

Candidates re-derive identically on every load (deterministic seeds) — site
positions are **never persisted**; only sparse nonzero accumulators and
materialized-point records are.

Adding a line elsewhere does not reshuffle existing candidates (per-station
sampling), so accumulators survive network edits; new catchment area simply
adds sites.

### 2. Access v2 — directional reachability to opportunity

Replaces the line-count connectivity term (`CONNECTIVITY_REF` retires).

- **Station graph** (rebuilt on network change only): ride edges from
  `stComboTimings`; transfer edges from `nearbyStations` walk times;
  interchange edges (≈free) from station groups/siblings; per-route boarding
  wait from headway (cycle time ÷ train count, halved). Fallback if timings
  are missing on a route: distance ÷ nominal transit speed, same structure.
- **Opportunity per station** (Dijkstra per station, network change only):
  `O_jobs(s) = Σ_s' jobsMass(s')·exp(−t(s,s')/TAU_REACH)` and likewise
  `O_res(s)` with residents mass. `mass(s')` = residents/jobs within s'
  catchment via a grid index over points. Normalized against total city mass.
- **Access at a location** (cached per site, O(1) daily):
  `accessRes(ℓ) = walkProx(ℓ) × (floor + (1−floor)·Ô_jobs(nearest station))`,
  `accessCom(ℓ)` likewise with `Ô_res`. `walkProx` unchanged (Gaussian decay,
  `TAU_ACCESS`, catchment-gated, routed stations only).

Directionality mirrors gravity pairing: residences are valuable where **jobs**
are reachable; job sites are valuable where **residents** are reachable.
`residentialScore`/`commercialScore` consume the side-specific access and keep
their mode-share modulator.

### 3. Density calibration — the city teaches its ceiling

Fit once per city + network change, cached in localStorage (`speedFit`
pattern), keyed by city + network hash. From native points only:

- Per point: access (from §2), nearest-neighbor distance (grid index,
  O(P log P)), people mass (`residents + jobs`).
- Bin by access. **Spacing curve** `r(access)`: low quantile of NN distance per
  bin (dense exemplars), clamped `[R_MIN, R_MAX]`, monotone non-increasing.
  **Mass curve** `M(access)`: upper quantile (~P80) of people mass per bin,
  monotone non-decreasing.
- **Envelope clamp** `D_MAX`: ~P95 of native people mass. Induced sites can
  never out-dense what the map demonstrates.
- Sparse/empty bins borrow from the nearest populated bin below; a city with
  no usable fit (young transit) degrades to flat city-wide quantiles.

**Saturation creep**: daily, `σ` = filled fraction of aggregate induced
headroom (sums already computed in the loop). While `σ > SAT_THRESHOLD`
(~0.8): `densify ← densify × (1 + RHO_DENSIFY·(σ − SAT_THRESHOLD))`,
`RHO_DENSIFY` ≈ 0.002/day. Monotone (never shrinks), persisted per city in the
ledger, applied to induced headroom everywhere: empty-site caps **and** the
`K_MAX·score` term at native sites. Densification raises **people per site**,
never site count — spacing stays fixed between network changes (stable tiling,
no heatmap shimmer).

### 4. Placement — static points, noisy condensation, soft spacing

- Nominal candidate positions are the deterministic lattice.
- On condensation, the real `DemandPoint` lands at a **jittered** position:
  offset seeded by point id (FNV-1a → mulberry32, as `commuteTimes`), radius
  ≤ `J_FRAC·r(ℓ)` (J_FRAC ≈ 0.35). Frozen forever once placed.
- **Soft spacing**: sampler rejection radius and the "existing point blocks
  condensation" test both use `(1−J_FRAC)·r`, so jitter reads as organic
  scatter instead of compounding displacement.
- Jittered position is re-tested against **water** and soft spacing; on
  failure, deterministic re-roll (seed + attempt counter, ≤ 4 tries), then
  fall back to the nominal position (already water-checked at sampling).
- **Water is the only land mask** (no road mask — players cannot build roads,
  and transit-led development on virgin land is the point of the mod).

### 5. Unified growth loop (engine refactor)

`runDay` iterates **sites** (native + candidate), not `dd.points`:

1. **Accumulate** — same logistic pressure math per site, using cached
   directional access. Empty-site caps: `capRes = RES_SHARE·M(accessRes)·densify`,
   `capJob = JOB_SHARE·M(accessCom)·densify` (absolute people, baseline 0).
2. **Allocate & pair** — one shared budget across all sites
   (`allocateInteger` + `pairByGravity` unchanged; empty sites enter the pools
   by their nominal location).
3. **Condense** — when an empty site first receives a pop: create
   `DemandPoint` (`induced-pt:<seq>`) at the jittered position, record in
   ledger, then `addInducedPop` targeting it. Infill is growth landing on
   empty ground — no separate subsystem.
4. **Decay** — unchanged (deferred removals, tombstones). A materialized point
   whose pops all retire stays as an inert husk in-session and is simply not
   re-created on the next real load (the game's load-drop garbage-collects
   it); its ledger record is dropped and the site returns to candidate duty.

Net-equal growth, tombstone, and live-endpoint invariants are unchanged.

### 6. Persistence & ledger

Ledger additions (localStorage, existing serialize path):

- `sites` — sparse accumulators keyed by deterministic site id (nonzero only).
- `materializedPoints` — `{ id → { location, nominalSiteId } }`.
- `densifyMultiplier` — per city, monotone.

**Load order** (extends current reconcile): re-create `materializedPoints`
first → `reconcileInducedPops` re-adds roster pops (which may reference
`induced-pt:*` endpoints) → `applyPendingAccum`. `reconcileBaselines` skips
`induced-pt:*` points (baseline 0 by construction; caps come from the fit).
Tombstone stubs may anchor to materialized points only after re-creation.

Save bloat from our points entering `compressedDemandData` is harmless
(verified: never restored).

### 7. Heatmap overlay

MapLibre native `heatmap` layer over the site field via the existing
`registerOverlay` pipeline (own source/layer). Weight = site score; panel view
cycle: **residential access / commercial access / growth pressure**. Rebuild on
network change; `setData` on day change. The `demandBubbleScale` nudge stays —
it is what makes the *native* dot layer notice newly materialized points.

### 8. Recalculation triggers & performance budget

Two-tier trigger model (user decision — overlap heavy work with build
gestures; never chase train events):

- **Tier 1 — structural rebuild** on `onRouteCreated` / `onRouteDeleted` /
  `onStationBuilt` / `onStationDeleted`, **debounced** (short idle delay —
  blueprints and batch edits fire event bursts). Full pass: graph topology,
  new-catchment sampling, density fit, Dijkstra, access cache, heatmap
  rebuild. Lands right after the user's edit, where a few ms is
  perceptually free.
- **Tier 2 — weight refresh** on day end, every day, before the growth step:
  re-read live train counts → headway/wait weights → Dijkstra → opportunity →
  cached per-site access. No subscription to `onTrainSpawned`/`onTrainDeleted`
  (users batch-add trains; per-event recompute is a perf hazard). Side
  benefit: demand-mass sums refresh daily, so opportunity tracks the growing
  city, not just network edits.
- **Safety net**: Tier 2 compares a cheap structural hash (route ids +
  per-route station-id lists); a mismatch promotes the refresh to a Tier 1
  rebuild. Covers any route-edit path that fires no hook.

| Work | When | Cost |
|---|---|---|
| Station graph + per-station Dijkstra + mass sums | Tier 1 (debounced structural events) | S ≤ ~200 stations → ms |
| Density fit (NN + quantile bins) | load / Tier 1 | O(P log P), P ≈ 6k → ms |
| Blue-noise sampling + water mask | Tier 1, new catchment area only | O(area/r²), few k candidates |
| Water index load + parse | once per city | ~2.4 MB JSON |
| Weight refresh (Dijkstra + opportunity + access cache) | Tier 2 (day end) | ms |
| Daily growth loop | day end, after Tier 2 | O(sites); access cached O(1) — cheaper per site than today |
| Heatmap refresh | day change | one `setData` |

### 9. Module layout

New pure-function modules (tested standalone, `node:test`/tsx):

- `src/model/stationGraph.ts` — graph build from routes/stations, edge weights.
- `src/model/opportunity.ts` — Dijkstra, per-station `O_jobs`/`O_res`, access v2.
- `src/model/densityFit.ts` — bins, quantile curves, envelope, saturation creep.
- `src/model/sampler.ts` — seeded Bridson with varying radius, soft spacing, jitter.
- `src/game/waterIndex.ts` — load + O(1) point-in-water test.
- `src/model/field.ts` — site set management (per-station sampling, dedup, ids).
- `engine.ts` — refactored to iterate sites (existing tests migrate).
- `ledger.ts` — new fields, load-order extension.
- `src/overlay/heatmap.ts` + panel toggle.

### 10. Testing

- Unit: graph weights from fixture routes (incl. missing-timings fallback);
  Dijkstra opportunity; fit monotonicity + sparse-bin fallback + envelope;
  sampler determinism, spacing, jitter re-roll, water rejection; condensation;
  saturation creep monotonicity; ledger round-trip incl. load order.
- Migrated: all engine invariant tests (net-equal, caps, decay, tombstones)
  over the site abstraction.
- In-game verification checklist (before calling it done):
  1. `trainSchedule` field semantics (counts vs headway seconds).
  2. `stComboTimings` populated on live routes.
  3. Native demand-dot layer picks up materialized points (nudge).
  4. Commute worker tolerates mid-session point additions (expected: yes,
     reads live Maps each cycle).
  5. `ocean_depth_index` availability across cities (fallback: no water mask
     for that city + console warning).
  6. Whether editing an existing route's stops fires `onRouteCreated` (or any
     hook). If not, the Tier 2 structural-hash safety net is the only catch —
     verify it detects an in-place route edit by the next day end.

### 11. Config additions (`config.ts`)

`TAU_REACH`, `R_MIN`, `R_MAX`, `J_FRAC`, `RHO_DENSIFY`, `SAT_THRESHOLD`,
`FIT_SPACING_QUANTILE`, `FIT_MASS_QUANTILE`, `ENVELOPE_QUANTILE`,
`RES_SHARE`/`JOB_SHARE` (empty-site cap split), nominal transit speed
(timings fallback). Removed: `CONNECTIVITY_REF` (line-count connectivity).

## Out of scope

- Roads-based buildability mask (explicitly dropped — user decision).
- Serving driving paths for induced pops (`map://paths`) — separate feature.
- Any modification of city data files; the ledger remains the only authority
  for mod-created state.
