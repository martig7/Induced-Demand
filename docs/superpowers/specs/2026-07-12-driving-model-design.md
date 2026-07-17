# Driving distance/time for induced pops — design plan

**Date:** 2026-07-12
**Status:** proposed (not yet approved)

## What the game actually does (verified)

Evidence: v1.4.10 bundles deobfuscated (`scripts/` + the string-table decoder
described in `docs/DEMAND_API.md`) and the shipped city data on disk
(`%APPDATA%/metro-maker4/cities/data/<CITY>/demand_data.json.gz`).

**Native pops ship with driving values precomputed.** `demand_data.json` carries
`{id, size, residenceId, jobId, drivingSeconds, drivingDistance}` per pop — real
road routing done offline by the city-data pipeline, not at runtime. The game
never recomputes them.

**`drivingPath` is dead weight.** The Pop schema has an optional
`drivingPath: [[lon, lat], ...]` ("Optional driving route … GeoJSON LineString"),
but:

- **0 of 9114** DEN pops (and 0 in NYC/CHI/SF/BOS) carry one;
- the string `drivingPath` appears **only** in the schema and in the modding
  `map.queryRoute` parsers. Neither `GameMain`, `popCommuteWorker` nor
  `simEngine` reads it.

So writing driving *directions* changes nothing in-game. See "Directions" below.

**How the two numbers are consumed** (`popCommuteWorker`, per commute):

| consumer | formula |
|---|---|
| mode choice: driving time | `drivingTime = pop.drivingSeconds` (used as-is) |
| mode choice: walk time | `pop.drivingDistance / 1.5` (`WALKING_SPEED_ACCURATE_PATH`; airport pops walk at half speed) |
| mode choice: driving money cost | `drivingDistance / 1000 × 0.65` (`DRIVING_COST_PER_KM`) |
| park-and-ride access speed | `(drivingDistance / drivingSeconds) / congestion` |

Note `drivingDistance` doubles as the **walking** distance, so it is not a
driving-only field.

**Congestion** (`DRIVING_TIMES`, keyed by the departure hour's band via
`max(homeDemandMultiplier, workDemandMultiplier)`):
`VERY_LOW 0.7, LOW 0.85, LOW_MEDIUM 1, MEDIUM 1.15, HIGH 1.3`. It is applied
**only** to park-and-ride access speed — *not* to the main driving time. We must
not add congestion to `drivingSeconds`; the game would double-count it.

## The bug this exposes

We fabricate both numbers in `makeInducedPop`:

```ts
drivingDistance = haversine(res, job) * 1.30   // DETOUR_FACTOR
drivingSeconds  = drivingDistance / 11         // DRIVE_SPEED m/s
```

Measured against the real pops (median, straight-line distance bands):

| band | real detour | real speed | ours |
|------|------------|-----------|------|
| 0-2 km | 1.51 | 8.9 m/s | 1.30 / 11 |
| 2-5 km | 1.42 | 10.7 m/s | 1.30 / 11 |
| 5-10 km | 1.38 | 13.0 m/s | 1.30 / 11 |
| 10-20 km | 1.34 | 15.4 m/s | 1.30 / 11 |
| 20 km+ | 1.29 | 18.2 m/s | 1.30 / 11 |
| **overall** | **1.35** | **14.6 m/s** | 1.30 / 11 |

Two systematic errors:

1. **Speed is ~33% too low overall** (11 vs 14.6 m/s median), so our pops'
   driving times are inflated, driving looks worse than it is, and they choose
   **transit more often than comparable native pops** — inflating the ridership
   our induced demand produces. This is the material bug.
2. **Both quantities vary strongly with trip length** and we model them as flat.
   Short trips are slower and more circuitous; long trips faster and straighter.

The shape is consistent across all five cities checked; the *level* is
city-specific (20 km+ speed: SF 19.4, DEN 18.2, CHI 16.7, BOS 16.8, NYC 15.7 m/s).
So the model must be calibrated **per city**, not hardcoded.

## Proposal: bootstrap from the city's own pops

At load, learn the relationship from the native pops already in `popsMap`, then
resample it. No routing, no network, no fitted curve to go stale.

**Build (once per load, O(pops)) — `src/model/drivingModel.ts`:**

```
for each native pop (id NOT starting with `induced:`) with resolvable endpoints
    and drivingSeconds > 0:
  h      = haversine(residence.location, job.location)     // skip h < 1 m
  detour = drivingDistance / h
  speed  = drivingDistance / drivingSeconds
  push {detour, speed} into the band for h
bands: [0-2km, 2-5km, 5-10km, 10-20km, 20km+]   // same cuts as the analysis
```

**Use (per induced pop):**

```
h     = haversine(res, job)
band  = bandFor(h)  (nearest non-empty band if h's band is empty)
donor = band.donors[ seededIndex(popId) ]        // same FNV-1a → mulberry32 as commuteTimes
drivingDistance = h * donor.detour
drivingSeconds  = drivingDistance / donor.speed
```

Taking **both** values from the *same* donor preserves their correlation, and
resampling reproduces the band's full empirical spread rather than collapsing to
a median. Seeding by pop id keeps a restored pop identical with nothing extra
persisted — the same property `commuteTimes` relies on.

**Fallback** when a city has no usable donors (blank/custom city): a constant
table of the median detour/speed per band, derived from the shipped cities and
checked in as `DEFAULT_DRIVING_BANDS`. Strictly better than today's flat 1.30/11.

**Exclusions.** Induced pops are never donors (they would feed our own estimate
back in). `AIR_`/`UNI_` pops need no special case: measured detour 1.38 / speed
16.0 vs 1.35 / 14.5 for normal pops, a gap explained by their longer trips, which
the distance banding already handles.

## Wiring

Mirrors the `SlotSet` threading already in place:

- `buildDrivingModel(dd): DrivingModel` in `main.ts`, once per load, alongside
  `liveSlotSet()`.
- `makeInducedPop(..., cfg, slots, model?)` / `addInducedPop(..., model?)`;
  default `DEFAULT_DRIVING_MODEL` keeps every call site and test working.
- `runDay(..., slots, model?)` and `reconcileInducedPops(..., slots, model?)`
  pass it through, exactly as `slots` already is.
- Retire `DETOUR_FACTOR` and `DRIVE_SPEED` from `config.ts` (they become the
  fallback table's concern).

**Rescue.** `commuteRescue` already retimes pops whose stored times differ from
the generated ones. Driving values are now deterministic per pop id too, so the
same module can repair legacy pops' `drivingDistance`/`drivingSeconds` in place
(same rule: recompute, compare, fix; never delete/re-add). This retroactively
fixes the ~1400 pops in the current save that carry the 11 m/s values.

## Directions (`drivingPath`) — recommend NOT building

Nothing in the game reads it, and no shipped pop has one, so populating it is
invisible. If you want it anyway, the only honest reasons are our own overlay or
export, and the options are:

1. **`api.map.queryRoute(serviceId, origin, dest)`** — real routes via
   OSRM/Valhalla/GraphHopper, but requires the user to register an external
   routing service (`setRoutingServiceOverride`), is `async` + per-pop
   network-bound (thousands of pops), and yields nothing offline.
2. **Self-route on `roads.geojson`** — the data is local (DEN: 5.6 MB gzipped)
   and the store exposes `roadsGeojson`/`roadsIndex`, but this means building a
   routable graph and running A* per pop: a large subsystem for zero gameplay
   effect.
3. **Straight line / simple dogleg** — cheap, but a fake path is worse than no
   path: it would claim precision we do not have.

Recommendation: skip. Revisit only if we build a "where do induced commuters
drive?" overlay, and then prefer (1) behind an explicit opt-in.

## Testing

Unit tests (pure modules, `node:test`):

- band assignment incl. boundaries and the empty-band fallback;
- donor selection is deterministic per pop id, and stable under donor-pool
  reordering (sort donors by pop id);
- induced pops are never donors; `drivingSeconds > 0` always; `h < 1 m` handled;
- a statistical test: over many induced pops, the produced detour/speed medians
  per band match the donor pool's within tolerance;
- `DEFAULT_DRIVING_BANDS` is used when the pool is empty;
- rescue: a legacy pop (1.30/11) is repaired in place; object identity, size,
  endpoints, `popsMap` membership and demand all unchanged; idempotent.

Verification beyond unit tests: re-run the `analyze.cjs` comparison against a
live save's induced pops and confirm their detour/speed distributions sit inside
the native ones, per band.

## Open question for review

Calibration uses the pops **present at load**. If a city's native pops are ever
sparse in a band (e.g. very few 0-2 km trips in a small city), the donor pool for
that band is thin and resampling repeats a handful of donors. Mitigation if it
matters: widen to the nearest non-empty band when a band has < N donors
(N ≈ 20). Proposed default: N = 20.
