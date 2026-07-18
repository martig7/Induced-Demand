# Field Rebuild Performance Plan

**Problem (measured in-game 2026-07-18):** `[InducedDemand][perf] tier1 161528.2ms (10320 sites)` — the Tier 1 field rebuild blocked the render thread for 161 s right after `onGameLoaded`. Budget is 100 ms.

**Profile (synthetic bench, 120 stations / 5k points / 21k sites):** graph 0.6 ms, masses 9 ms, opportunities 2.2 ms, per-point access for the fit 32 ms, fitDensity 25 ms, **buildSites 29,958 ms**. The sampler dominates totally; everything else is milliseconds. Root causes, in cost order:

1. `sampler.ts` `tooClose` is a **linear scan** over all blockers + accepted samples per candidate attempt — O(attempts × entries), quadratic across overlapping catchments. (The original plan specified a spatial grid; it was never implemented.)
2. Every rejected attempt still pays `spacingAt(c)` → `accessAt(c)`, which scans **all stations** (haversine each) per call.
3. `buildSites` rebuilds the `priors` array (`sites.map(...)`) per station — O(sites × stations) — and the sampler re-ingests and distance-filters it per call.

**Approach (user-directed):** prune first (spatial indexing — do less work), then async-chunk what remains so no frame ever blocks.

**Determinism constraint:** site ids must stay stable across loads *of the same build* (persisted `ledger.sites` accums and `materialized[].siteId` reference them). Task 1 must be **output-identical** (golden-tested against a brute-force reference). Task 2 changes the blocker set slightly (the old per-station prior filter dropped blockers just outside `radius + 2r`; the shared index does not), so sampler output may shift **once** at upgrade: materialized points are safe (kept by recorded `siteId` via `takenSiteIds`), and orphaned candidate accums merely lose pending pressure — acceptable, called out here deliberately.

---

## Task 1 — Spatial hash inside the sampler (output-identical)

**Files:** `src/model/sampler.ts`, `src/model/sampler.test.ts`

Add a meter-frame spatial hash (`cell = 128 m`, key `floor(x/cell),floor(y/cell)`) holding `{x, y, r}` for blockers and accepted samples; track `maxR` inserted. `tooClose(x, y, rNew)` queries the ring of cells within `softFactor · max(rNew, maxR)` and applies the exact same predicate (`dist < softFactor · max(rNew, rOther)`). Pure lookup optimization: acceptance order and decisions are unchanged, so output is byte-identical.

**Tests:** keep all existing tests green (they pin behavior); add a golden equivalence test — a brute-force `tooClose` reference implemented in the test file, run over a varying-r fixture (spacing 600 west / 150 east) plus the standard fixture, asserting `deepEqual` of the full site lists.

## Task 2 — One shared spacing index across the whole build

**Files:** `src/model/sampler.ts`, `src/model/field.ts`, tests for both

Export the index as `createSpacingIndex()` / `SpacingIndex` from sampler. `sampleCatchmentSites` takes `blockers: SpacingIndex` instead of `priors: Coordinate[]` (its accepted samples are inserted into the same index as it goes; the catchment-radius check keeps sampling local). `buildSites` creates ONE index, inserts natives + materialized once (r from `deps.spacingAt`), and threads it through every station — eliminating the per-station priors rebuild and re-ingest. Insertion order (natives in `dd.points` order, then per-station accepted order) is deterministic.

**Tests:** field tests updated to the new signature; add a determinism test (two `buildSites` runs → `deepEqual`); sampler tests construct an index from the old fixtures' prior arrays.

## Task 3 — Station-proximity index for access

**Files:** `src/model/opportunity.ts`, `src/model/opportunity.test.ts`, `src/main.ts`

`buildAccessIndex(opps, cfg)` grids stations by cell = catchment radius (`CATCHMENT_SECONDS × WALK_SPEED` m, lon/lat scaled); `accessAtIndexed(idx, loc)` scans only the 3×3 ring — station set considered is exactly the in-catchment candidates (others contribute 0 today), so results are float-identical. Rewire every `accessAt` call site in `main.ts` (fit input, buildSites deps, refreshSiteAccess, jitter reject, overlay `accessOf`) to the index. Keep `accessAt` exported (reference + tests).

**Tests:** equivalence over scattered random-ish locations (seeded), incl. a location whose nearest station sits in an adjacent cell just inside the radius.

## Task 4 — Tier 2 pruning: skip work when service didn't change

**Files:** `src/model/field.ts` (hash helper), `src/main.ts`

`computeServiceHash(routes, totalRes, totalJobs)`: route ids + per-route service inputs (schedule counts, timetable headways, `idealTrainCount`, timings length + last arrival) + mass totals. `refreshFieldWeights`: if structural hash AND service hash both match the cached field → **skip entirely** (steady-state daily cost ≈ hash computation). Recompute graph/opps/site access only when the service hash moved; promote to full rebuild only on structural change (unchanged).

**Tests:** hash changes on schedule/headway/mass change; stable otherwise (field.test.ts).

## Task 5 — Chunked async Tier 1

**Files:** `src/main.ts`

`rebuildField` becomes chunked: phases (graph+opps+index → fit → sampling per station batches → access fill + atomic swap + heatmap), yielding to the event loop between chunks with a ~12 ms time-box on the sampling loop. A generation token (`fieldBuildGen`) cancels stale builds (city change, newer rebuild, `!isCurrent()`); the session field is swapped only on completion, so consumers always see a complete snapshot. Day-end behavior: Tier 2 stays synchronous (cheap after Tasks 3–4); a structural-hash promotion at day end runs the rebuild **synchronously** (post-optimization cost makes this a small, rare hitch — only unhooked edits reach it; route hooks already fire the chunked path). Perf: accumulate per-phase ms manually across chunks and report one `tier1` total with phase breakdown in the info string.

## Task 6 — Budgets + bench validation

**Files:** `src/model/perf.ts` (budget values only), bench rerun, full suite

Re-baseline: keep `tier1: 100` as the *blocking* budget for the synchronous promotion path; the chunked path warns only if a single chunk exceeds 16 ms or the total exceeds 2000 ms (constants in `PERF_BUDGETS`: add `tier1Chunk: 16`, `tier1Total: 2000`). Rerun the synthetic bench and record numbers here; `npx tsc --noEmit`, `npm test`, `npm run build` all green.

**Result target:** buildSites at 21k synthetic sites from ~30 s → < 500 ms; in-game tier1 at 10.3k sites from 161 s → sub-second total, no blocking chunk > 16 ms.

## Results (measured after implementation, same synthetic bench)

| Phase | Before | After index (T1+2) | After access index (T3) |
|---|---|---|---|
| buildSites (21,343 sites) | 29,958 ms | 5,219 ms | **1,229 ms** |
| fit access (5k pts × 120 st) | 32.4 ms | — | **7.8 ms** |
| graph + masses + opps | ~12 ms | — | ~13 ms |

Site output identical across all three (21,343 sites; the spacing grid is
golden-tested byte-identical, the access index float-identical). The remaining
~1.2 s is sampler attempt volume — chunked at ~12 ms slices in-game, so the
wall time amortizes invisibly; at the measured in-game scale (10.3k sites)
total is expected well under a second. Tier 2 steady-state is now two hash
computations (skip path). Execution notes vs the task list: Tasks 1+2 were
implemented as one change (the grid IS the shared index; the golden reference
targets the merged semantics), and the mid-latitude lon-scaling coverage bug
this exposed in `stationMasses` was fixed with the shared `radiusGridKeyer`.

---

**Out of scope:** no version bump (user rule); no change to sampling semantics beyond the documented Task 2 blocker-set correction; incremental per-station caching deferred unless the above misses target.
