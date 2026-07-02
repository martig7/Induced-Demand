# Induced Demand

A **Subway Builder** mod that models long-run, transit-**induced** demand: over time it
grows residential and commercial demand around well-served stations by adding commuter
pops.

## How it works

Each in-game day the engine runs one pass over every demand point:

1. **Score**: how transit-attractive the point is, in `[0, 1]`:
   `score = access × (FLOOR + (1 − FLOOR) × transitFraction)`.
   - **access** is a walk-time Gaussian decay within the station catchment, boosted by how
     many distinct lines are reachable (connectivity).
   - **transitFraction** is the point's current transit mode share.
   - The `MODE_SHARE_FLOOR` (0.5) makes *access* the dominant term: a well-served point still
     scores half its access even at zero current ridership, so demand can grow near new transit
     before riders have shown up. Mode share modulates within `[FLOOR, 1]`.
2. **Cap & growth**: each point has a soft ceiling `cap = baseline × (1 + K_MAX × score)`
   and grows **logistically** toward it. High-score points can gain the most; unserved
   points (score 0) don't grow.
3. **Net-equal, gravity-paired**: added residents always equal added jobs. New demand is
   created as 200-person pops that are gravity-matched into home-job pairs.
4. **Decay** *(limited, see Status)*: designed to slowly shrink induced demand when a
   point loses service.

A small per-city **ledger** records each point's original baseline (self-healing on load),
so the mod always knows how much demand is "induced" versus original.

The model's parameters and the research behind them live in
[`docs/RESEARCH_induced_demand.md`](docs/RESEARCH_induced_demand.md); the game demand API
is documented in [`docs/DEMAND_API.md`](docs/DEMAND_API.md).

## The map mode

The mod adds an **Induced Demand** toolbar panel that renders demand points as circles on
the map:

- **Show**: On / Off.
- **View**:
  - **Realized**: the demand the mod has actually added so far (from its induced pops).
  - **Targeting**: the model's per-point transit score.
- **Metric**: Residential / Commercial / Both.
- A legend showing the value scale.
- **Clear induced demand**: a two-click reset that wipes the mod's added demand. Because
  pops can't be safely deleted mid-simulation, it queues the clear and applies it on the
  next reload.

## Install

**From a release (recommended):** download `induced-demand-vX.Y.Z.zip` from the
[Releases](https://github.com/martig7/Induced-Demand/releases) page and add it through the
in-game mod manager.

**From source:** `npm install && npm run build`. The build compiles to `dist/index.js` and
copies the mod (with `manifest.json`) into your local mods folder
(`%APPDATA%/metro-maker4/mods/induced-demand`).

### Requirements

- **Subway Builder ≥ 1.4.2** (declared in `manifest.json`).

## Development

```bash
npm install
npm test        # node:test suites via tsx
npm run typecheck
npm run build   # vite build → dist/, then installs into the mods folder
```

The model is pure and framework-free, so it runs and is unit-tested entirely in Node. This allows
for simulation without running the game.

### Releasing

`npm run release` is a two-phase helper:

1. First run drafts `RELEASE_NOTES.md` (commit history since the last tag). **Edit it.**
2. Second run runs the tests, creates the annotated tag `vX.Y.Z` from your notes, and
   pushes it. The [`Release` workflow](.github/workflows/release.yml) then builds and
   publishes the GitHub Release (`induced-demand-vX.Y.Z.zip` + `manifest.json`).

Bump the version in `src/version.ts` (the build syncs it into `manifest.json` / `package.json`).

## Architecture

```
src/
  main.ts                    # entry: wires the daily engine + map panel to game hooks
  version.ts                 # MOD_VERSION (synced into the manifests by the build)

  model/                     # pure, game-free, unit-tested
    engine.ts                # runDay(): score → grow → pair → (decay)
    score.ts                 # access-dominant residential/commercial score
    access.ts                # walk-time catchment + line connectivity
    growth.ts                # per-point cap + logistic growth delta
    allocate.ts              # integer allocation of the day's new pops
    gravity.ts               # home↔job gravity pairing (seeded RNG)
    popFactory.ts            # add/remove induced pops with residents↔jobs bookkeeping
    ledger.ts                # per-point baselines + persistence (self-healing)
    geo.ts, util.ts, config.ts

  overlay/                   # the map layer (pure builders)
    featureCollection.ts     # build the GeoJSON for a view + metric
    overlay.ts               # MapLibre source/layer register + update
    state.ts, types.ts

  ui/panel.ts                # toolbar panel (view/metric/reset + legend), no JSX
  types/                     # ported Subway Builder modding API typings
```

## Status

- [x] Access-dominant growth model grows demand near well-served stations, working on real
      low-transit-share cities
- [x] Net-equal residents-jobs, gravity-paired 200-person pops
- [x] Map mode: Realized / Targeting × Residential / Commercial / Both, constant-ground-size dots
- [x] Per-city persistent ledger + "Clear induced demand" reset
- [ ] **Decay** (shrinking induced demand when service is removed) — present but limited:
      deleting pops from a running simulation disturbs the game's in-flight commute movements,
      so it isn't reliable yet
- [ ] **Relocation** (moving *existing* demand toward transit): Currently removing pops from original demand data
      is not possible via the modding API.
- [ ] **Map Interaction** Eventually the user should be able to click on induced demand dots in the map mode to show
      a view similar to the base game analytics.

Actively developed. Send me saves or feedback on Discord (id **gcm**).

## License

MIT
