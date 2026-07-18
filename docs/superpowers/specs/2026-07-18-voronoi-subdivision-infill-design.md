# Voronoi-Subdivision Infill — Design

**Date:** 2026-07-18
**Status:** Approved (brainstormed with user)
**Supersedes:** the candidate-site half of
`2026-07-17-access-field-infill-design.md` (§1 sampling, §4 placement, and the
`densify` multiplier of §3). Access v2 (§2), the density fit curves (§3), the
persistence architecture (§6), and the two-tier recalculation (§8) carry over.

## Problem

The blue-noise candidate field infills far too aggressively: every candidate
site accrues pressure from day one and competes in the shared growth budget, so
new points blanket the map *before* existing demand saturates. Secondary
symptom: adjacent infill residential + commercial points gravity-pair with each
other and become walking pops (sub-catchment commutes).

User direction: keep access pure transit; move saturation/native-first into a
**pressure layer on a Voronoi tessellation of the existing demand points**;
densification happens by **subdividing saturated cells** with new cuts; tune
subdivision slow so new points appear rarely and well-spread (which starves the
walking pairs).

## The three layers

1. **Access (unchanged):** directional transit reachability (walk proximity ×
   network reachability-to-opportunity), cached in the access index. NOT
   modulated by local demand saturation — that concern lives entirely in the
   pressure layer. (Opportunity's demand-mass weighting stays: it is what makes
   access directional, a property of network connectivity, not of local
   saturation.)
2. **Pressure tessellation (new):** the city partitions into Voronoi cells
   seeded by the live demand points (native + materialized). Each point is its
   cell's *anchor*. Pop pressure works exactly as today — per-point logistic
   accumulators; an anchor grows within its cell.
3. **Subdivision (new):** each cell carries **split pressure**, accruing in
   proportion to its capacity deficit. Crossing the threshold cuts the cell: a
   new empty point materializes at the access-weighted centroid, becomes a
   normal anchor, and the tessellation locally re-partitions.
   **Densification = subdivision.**

Deleted outright, subsumed by subdivision: the blue-noise candidate field, the
spacing index, per-candidate accumulators (`ledger.sites`), and the `densify`
ceiling multiplier.

## No explicit Voronoi geometry — the lattice

Cell membership is "this anchor is my nearest live demand point." Everything is
computed by one pass over a coarse **sampling lattice** (~`LATTICE_M` = 250 m)
covering the access-positive area (the union of routed-station catchments):

```
for each lattice sample:
  a      = accessIdx.at(sample)            // max(res, com) drives density
  if max(a.res, a.com) < MIN_SITE_ACCESS: skip
  anchor = nearest live demand point       // spatial grid, O(1)
  cells[anchor].supportedMass += supportedDensity(a) * sampleAreaM2   // LATTICE_M²
  cells[anchor].weightedCentroid accumulates (sample, weight = supportedDensity)
```

Per-cell sample lists are NOT stored (100k samples would bloat memory): cut
placement re-scans the lattice for the one splitting cell at split time —
splits are rare by design, so the re-scan is negligible.

with `supportedDensity(a) = massAt(a) / spacingAt(a)²` — people per unit area,
derived from the two existing density-fit curves. One pass yields every cell's
deficit input AND its prospective cut location. No polygon construction, no new
dependencies, fully deterministic (fixed lattice origin/order).

Unbounded edge cells are a non-issue: the lattice only covers access-positive
area, and zero-access area contributes zero supported mass.

## Split dynamics

```
anchorCap(cell)  = capRes + capJob of the anchor, reusing the caps the engine
                   already computes each day (native: baseline-scaled by
                   K_MAX·score; materialized: share × massAt(access))
anchorMass(cell) = anchor residents + jobs
deficit(cell)    = max(0, supportedMass(cell) − anchorCap(cell))
fill(anchor)     = clamp01(anchorMass / anchorCap)
splitPressure   += SPLIT_RATE × deficit × fill(anchor)      // per day
```

- **`deficit`** targets the primary case: large, low-density, high-access cells
  have huge deficits; built-out small cells sit at ≈ 0. Medium-density cells
  split occasionally as growth accrues.
- **`fill`** makes native-first structural: a cell cannot split until its own
  anchor has filled toward its cap. A new line into empty land grows its first
  point, then spreads outward cell by cell — a growth wave, not a blanket.
- **Self-limiting:** each cut shrinks both children's supported mass, so
  deficits fall after every split; subdivision decelerates as an area builds
  out. No damping multiplier needed.
- **Cut placement:** the cell's access-weighted centroid, snapped to the
  nearest lattice sample that is (a) dry (water index), (b) at least
  `spacingAt(access at sample)` from every existing demand point, and (c) in
  the cell. No valid sample → the cell cannot split (its pressure caps at
  `SPLIT_THRESHOLD`; it retries when geometry/access changes).
- **Split event:** at most `MAX_SPLITS_PER_DAY` cells split per day, highest
  pressure first (deterministic tie-break by anchor id). A split consumes
  `SPLIT_THRESHOLD` from the cell's pressure. The new point materializes
  exactly like today's condensation: `induced-pt:<ptSeq>`, empty
  (residents/jobs 0, baseline 0), recorded in `ledger.materialized`,
  recreated on load before pops. It then accrues pop pressure and receives
  pops through the normal growth loop.
- **Tuning:** `SPLIT_RATE` and `SPLIT_THRESHOLD` are the "slow" knobs — sized
  so new points appear on a scale of many in-game days. Slow, well-spread
  point creation is the fix for the walking-pop pairs (no min-commute rule,
  per user decision; revisit only if walking persists).

## Engine simplification

Sites are now exactly the live demand points — the empty-candidate branch of
`runDay` disappears (no seeded logistic, no candidate pools in allocation,
no lazy condensation during pairing). Growth, gravity pairing, decay, and all
existing invariants (net-equal growth, tombstones, live endpoints) operate on
points as in the pre-field engine. New engine step (after decay): update split
pressures from the cached cell integrals and perform the day's splits.

Materialized-point caps stay `RES_SHARE/JOB_SHARE × massAt(access)` (no
densify factor — the multiplier is removed; the mass ceiling is the fit's
envelope clamp, and additional capacity now arrives as new cells).

## Persistence & migration

- `ledger.cells?: Record<pointId, number>` — sparse nonzero split-pressure
  accumulators, serialized like pop accums.
- `ledger.materialized`, `ptSeq`, load order (recreate points → re-add pops →
  lattice re-derives) — unchanged.
- Removed: `ledger.sites`, `ledger.densify`. The deserializer drops them from
  old payloads silently; pending candidate pressure is lost once (accepted,
  matches the earlier site-id migration).
- Deleted modules: `sampler.ts` entirely (Bridson, spacing index, AND jitter —
  cuts are centroid-placed, no jitter). `field.ts` shrinks to: lattice/cell
  integration, structural + service hashes, and the (trivial) site list.

## Cadence & performance

- **Lattice pass:** chunked in Tier 1 (rebuild), and re-run as a background
  chunked refresh after any day that performed splits. ~50–100k samples ×
  O(1) lookups; staleness between refreshes is harmless (slow dynamics).
- **Daily:** split-pressure accumulation is O(points) over cached integrals;
  the growth loop is smaller than before (no candidates).
- Tier 2 service-hash/mass-drift skip logic unchanged.

## Overlay

Access views unchanged. The **pressure view** now renders pop pressure at
anchors (as today) plus **split pressure at each cell's prospective cut
location** — making the next growth location and its timing visible.

## Config

Added: `LATTICE_M` (250), `SPLIT_RATE`, `SPLIT_THRESHOLD`,
`MAX_SPLITS_PER_DAY` (small, e.g. 3). Removed: `RHO_DENSIFY`, `SAT_THRESHOLD`
(densify machinery) and `J_FRAC` (jitter is gone). `MIN_SITE_ACCESS` is
retained — it bounds the lattice. `R_MIN`/`R_MAX`/fit quantiles are retained
(spacing/mass curves feed `supportedDensity` and cut min-spacing).

## Testing

Pure-function tests: lattice cell assignment + integrals on hand-checkable
fixtures; deficit/fill/split-pressure math; cut placement (weighted centroid,
water fallback, min-spacing rejection, no-valid-sample); split determinism
(same inputs → same cut sequence, budget + tie-break); engine without
candidates (all migrated invariants); ledger round-trip of `cells` + silent
drop of legacy `sites`/`densify`. Perf instrumentation continues to gate the
lattice pass and day loop.

## Out of scope

- Minimum induced-commute distance / directional specialization of new points
  (user chose slow tuning as the walking fix; revisit only if insufficient).
- Version bumps (user rule: never without asking).
- Reintroducing a saturated-city density-ceiling creep (removed with densify;
  re-add later only if saturated cities stall visibly).
