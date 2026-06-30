# Induced Demand Model — Design Spec

- **Status:** Draft for review (revision 2)
- **Date:** 2026-06-30
- **Project:** Induced Demand (Subway Builder mod)
- **Related:** [DEMAND_API.md](../../DEMAND_API.md) (how the mod reads/writes demand), [RESEARCH_induced_demand.md](../../RESEARCH_induced_demand.md) (parameter grounding)

> **Revision 2 changes** (from review): the model now modifies the city's **real** `residents`/`jobs` (no shadow ledger), maintains **full residents↔jobs accounting** (because the game UI traces residence-pop → job → residence), grows by adding **net-equal residence↔job pop pairs** chosen by gravity, and treats every pop as a fixed **200-person unit**.

## 1. Goal & non-goals

**Goal.** Once per in-game day, grow residential and commercial demand in places the game's own simulation already shows transit serving well, by adding `Pop` commuter groups (each adds residents at its residence point and jobs at its job point). Over the long run this produces transit-induced densification: better-served areas attract more people and jobs, which generates more ridership.

**Non-goals (explicit).**
- The mod **never writes mode share or catchment** — those are simulated by the game. It only *reads* them as inputs.
- It does not change fares, service, routing, or any mode-choice logic.
- No new map layers, pathfinding, or UI beyond config constants (UI out of scope for v1; see §14).

**Note on decreases.** Players build transit far more often than they delete it, so demand *decrease* is the rare case. The model supports it (decay when a point loses transit access) but is optimized for the common growth case and keeps decay simple (§5.3).

## 2. Summary

Each in-game day the engine:
1. Reads the live `demandData` and station set.
2. Computes a **transit-attractiveness score** per demand point, separately for its residential and commercial side, from the game's mode share × a catchment-access metric (§4).
3. Advances each point's residential and commercial **pressure** one logistic step toward a per-point cap (§5).
4. Converts pressure into a single day's whole-pop count `N` (net-equal across the two sides), allocates `N` residence slots by residential pressure and `N` job slots by commercial pressure (both respecting per-point caps), **gravity-pairs** them into `N` residence↔job pops, and adds each as a fixed **200-person** pop — incrementing `residents` at the residence and `jobs` at the job (§6).
5. On the rare decay path, removes induced pops where a point now exceeds its cap (§5.3).
6. Persists baselines + fractional accumulators across saves and reconciles idempotently (§7).

The mod mutates the live `demandData` Maps in place; the game's next commute cycle reads them and decides how the new pops actually travel (see DEMAND_API.md §"the write path").

## 3. Inputs (read) and outputs (written)

| Read (never written) | Source |
|---|---|
| `point.residentModeShare`, `point.workerModeShare` (`ModeChoiceStats`) | `getDemandData().points` |
| `point.location`, `point.residents`, `point.jobs`, `point.popIds` | `getDemandData().points` |
| existing `Pop` endpoints / departure-time distribution | `getDemandData().popsMap` |
| station coordinates + routes serving them; catchment radius | `gameState.getStations()` / `getRoutes()`; catchment constant (~1800 s, DEMAND_API.md §5) |

| Written | Target |
|---|---|
| `point.residents` (+/− 200 per residence-anchored pop add/remove) | live `points` Map |
| `point.jobs` (+/− 200 per job-anchored pop add/remove) | live `points` Map |
| `Pop` entries — size **always 200**, ids prefixed `induced:` | live `popsMap` Map |
| `point.popIds` — pop id added/removed on **both** its endpoints | live `points` Map |
| baselines + fractional accumulators | `api.storage` |

**Accounting invariant (must hold at all times):** for every point `p`,
`p.residents == Σ size of pops with residenceId == p` and `p.jobs == Σ size of pops with jobId == p`.
Because the only mutation is adding/removing a whole 200-person pop (which touches exactly one residence and one job), the invariant is preserved by construction, and total residents added each day equals total jobs added (net-equal).

## 4. The transit-attractiveness score

For demand point `p` and side `s ∈ {residential, commercial}`:

```
score_s(p) = clamp01( modeShare_s(p) ) × access(p)            ∈ [0, 1]
```

### 4.1 Mode share
```
modeShare_residential(p) = transitFraction(p.residentModeShare)
modeShare_commercial(p)  = transitFraction(p.workerModeShare)
transitFraction(m) = m.transit / (m.walking + m.driving + m.transit + m.unknown)   // guard /0 → 0
```
`transitFraction` normalizes to a fraction regardless of whether `ModeChoiceStats` holds counts or shares (verify field semantics, §13).

### 4.2 Access metric `access(p)`
Derived from point→station geometry (we have point and station coordinates and the catchment radius). Two components:
```
walkProx(p)     = max over stations of decay( walkSeconds(p, station) )    // 0 if none in catchment
                  decay(t) = exp( -(t / TAU_ACCESS)^2 )                    // Gaussian decay on walk time
connectivity(p) = min(1, distinctLinesInCatchment(p) / CONNECTIVITY_REF)  // network reach
access(p)       = walkProx(p) × ( ACCESS_CONN_FLOOR + (1 - ACCESS_CONN_FLOOR) × connectivity(p) )
```
- `walkSeconds(p, station) = haversine(p.location, station.coords) / WALK_SPEED`.
- A point with **no** station inside catchment gets `access = 0` → `score = 0` → no growth (access gates growth).
- `connectivity` rewards points reachable to multiple lines; `ACCESS_CONN_FLOOR` keeps a single-line point from being zeroed out.

**Why access is not redundant with mode share:** mode share is *revealed usefulness*; access is *physical reach* (is there a station, how many lines). A one-line stub and a multi-line hub can share a mode-share value but should not induce equal demand.

## 5. Growth dynamics

Run per point and per side. `baseline*` is the point's residents/jobs **frozen at first load** (used only for the cap and as the implicit decay floor); the live `point.residents`/`point.jobs` are what actually grow.

### 5.1 Cap
```
cap_res(p) = baselineResidents(p) × (1 + K_MAX × score_residential(p))
cap_job(p) = baselineJobs(p)      × (1 + K_MAX × score_commercial(p))
```
Cap is a multiple of the point's own baseline, so larger places densify more in absolute terms; `score = 0` gives `cap = baseline` (no growth, and nothing below baseline). Cap ≥ baseline always.

### 5.2 Logistic pressure step
Per side, using the **live** current count as `total`:
```
Δ_res(p) = R_GROW × score_residential(p) × residents(p) × (1 − residents(p) / cap_res(p))
Δ_job(p) = R_GROW × score_commercial(p) × jobs(p)      × (1 − jobs(p)      / cap_job(p))
resAccum(p) += Δ_res(p)   ;   jobAccum(p) += Δ_job(p)        // clamped to [−ACCUM_CAP, +ACCUM_CAP]
```
`baseline > 0` seeds the logistic. `Δ` is positive below cap (growth pressure) and negative above cap (decay pressure). `resAccum`/`jobAccum` are real-valued reservoirs of not-yet-materialized people (sub-200 remainders carry across days).

### 5.3 Decay (rare path)
A point ends up above its cap only when its score drops — essentially when transit serving it is removed. When `residents(p) > cap_res(p)` (or jobs), the engine removes **induced** pops (`induced:` prefix) anchored at that point until it no longer exceeds the cap or no induced pops remain there. Removal is in whole 200-person units and updates both endpoints (the removed pop's residence loses 200 residents and its job loses 200 jobs). Because only induced pops are ever removed and `cap ≥ baseline`, demand never falls below the original baseline. Decay uses the same accumulators but a slower effective rate via `R_DECAY` (negative `Δ` is scaled by `R_DECAY/R_GROW`) so it lags growth (hysteresis). This path is best-effort and rare; minor cross-endpoint side effects are acceptable.

### 5.4 Hybrid relocation (optional, secondary)
To add mild relocation pressure (people gravitating from poorly-served to well-served areas), a fraction `PHI` of the day's gross growth is converted into extra **negative** pressure on the lowest-score points that currently hold induced pops, proportional to their induced holdings — shedding induced pops there via the §5.3 path. `PHI = 0` → pure additive (recommended given growth-dominant usage); `PHI ≈ 0.2` → light relocation. Never touches base (non-induced) pops.

## 6. Materialization: net-equal gravity-paired pops

All growth is expressed as adding **N** residence↔job pop pairs in one day, each pop a fixed `POP_SIZE = 200`.

### 6.1 Daily pop count `N` (net-equal)
```
Rp = Σ over points of max(0, resAccum(p))        // total residential growth pressure (people)
Jp = Σ over points of max(0, jobAccum(p))        // total commercial growth pressure (people)
Npeople = reconcile(Rp, Jp, RECONCILE)           // default 'average' = (Rp+Jp)/2
N = floor(Npeople / POP_SIZE)
```
`reconcile` options: `average` (default), `min` (strict — gate growth by the scarcer side), `residential`, or `commercial` (drive total by one side). Choosing one common `N` is what makes residential and commercial additions net-equal.

### 6.2 Cap-respecting slot allocation
Allocate `N` residence slots across points by residential pressure, and `N` job slots by commercial pressure, **without exceeding remaining capacity**:
```
remCapRes(p) = floor( (cap_res(p) − residents(p)) / POP_SIZE )       // remaining residence pops
resSlots = allocateInteger(weights = max(0,resAccum), total = N, perPointMax = remCapRes)
jobSlots = allocateInteger(weights = max(0,jobAccum), total = N, perPointMax = remCapJob)
```
`allocateInteger` is largest-remainder apportionment capped per point. If total remaining capacity on a side is `< N` (caps nearly saturated), `N` is reduced to what **both** sides can absorb; the unmet pressure stays in the accumulators for a future day. A point at its cap contributes 0 slots.

### 6.3 Gravity pairing
Expand `resSlots`/`jobSlots` into two length-`N` pools of point ids, then pair them so paired residence `H` and job `W` are gravity-plausible:
```
cost(H, W) = dist(H, W)^BETA                         // dist from coordinates, floored at DIST_MIN
```
Greedy/weighted matching: for each residence slot, draw a job slot from the remaining pool with probability ∝ `1 / cost(H,W)` (seeded RNG for determinism). This honors both marginals (every slot is used exactly once) while keeping commutes short on average.

### 6.4 Apply each pair
For each `(H, W)` pair, create one pop:
```
pop = { id: "induced:"+uuid, size: 200, residenceId: H, jobId: W,
        drivingDistance: haversine(H,W) × DETOUR_FACTOR,
        drivingSeconds:  drivingDistance / DRIVE_SPEED,
        homeDepartureTime, workDepartureTime: sampled from existing pops (fallback DEFAULTs),
        drivingPath: omitted (verify §13), lastCommute: omitted — sim fills (verify §13) }
popsMap.set(pop.id, pop)
H.popIds.push(pop.id); W.popIds.push(pop.id)
H.residents += 200;     W.jobs += 200
resAccum(H) -= 200;     jobAccum(W) -= 200          // floor at 0
```
Net residents added = net jobs added = `200 × N`; the accounting invariant (§3) holds.

## 7. State, persistence & reconciliation

### 7.1 Ledger structure
The game's save persists the actual demand (live `residents`/`jobs`/pops). The mod persists only what it cannot re-derive:
```ts
interface PointLedger {
  baselineResidents: number;   // frozen at first load (for caps / decay floor)
  baselineJobs: number;
  resAccum: number;            // fractional residential pressure not yet materialized
  jobAccum: number;            // fractional commercial pressure not yet materialized
}
type Ledger = Map<string /*pointId*/, PointLedger>;
```
Induced pops are identified by their `induced:` id prefix (no separate id list needed; rebuildable from `popsMap`).

### 7.2 Cadence & lifecycle hooks
- `hooks.onCityLoad` / `onMapReady`: load or initialize the ledger; capture baselines on first sight.
- `hooks.onDayChange`: run one step (§10).
- `hooks.onGameLoaded(saveName)`: load that save's ledger and reconcile (§7.3).
- `hooks.onGameSaved(saveName)`: flush the ledger to `api.storage`.

### 7.3 Dual persistence & idempotent reconciliation
- **Baseline is authoritative from the ledger**, never re-derived from current counts (current counts already include induced growth after the first session).
- Induced pops are saved inside the game's `demandData`, so on load they already exist — the engine does **not** re-add them.
- `api.storage` key = `cityCode + ":" + saveName` (per-save ledger).
- First time a `cityCode+saveName` is seen with no ledger: capture `baseline* = current residents/jobs`, `accum* = 0` (treats whatever is present as the baseline).
- Daily mutations are diffs against live state, so re-running a day or reloading cannot double-apply.
- Self-heal: if the ledger is missing but `induced:` pops exist, baselines are recovered as `current − (200 × count of induced pops anchored)`; if accounting drift is detected, it is logged and the counts are recomputed from the pops (the pops are the source of truth for the invariant).

## 8. Configuration & defaults

Single `config.ts`. Defaults are starting points for tuning, grounded in RESEARCH_induced_demand.md (long-run service-expansion elasticity ~0.6–1.0; station-proximity ~−0.5; TOD densification).

| Constant | Default | Meaning / basis |
|---|---|---|
| `POP_SIZE` | **200** | Fixed people per pop (game constraint — verify §13). |
| `K_MAX` | 1.0 | Max induced fraction at score=1 (+100% over the long run). |
| `R_GROW` | provisional ~0.002/day (≈ top-score point reaches ~½ cap in ~5 in-game years); calibrated per §13.5 | Logistic growth rate (long-run). |
| `R_DECAY` | 0.4 × `R_GROW` | Decay rate (hysteresis; slower than growth). |
| `RECONCILE` | `average` | Net-equal rule for daily `N` (`average`/`min`/`residential`/`commercial`). |
| `PHI` | 0.0 | Hybrid relocation fraction (0 = pure additive; ~0.2 = light relocation). |
| `ACCUM_CAP` | 1000 (5 pops) | Max backlog held in an accumulator (prevents stale pressure ballooning). |
| `TAU_ACCESS` | ~600 s | Gaussian walk-time decay scale for access. |
| `CONNECTIVITY_REF` | 3 | Lines-in-catchment for full connectivity credit. |
| `ACCESS_CONN_FLOOR` | 0.5 | Min access credit for a single-line point. |
| `WALK_SPEED` | 1.0 m/s | Matches game base (DEMAND_API.md §5). |
| `DRIVE_SPEED` | ~11 m/s | Urban driving estimate for new-pop driving time. |
| `DETOUR_FACTOR` | 1.3 | Straight-line → road distance. |
| `BETA` | 2.0 | Gravity distance-decay exponent. |
| `DIST_MIN` | 100 m | Gravity distance floor. |

## 9. Module breakdown & interfaces

Pure functions (unit-tested in isolation) carry the math; state and game I/O are quarantined to `ledger.ts`, `engine.ts`, `index.ts`.

| Module | Responsibility | Depends on |
|---|---|---|
| `geo.ts` | `haversine`, `walkSeconds` | — |
| `access.ts` | `access(point, stations, routes, cfg)` → `[0,1]` | `geo` |
| `score.ts` | `transitFraction`, `score_s(point, access)` | `access` |
| `growth.ts` | `cap()`, `logisticDelta(baseline, current, cap, score, cfg)` | — |
| `allocate.ts` | `reconcile()`, `allocateInteger(weights, total, perPointMax)` (largest-remainder, capped) | — |
| `gravity.ts` | `pairByGravity(residencePool, jobPool, points, cfg, rng)` → `(H,W)[]` | `geo` |
| `popFactory.ts` | build induced `Pop` (size 200, driving estimates); add/remove with endpoint bookkeeping | `geo` |
| `ledger.ts` | ledger CRUD, baseline capture, `api.storage` persistence, reconciliation/self-heal | game API |
| `engine.ts` | per-day orchestration: read → score → pressure → N → allocate → pair → apply → decay | all above |
| `config.ts` | tunable constants | — |
| `index.ts` | hook wiring + guards | `engine`, `ledger` |

## 10. Algorithm (per-day pseudocode)

```
onDayChange():
  dd = api.gameState.getDemandData(); if (!dd) return
  stations = api.gameState.getStations(); routes = api.gameState.getRoutes()
  L = ledger (loaded/reconciled)

  // A. pressures (growth positive, decay negative)
  for p in dd.points.values():
    e = L.get(p.id) ?? initFromBaseline(p)
    sRes = score(p, residential, stations, routes, cfg); sJob = score(p, commercial, ...)
    e.resAccum = clampAccum(e.resAccum + logisticDelta(e.baselineResidents, p.residents, capRes(e,sRes), sRes, cfg))
    e.jobAccum = clampAccum(e.jobAccum + logisticDelta(e.baselineJobs,      p.jobs,      capJob(e,sJob), sJob, cfg))

  applyRelocation(L, cfg)                       // optional, PHI

  // B. growth: net-equal, cap-respecting, gravity-paired
  Rp = Σ max(0, e.resAccum); Jp = Σ max(0, e.jobAccum)
  N  = floor(reconcile(Rp, Jp, cfg.RECONCILE) / POP_SIZE)
  if N > 0:
    resSlots = allocateInteger(weights=max(0,resAccum), total=N, perPointMax=remCapRes)
    jobSlots = allocateInteger(weights=max(0,jobAccum), total=N, perPointMax=remCapJob)
    N = min(Σ resSlots, Σ jobSlots)             // both sides must absorb it
    pairs = pairByGravity(expand(resSlots,N), expand(jobSlots,N), dd.points, cfg, rng)
    for (H,W) in pairs: addInducedPop(dd, H, W) // +200 res@H, +200 jobs@W, popsMap, popIds×2, accums-=200

  // C. decay (rare): points where current > cap → remove induced pops (§5.3)
  for p where p.residents > capRes or p.jobs > capJob: removeInducedToCap(dd, p, L)

  persistLedgerDebounced()
```

## 11. Edge cases & error handling

- **No demand data / blank city:** `getDemandData()` null or empty → no-op.
- **No stations / none in catchment:** `access = 0` everywhere → no growth; any prior induced demand decays (§5.3) only if over cap.
- **One side has no candidate points** (e.g., no job-bearing points): `N` collapses to what both sides support (`min` in §10B); unmet pressure waits in accumulators.
- **Caps saturated:** `allocateInteger` caps per point; `N` reduces; no overflow past cap.
- **Map replacement each commute cycle:** engine re-fetches `getDemandData()` each day; the ledger + `induced:` prefix (not object identity) are the source of truth.
- **Save/load drift:** §7.3 self-heal recovers baselines and recomputes counts from pops (pops are authoritative for the §3 invariant).
- **Integer/invariant safety:** counts move only in ±200 steps via pop add/remove; a removed pop is de-referenced from both endpoints' `popIds`; `residents`/`jobs` never go below baseline.
- **All hooks** wrapped in try/catch with `[InducedDemand]` logging; a failed day must not crash the game loop.

## 12. Testing strategy

- **Pure units:** `geo`, `access` (gating to 0 with no station; connectivity scaling), `score`, `growth` (logistic monotonicity, cap saturation, decay sign above cap), `allocate` (largest-remainder correctness, per-point caps respected, sums equal `total`), `gravity` (closer pairings favored; every slot used once; deterministic with seed), `popFactory` (size always 200, driving estimates, endpoint bookkeeping on add/remove).
- **Engine integration (mocked API):** fake `demandData` + stations; assert (a) growth concentrates at high mode-share/high-access points; (b) **accounting invariant** holds after every day (`residents == Σ resident-pops`, `jobs == Σ job-pops`); (c) residential and commercial additions are **net-equal** each day; (d) every pop size is 200; (e) idempotency: running a day twice / reload does not double-count; (f) decay removes only induced pops and never drops below baseline; (g) reconciliation self-heal rebuilds baselines from `induced:` pops.
- **Determinism:** all sampling/matching uses a seeded RNG.

## 13. Implementation-verification items (check against the live game before/while coding)

1. **Pop size** — confirm every existing pop is size 200 and that `residents`/`jobs` are multiples of 200 (validates the fixed-unit + accounting model).
2. **`popIds` convention** — confirm a pop is referenced under **both** its residence and job points (the UI residence→job→residence trace implies this); match it exactly on add/remove.
3. **`ModeChoiceStats` semantics** — counts vs fractions (affects `transitFraction`).
4. **New-pop required fields** — whether the sim tolerates omitted `drivingPath` / `lastCommute`, and whether it recomputes `drivingSeconds`/`drivingDistance` (then our estimates are seeds).
5. **Distinct lines in catchment** — enumerate routes serving a station (`station.routeIds` → routes) for the connectivity term.
6. **Game day length / `onDayChange` frequency** — to calibrate `R_GROW` to a believable multi-year long-run.
7. **`api.storage` keying** — confirm per-mod, survives save/load; confirm `getSaveName()` for per-save ledgers.

## 14. Out of scope / future

- Any UI (config panel, induced-demand heatmap/overlay) — defaults live in `config.ts` for v1.
- Biasing new pops toward transit-reachable endpoints (rejected in design in favor of gravity).
- Variable pop sizes (game uses a fixed 200 unit).
- Cross-city / scenario calibration beyond the single default parameter set.
- Migrating *existing* (base) pops toward transit (relocation acts only on induced pops; full base-demand redistribution is out of scope).
```
