/**
 * Induced Demand — entry point. Wires the per-day model engine to the game hooks.
 * Reads mode share + catchment; writes only demand (residents/jobs/pops).
 */
import type { Coordinate } from './types/core';
import type { DemandData, Station } from './types/game-state';
import { runDay, type DayResult } from './model/engine';
import { pushDayHistory, type DayHistoryEntry } from './model/history';
import { DEFAULT_CONFIG } from './model/config';
import { makeRng } from './model/gravity';
import { INDUCED_PREFIX, deferredRemovalPopCount } from './model/popFactory';
import {
  loadFromStore, saveToStore, captureBaselines, reconcileBaselines, reconcileInducedPops,
  applyPendingAccum, retirePendingRemovals, restoreTombstoneStubs, clearAllInduced,
  mergePendingRemovals, newLedger, type LedgerState, type KVStore,
} from './model/ledger';
import { parseDanglingInducedMovementId, repairDanglingMovement } from './model/movementRepair';
import { buildSlotSet, DEFAULT_SLOT_SET, type SlotSet } from './model/commuteTimes';
import { rescueCommuteTimes, rescueDrivingValues, rescueOrphanedPops } from './model/popRescue';
import {
  buildRoadGraph, snapToNode, pathCoordinates, type RoadGraph, type RoadFeatureCollection,
} from './model/roadGraph';
import { createRouter, type DrivingRouter, type Speeds } from './model/router';
import { installRoutePathFetch } from './game/routePathServer';
import { loadCityJson, type DataServerHost } from './game/cityData';
import { calibrateSpeedsAsync, type CalibrationPair } from './model/speedFit';
import {
  createDrivingModel, buildDonorBands, DEFAULT_DRIVING_MODEL, type DrivingModel,
} from './model/drivingModel';
import { classifyGameLoad, markerForLoad, observeElapsed, type LoadMarker } from './model/loadGuard';
import { buildOverlay } from './overlay/featureCollection';
import { buildHistoryOverlay } from './overlay/historyCollection';
import { nextNudge, type NudgeState } from './overlay/demandDotRefresh';
import {
  registerOverlay, updateOverlay, setOverlayVisible,
  updateHistoryOverlay, setHistoryOverlayVisible,
} from './overlay/overlay';
import { createOverlayStore, type OverlayStore } from './overlay/state';
import { createPanel } from './ui/panel';
import { createHistoryPanel } from './ui/historyPanel';
import { TOOLBAR_PANEL_ID, TOOLBAR_PLACEMENT } from './ui/toolbarPanel';
import { buildStationGraph, type StationGraph } from './model/stationGraph';
import {
  stationMasses, computeOpportunities, buildAccessIndex,
  type StationOpportunity, type AccessIndex,
} from './model/opportunity';
import { fitDensity, spacingAt, massAt, type DensityFit, type FitInputPoint } from './model/densityFit';
import { jitterPosition } from './model/sampler';
import {
  createSiteBuilder, refreshSiteAccess, computeStructuralHash, computeServiceHash,
  type Site, type BuildSitesOpts,
} from './model/field';
import { buildWaterIndex, type WaterIndex, type OceanDepthFile } from './game/waterIndex';
import { recreateMaterializedPoints } from './model/ledger';
import { createPerfTracker, PERF_BUDGETS } from './model/perf';
import {
  registerHeatmap, updateHeatmap, setHeatmapVisible, buildHeatFeatures, type HeatView,
} from './overlay/heatmap';
import { haversine } from './model/geo';

const TAG = '[InducedDemand]';
const DEBUG = true; // verbose per-day heartbeat while verifying; set false to quiet

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found.`);
} else {
  let ledger: LedgerState = newLedger();
  let ledgerCity = ''; // which city's roster is currently in memory (guards saving under the wrong key)
  let cachedCity = '';
  let ready = false;
  let didReconcile = false;
  let loggedSample = false;
  /** Apply pending removals/clear once demand data is available (save reload can fire before dd). */
  let pendingApplyMutations = false;

  // Cross-reload UI state on `window`: the game's toolbar is rebuilt on save reload and
  // `reloadMods()` clears mod UI, but this object survives — use it to re-register the
  // panel without stacking duplicates on every hook fire in the same turn.
  interface PersistentUi {
    overlayStore: OverlayStore;
    resetInducedDemand?: () => void;
    mapReady?: boolean;
    renderPanel?: () => unknown;
  }
  const UI_KEY = '__inducedDemandUi__';
  const wUi = window as unknown as Record<string, PersistentUi>;
  if (!wUi[UI_KEY]) {
    wUi[UI_KEY] = {
      overlayStore: createOverlayStore({
        enabled: false,
        view: 'realized',
        metric: 'combined',
        revision: 0,
        deferredRemovalCount: 0,
        clearQueued: false,
        historyDay: null,
      }),
    };
  }
  const persistentUi = wUi[UI_KEY];
  const overlayStore = persistentUi.overlayStore;
  const panelState = overlayStore.get();
  if (typeof panelState.revision !== 'number') overlayStore.set({ revision: 0 });
  if (typeof panelState.deferredRemovalCount !== 'number') overlayStore.set({ deferredRemovalCount: 0 });
  if (typeof panelState.clearQueued !== 'boolean') overlayStore.set({ clearQueued: false });
  if (panelState.historyDay === undefined) overlayStore.set({ historyDay: null });
  let lastMax = 0;

  // Guard against duplicate execution: the mod loader may run this script more than
  // once (e.g. initial load + "Reload all mods"), leaving stale hook callbacks
  // registered. Each execution claims a generation; callbacks from any but the latest
  // generation no-op, so exactly one instance is ever active (newest wins; hot-reload-safe).
  const GEN_KEY = '__inducedDemandGeneration__';
  /** In-memory ledger survives mod hot-reload; localStorage is the durable copy of pendingRemovals. */
  const SESSION_KEY = '__inducedDemandSession__';
  interface PersistentSession {
    ledger: LedgerState;
    ledgerCity: string;
    /** Load point of the last REAL save load processed (see model/loadGuard). */
    loadMarker?: LoadMarker;
    /** `saveName` from the most recent onGameLoaded (replays repeat the last real load's name). */
    lastLoadedSaveName?: string | null;
    /** Rolling per-day pop-change history for the current city (see model/history). */
    history?: { city: string; days: DayHistoryEntry[] };
    /** Road graph + fitted driving model, per city (see model/drivingModel). */
    driving?: {
      city: string;
      model: DrivingModel;
      routing: { graph: RoadGraph; router: DrivingRouter } | null;
      speeds: Speeds | null;
      loading: boolean;
      /** Road-graph load attempts for this city, capped by MAX_ROAD_LOAD_ATTEMPTS. */
      attempts: number;
    };
    /** Access-field state, per city (spec §1/§8). */
    field?: {
      city: string;
      sites: Site[];
      graph: StationGraph;
      opps: StationOpportunity[];
      /** Station-proximity access lookups — O(nearby), float-identical to accessAt. */
      accessIdx: AccessIndex;
      fit: DensityFit;
      hash: string;
      /** Weight inputs (schedules/timings) at the last opportunity compute. */
      serviceHash: string;
      /** People added/removed since the last opportunity compute (drift refresh). */
      massDrift: number;
      water: WaterIndex | null;
      waterFailed: boolean;
    };
  }
  const w = window as unknown as Record<string, number | boolean | undefined>;
  const wSession = window as unknown as Record<string, PersistentSession | undefined>;
  const prevGen = (w[GEN_KEY] as number | undefined) ?? 0;
  const myGen = prevGen + 1;
  w[GEN_KEY] = myGen;
  const isCurrent = (): boolean => w[GEN_KEY] === myGen;
  // NOTE: no timing-based suppression here. `onGameLoaded` replays during reloadMods()
  // cannot be bounded by timers or by `modding-api-reload-complete` (the ModManager
  // button and the hot-reload shortcut re-run scripts and re-fire hooks AFTER that
  // event; the loader awaits IPC between scripts). Real loads are instead detected
  // from game state in init() via classifyGameLoad — see docs/MODDING_UI.md.

  // Persist through localStorage, NOT api.storage:
  // does NOT rehydrate from disk on a cold launch, so api.storage.get returns nothing after a full
  // restart (it survived only warm, in-session reloads). localStorage IS hydrated by Electron on
  // cold start, so the roster actually round-trips. (Same approach as the Improved Schematics mod.)
  const store: KVStore | null = (() => {
    try { return window.localStorage; } catch { return null; }
  })();

  const perf = createPerfTracker(
    (m) => { if (DEBUG) console.log(m); },
    (m) => console.warn(m),
  );

  /** Water index, one load attempt per city; null = no mask (warned once). */
  async function loadWaterIndex(city: string): Promise<WaterIndex | null> {
    const start = performance.now();
    try {
      const file = await loadCityJson<OceanDepthFile>(
        window as unknown as DataServerHost, `/data/${city}/ocean_depth_index.json`,
      );
      const idx = buildWaterIndex(file);
      const ms = performance.now() - start;
      if (DEBUG) console.log(`[InducedDemand][perf] water ${ms.toFixed(0)}ms (${file.depths.length} polys)`);
      if (ms > PERF_BUDGETS.water) console.warn(`${TAG} water index load over budget: ${ms.toFixed(0)}ms`);
      return idx;
    } catch (e) {
      console.warn(`${TAG} no ocean_depth_index for ${city} — placing without a water mask`, e);
      return null;
    }
  }
  const LEDGER_KEY = (city: string): string => `induceddemand:ledger:${city}`;
  // Fitted road speeds: derived from the city's data, so they only change when the
  // city data does. Cached to skip ~4 s of routing on every later load.
  const SPEEDS_KEY = (city: string): string => `induceddemand:speeds:${city}`;
  // Clear-demand marker: set on click, applied + consumed on the next REAL load of the
  // SAME city. Scoped per city — a global marker would clear whichever city happens to
  // load next (e.g. when the user switches city to force a full load).
  const CLEAR_KEY = (city: string): string => `induceddemand:clear:${city}`;
  const LEGACY_CLEAR_KEY = 'induceddemand:clear'; // pre-1.0.3 unscoped marker
  const CLEAR_ON = '1';
  /** Give up on a city's road data after this many failures (missing/corrupt file). */
  const MAX_ROAD_LOAD_ATTEMPTS = 3;

  function ensureSession(): PersistentSession {
    let s = wSession[SESSION_KEY];
    if (!s) {
      s = { ledger, ledgerCity };
      wSession[SESSION_KEY] = s;
    }
    return s;
  }

  function persistSession(): void {
    // Mutate in place — the session object also carries the load marker across reloads.
    const s = ensureSession();
    s.ledger = ledger;
    s.ledgerCity = ledgerCity;
  }

  function elapsedSeconds(): number | null {
    try {
      const v = api.gameState.getElapsedSeconds();
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** City key for localStorage — falls back to session city during early bootstrap. */
  function storageCity(city = key()): string {
    if (city !== 'unknown') return city;
    return wSession[SESSION_KEY]?.ledgerCity ?? city;
  }

  function loadLedgerForInit(city: string, applyQueuedMutations: boolean): LedgerState {
    const storeCity = storageCity(city);
    const fromStore = store ? loadFromStore(store, LEDGER_KEY(storeCity)) : newLedger();
    const session = wSession[SESSION_KEY];
    const sessionOk = !!session?.ledger
      && (city === 'unknown' || session.ledgerCity === city);

    if (applyQueuedMutations) {
      // Prefer store, but keep any pendingRemovals that only exist in the session yet.
      return sessionOk ? mergePendingRemovals(fromStore, session.ledger) : fromStore;
    }
    if (sessionOk) return mergePendingRemovals(session.ledger, fromStore);
    return fromStore;
  }

  function persistLedgerToStore(): void {
    if (!store) return;
    const city = storageCity();
    if (city === 'unknown') return;
    ledgerCity = city;
    saveToStore(store, LEDGER_KEY(city), ledger);
  }

  const isClearQueued = (city = storageCity()): boolean => {
    if (!store) return false;
    return store.getItem(CLEAR_KEY(city)) === CLEAR_ON
      || store.getItem(LEGACY_CLEAR_KEY) === CLEAR_ON;
  };

  function syncPanelState(): void {
    const dd = api.gameState.getDemandData();
    const clearQueued = isClearQueued();
    const deferredRemovalCount = dd
      ? deferredRemovalPopCount(dd, ledger, clearQueued)
      : 0;
    const s = overlayStore.get();
    overlayStore.set({
      deferredRemovalCount,
      clearQueued,
      revision: (s.revision ?? 0) + 1,
    });
  }

  /** Live routes only — in-progress (temp-parent) routes do not induce demand. */
  function inductionStations(): Station[] {
    return api.gameState.getStations({ includeTempRoutes: false });
  }

  /** Live routes incl. stations, for graph + hash. */
  function liveRoutes() {
    return api.gameState.getRoutes({ includeTempRoutes: false });
  }

  /** Graph + opportunities + access index — the weight layer both tiers share. */
  function computeWeights(dd: DemandData): {
    routes: ReturnType<typeof liveRoutes>;
    stations: Station[];
    graph: StationGraph;
    opps: StationOpportunity[];
    accessIdx: AccessIndex;
    hash: string;
    serviceHash: string;
  } {
    const routes = liveRoutes();
    const stations = inductionStations();
    const groups = api.gameState.getStationGroups?.() ?? [];
    const graph = buildStationGraph(routes, stations, groups, DEFAULT_CONFIG);
    const opps = computeOpportunities(graph, stationMasses(stations, dd.points.values(), DEFAULT_CONFIG), DEFAULT_CONFIG);
    return {
      routes, stations, graph, opps,
      accessIdx: buildAccessIndex(opps, DEFAULT_CONFIG),
      hash: computeStructuralHash(routes),
      serviceHash: computeServiceHash(routes),
    };
  }

  /** Fit + site-builder options for a rebuild, given fresh weights. */
  function prepareBuild(
    dd: DemandData,
    accessIdx: AccessIndex,
    stations: Station[],
    water: WaterIndex | null,
    city: string,
  ): { fit: DensityFit; buildOpts: BuildSitesOpts } {
    const fitInput: FitInputPoint[] = [...dd.points.values()].map((p) => {
      const a = accessIdx.at(p.location);
      return { location: p.location, residents: p.residents, jobs: p.jobs, access: Math.max(a.res, a.com) };
    });
    const fit = fitDensity(fitInput, DEFAULT_CONFIG);
    return {
      fit,
      buildOpts: {
        dd,
        stations,
        materialized: ledger.materialized ?? {},
        catchmentM: DEFAULT_CONFIG.CATCHMENT_SECONDS * DEFAULT_CONFIG.WALK_SPEED,
        deps: {
          spacingAt: (c) => {
            const a = accessIdx.at(c);
            return spacingAt(fit, Math.max(a.res, a.com));
          },
          accessAt: (c) => accessIdx.at(c),
          isWater: (c) => water?.isWater(c) ?? false,
        },
        seedPrefix: city,
        cfg: DEFAULT_CONFIG,
      },
    };
  }

  /** Increments to cancel an in-flight chunked rebuild (newer build/city/generation wins). */
  let fieldBuildGen = 0;

  /**
   * Tier 1 — full structural rebuild (spec §8), CHUNKED: the sampling loop is
   * time-boxed (~12 ms per slice) and yields to the event loop between slices,
   * so a 10k-site rebuild never blocks a frame (the synchronous version was
   * measured at 161 s in-game). The field snapshot is swapped only on
   * completion — consumers always see a complete, consistent field. Runs at
   * init and debounced on route created/deleted.
   */
  async function rebuildField(): Promise<void> {
    const city = key();
    if (city === 'unknown') return;
    let dd = api.gameState.getDemandData();
    if (!dd) return;
    const gen = ++fieldBuildGen;
    const session = ensureSession();
    let water = session.field?.city === city ? session.field.water : null;
    let waterFailed = session.field?.city === city ? session.field.waterFailed : false;
    if (!water && !waterFailed) {
      water = await loadWaterIndex(city);
      waterFailed = water === null;
    }
    const stale = (): boolean => gen !== fieldBuildGen || !isCurrent() || key() !== city;
    if (stale()) return;
    const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();

    // Phase A: weights (ms-scale, synchronous).
    dd = api.gameState.getDemandData();
    if (!dd) return;
    const weights = computeWeights(dd);
    await yieldToLoop();
    if (stale()) return;

    // Phase B: density fit (ms-scale).
    const { fit, buildOpts } = prepareBuild(dd, weights.accessIdx, weights.stations, water, city);
    const builder = createSiteBuilder(buildOpts);
    await yieldToLoop();
    if (stale()) return;

    // Phase C: sampling, time-boxed slices.
    let chunks = 0;
    let maxChunkMs = 0;
    for (;;) {
      const chunkStart = performance.now();
      let more = true;
      while (more && performance.now() - chunkStart < 12) more = builder.step();
      chunks++;
      maxChunkMs = Math.max(maxChunkMs, performance.now() - chunkStart);
      if (!more) break;
      await yieldToLoop();
      if (stale()) return;
    }

    const sites = builder.finish();
    session.field = {
      city, sites,
      graph: weights.graph, opps: weights.opps, accessIdx: weights.accessIdx,
      fit, hash: weights.hash, serviceHash: weights.serviceHash, massDrift: 0,
      water, waterFailed,
    };
    const total = performance.now() - t0;
    perf.record('tier1', PERF_BUDGETS.tier1Total, total,
      `${sites.length} sites, ${chunks} chunks, max ${maxChunkMs.toFixed(1)}ms`);
    if (maxChunkMs > PERF_BUDGETS.tier1Chunk) {
      console.warn(`${TAG} tier1 chunk over budget: ${maxChunkMs.toFixed(1)}ms > ${PERF_BUDGETS.tier1Chunk}ms`);
    }
    refreshHeatmap();
  }

  /**
   * Synchronous Tier 1, only for the day-end structural-hash promotion: growth
   * must not run on a stale structure, and post-optimization the full rebuild
   * is a small, rare hitch (unhooked route edits only — route hooks already
   * fire the chunked path).
   */
  function rebuildFieldSync(dd: DemandData, city: string, water: WaterIndex | null, waterFailed: boolean): void {
    fieldBuildGen++; // cancel any in-flight chunked build; this snapshot is newer
    perf.track('tier1', PERF_BUDGETS.tier1, () => {
      const weights = computeWeights(dd);
      const { fit, buildOpts } = prepareBuild(dd, weights.accessIdx, weights.stations, water, city);
      const builder = createSiteBuilder(buildOpts);
      while (builder.step()) { /* run to completion */ }
      const sites = builder.finish();
      ensureSession().field = {
        city, sites,
        graph: weights.graph, opps: weights.opps, accessIdx: weights.accessIdx,
        fit, hash: weights.hash, serviceHash: weights.serviceHash, massDrift: 0,
        water, waterFailed,
      };
      return sites;
    }, (sites) => `${sites.length} sites (sync promotion)`);
    refreshHeatmap();
  }

  /** Mass drift beyond this fraction of city demand triggers a weight refresh. */
  const MASS_DRIFT_REFRESH = 0.02;

  /**
   * Tier 2 — day-end weight refresh (spec §8), PRUNED: skipped entirely when
   * neither the service inputs (schedules/timings) nor accumulated demand
   * drift changed. Promotes to a synchronous Tier 1 when the structural hash
   * changed (route edits fire NO hook — this is the primary edit detector).
   */
  function refreshFieldWeights(dd: DemandData): void {
    const session = ensureSession();
    const f = session.field;
    const city = key();
    if (!f || f.city !== city) {
      // No usable field: growth skips this day; the chunked rebuild fills it.
      void rebuildField();
      return;
    }
    const routes = liveRoutes();
    if (computeStructuralHash(routes) !== f.hash) {
      rebuildFieldSync(dd, city, f.water, f.waterFailed);
      return;
    }
    let totalMass = 0;
    for (const p of dd.points.values()) totalMass += p.residents + p.jobs;
    const drifted = f.massDrift > MASS_DRIFT_REFRESH * Math.max(1, totalMass);
    if (computeServiceHash(routes) === f.serviceHash && !drifted) return; // steady state: skip
    perf.track('tier2', PERF_BUDGETS.tier2, () => {
      const weights = computeWeights(dd);
      f.graph = weights.graph;
      f.opps = weights.opps;
      f.accessIdx = weights.accessIdx;
      f.serviceHash = weights.serviceHash;
      f.massDrift = 0;
      refreshSiteAccess(f.sites, (c) => weights.accessIdx.at(c));
    });
  }

  /** Debounced Tier 1 for route hooks (bursts on batch edits). */
  let fieldRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFieldRebuild(): void {
    if (fieldRebuildTimer) clearTimeout(fieldRebuildTimer);
    fieldRebuildTimer = setTimeout(() => {
      fieldRebuildTimer = null;
      if (isCurrent()) void rebuildField();
    }, 500);
  }

  function refreshHeatmap(): void {
    const s = overlayStore.get();
    const view = (s.heatView ?? 'off') as HeatView;
    const f = wSession[SESSION_KEY]?.field;
    if (view === 'off' || !f || f.city !== key()) { setHeatmapVisible(api, false); return; }
    updateHeatmap(api, buildHeatFeatures(f.sites, ledger, view, DEFAULT_CONFIG));
    setHeatmapVisible(api, true);
  }

  /**
   * Driving distance/time for induced pops. Three tiers (see model/drivingModel):
   * the city's real road network, else resampled native pops, else measured constants.
   *
   * The road graph costs ~2 s to parse and build, so it loads ONCE per city, lazily,
   * off the critical path. Pops created meanwhile use the cheaper tiers and are
   * upgraded in place once routing is ready.
   */
  function drivingModel(): DrivingModel {
    const city = key();
    const cached = wSession[SESSION_KEY]?.driving;
    if (cached && cached.city === city) {
      // Resume an attempt that never finished. A mod reload can supersede the
      // generation that started the load, and the city entry already existing must
      // not mean "routing is handled" — that silently left us on the donor tier.
      if (!cached.routing && !cached.loading && (cached.attempts ?? 0) < MAX_ROAD_LOAD_ATTEMPTS
        && city !== 'unknown') {
        void loadRoadGraph(city);
      }
      return cached.model;
    }
    // First time for this city: install the donor tier immediately (free, from the
    // pops already in memory) and start the road-graph load in the background.
    const dd = api.gameState.getDemandData();
    const model = dd ? createDrivingModel({ donors: buildDonorBands(dd) }) : DEFAULT_DRIVING_MODEL;
    ensureSession().driving = { city, model, routing: null, speeds: null, loading: false, attempts: 0 };
    if (city !== 'unknown') void loadRoadGraph(city);
    return model;
  }

  /**
   * The city's own pops are labelled examples for model/speedFit: their endpoints plus
   * the driving time the game's offline router produced. Sorted by id and capped so a
   * city calibrates identically every load.
   */
  function calibrationPairs(dd: DemandData): CalibrationPair[] {
    const SAMPLE = 300;
    return [...dd.popsMap.values()]
      .filter((p) => !p.id.startsWith(INDUCED_PREFIX) && p.drivingSeconds > 0
        && dd.points.has(p.residenceId) && dd.points.has(p.jobId))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, SAMPLE)
      .map((p) => ({
        residence: dd.points.get(p.residenceId)!.location,
        job: dd.points.get(p.jobId)!.location,
        seconds: p.drivingSeconds,
      }));
  }

  /**
   * Fitted speeds for this city, from cache when possible. The fit costs ~900 A*
   * queries; its inputs (road graph + native pops) are fixed per city data version,
   * so the result is stable and worth persisting.
   */
  async function cachedSpeeds(city: string, graph: RoadGraph, dd: DemandData): Promise<Speeds> {
    const stamp = `${graph.nodeCount}:${dd.popsMap.size}`;
    try {
      const raw = store?.getItem(SPEEDS_KEY(city));
      if (raw) {
        const cached = JSON.parse(raw) as { stamp?: string; speeds?: Speeds };
        const s = cached.speeds;
        if (cached.stamp === stamp && s
          && [s.highway, s.major, s.minor].every((v) => typeof v === 'number' && v > 0)) {
          return s;
        }
      }
    } catch { /* unreadable cache — just refit */ }
    const speeds = await calibrateSpeedsAsync(graph, calibrationPairs(dd));
    try { store?.setItem(SPEEDS_KEY(city), JSON.stringify({ stamp, speeds })); } catch { /* quota */ }
    return speeds;
  }

  /**
   * The city's road network. Read straight from the game's local data server (see
   * game/cityData): `api.utils.loadCityData` is broken in v1.4.10 — its internal
   * `await import("./helpers/loadData")` cannot resolve under the game's file://
   * origin, so it fails for every path. We still try it first in case a later build
   * fixes it, since that route shows the user the city-data notice.
   */
  async function loadRoads(city: string): Promise<RoadFeatureCollection | null> {
    const path = `/data/${city}/roads.geojson`;
    console.log(`${TAG} reading ${path} to route induced pops' commutes`);
    try {
      const viaApi = await api.utils.loadCityData?.(path);
      if (viaApi) return viaApi as RoadFeatureCollection;
    } catch { /* expected on v1.4.10: broken dynamic import */ }
    return loadCityJson<RoadFeatureCollection>(window as unknown as DataServerHost, path);
  }

  /** Fetch + build the road graph, fit speeds to the city's own pops, upgrade the model. */
  async function loadRoadGraph(city: string): Promise<void> {
    const session = ensureSession();
    if (!session.driving || session.driving.city !== city) return;
    if (session.driving.loading || session.driving.speeds) return; // in flight or already routing
    session.driving.loading = true;
    session.driving.attempts = (session.driving.attempts ?? 0) + 1;
    try {
      const raw = await loadRoads(city);
      if (!raw) return;
      // Geometry is kept so the pop-details view can draw the real route (see
      // game/routePathServer); it costs ~11 MB and nothing else needs it.
      const graph = buildRoadGraph(raw as RoadFeatureCollection, { keepGeometry: true });
      if (graph.edgeCount === 0) {
        console.log(`${TAG} ${city}: no usable road data — keeping the statistical driving model`);
        return;
      }
      const dd = api.gameState.getDemandData();
      if (!dd) return;
      const speeds = await cachedSpeeds(city, graph, dd);
      const s = wSession[SESSION_KEY];
      if (!s?.driving || s.driving.city !== city) return; // the player moved on
      const routing = { graph, router: createRouter(graph, speeds) };
      s.driving.model = createDrivingModel({ routing, donors: buildDonorBands(dd) });
      s.driving.routing = routing;
      s.driving.speeds = speeds;
      console.log(
        `${TAG} ${city}: routing on ${graph.nodeCount} road nodes — fitted speeds `
        + `highway ${speeds.highway.toFixed(1)}, major ${speeds.major.toFixed(1)}, `
        + `minor ${speeds.minor.toFixed(1)} m/s`,
      );
      // Pops already created used a cheaper tier; upgrade them in place.
      const fixed = rescueDrivingValues(dd, s.driving.model);
      if (fixed > 0) {
        console.log(`${TAG} re-estimated driving for ${fixed} induced pops`);
        refreshNativeDemandDots();
      }
    } catch (e) {
      console.warn(`${TAG} road data unavailable for ${city}; using the statistical driving model`, e);
    } finally {
      const s = wSession[SESSION_KEY];
      if (s?.driving && s.driving.city === city) s.driving.loading = false;
    }
  }

  /**
   * The road route for one of OUR pops, for the game's pop-details view.
   *
   * The game already asks for this (`map://paths/<city>/<popId>`) and falls back to a
   * straight line when the request fails — which, in this build, it always does. We
   * answer for induced pops only; see game/routePathServer for the interception rules.
   * Returns null (→ the straight line) whenever we cannot do better.
   */
  function inducedRoutePath(city: string, popId: string): Coordinate[] | null {
    if (city !== key()) return null;
    const driving = wSession[SESSION_KEY]?.driving;
    if (!driving || driving.city !== city || !driving.routing) return null; // graph not ready
    const dd = api.gameState.getDemandData();
    const pop = dd?.popsMap.get(popId);
    if (!dd || !pop || pop.size <= 0) return null; // unknown, or a retired stub
    const res = dd.points.get(pop.residenceId);
    const job = dd.points.get(pop.jobId);
    if (!res || !job) return null;
    const { graph, router } = driving.routing;
    const from = snapToNode(graph, res.location);
    const to = snapToNode(graph, job.location);
    if (!from || !to) return null;
    const route = router.route(from.node, to.node);
    if (!route) return null;
    // Draw from the demand point itself, not the road node we snapped to.
    return [res.location, ...pathCoordinates(graph, route), job.location];
  }

  /**
   * Commute-time slots built from the game's LIVE time-of-day table, so induced pops
   * depart on the same distribution as native ones — and follow any customization the
   * player or another mod applies. Falls back to the game's default table.
   */
  function liveSlotSet(): SlotSet {
    try {
      const pt = api.popTiming;
      const ranges = pt?.getCommuteTimeRanges?.();
      const usable = Array.isArray(ranges) && ranges.every(
        (r) => typeof r?.start === 'number' && typeof r?.end === 'number'
          && typeof r?.homeDemandMultiplier === 'number' && typeof r?.workDemandMultiplier === 'number',
      );
      return buildSlotSet({
        ranges: usable ? ranges : undefined,
        studentDampening: pt?.getStudentDampening?.(),
        airportDampening: pt?.getAirportDampening?.(),
      });
    } catch {
      return DEFAULT_SLOT_SET;
    }
  }

  /**
   * Force the game's NATIVE demand-dot layer to re-read live residents/jobs after we
   * changed them (see overlay/demandDotRefresh). No-op when the game lacks the
   * bubble-scale actions. Module-local state: after a mod reload the first nudge
   * simply re-adopts whatever scale is live.
   */
  let dotNudgeState: NudgeState | null = null;
  function refreshNativeDemandDots(): void {
    try {
      const { getDemandBubbleScale, setDemandBubbleScale } = api.actions;
      if (!getDemandBubbleScale || !setDemandBubbleScale) return;
      const current = getDemandBubbleScale();
      if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) return;
      const r = nextNudge(current, dotNudgeState);
      dotNudgeState = { base: r.base, lastSet: r.lastSet };
      setDemandBubbleScale(r.set);
    } catch (e) {
      console.error(`${TAG} native demand-dot refresh failed`, e);
    }
  }

  /** History entries for the CURRENT city (empty when the buffer belongs to another). */
  function historyDays(): readonly DayHistoryEntry[] {
    const s = wSession[SESSION_KEY];
    return s?.history && s.history.city === key() ? s.history.days : [];
  }

  function recordDayHistory(day: number, result: DayResult): void {
    const s = ensureSession();
    const city = key();
    const days = s.history?.city === city ? s.history.days : [];
    s.history = {
      city,
      days: pushDayHistory(days, {
        day, added: result.added, removed: result.removed, deltas: result.deltas,
      }),
    };
  }

  function refreshOverlay(): void {
    // Heatmap first, unconditionally: heatView is independent of the circle
    // overlay's enabled/historyDay state, and refreshHeatmap self-guards.
    refreshHeatmap();
    const s = overlayStore.get();
    // A selected history day takes precedence over the main overlay's On/Off.
    if (s.historyDay != null) {
      setOverlayVisible(api, false);
      const dd = api.gameState.getDemandData();
      const entry = historyDays().find((e) => e.day === s.historyDay);
      if (!dd || !entry) { setHistoryOverlayVisible(api, false); return; }
      updateHistoryOverlay(api, buildHistoryOverlay(entry, dd.points, s.metric));
      setHistoryOverlayVisible(api, true);
      return;
    }
    setHistoryOverlayVisible(api, false);
    if (!s.enabled) { setOverlayVisible(api, false); return; }
    const dd = api.gameState.getDemandData();
    if (!dd) return;
    const fieldForOverlay = wSession[SESSION_KEY]?.field;
    const fc = buildOverlay(
      dd,
      (p) => {
        if (!fieldForOverlay || fieldForOverlay.city !== key()) return { res: 0, com: 0 };
        return fieldForOverlay.accessIdx.at(p.location);
      },
      s.view, s.metric, DEFAULT_CONFIG,
    );
    lastMax = fc.maxValue;
    updateOverlay(api, fc);
    setOverlayVisible(api, true);
  }
  overlayStore.subscribe(refreshOverlay);

  /**
   * "Clear induced demand" — queue a reset applied on the NEXT load. We can't delete pops in a
   * running sim (the game holds in-flight train/journey movements that reference them by id, which
   * we can't reach, so a deletion throws every tick). Instead we persist a marker; on save reload
   * init() removes every induced pop before the simulation builds movements (safe), then resets the ledger.
   */
  function resetInducedDemand(): void {
    try {
      const city = storageCity();
      // Unknown city: fall back to the legacy global marker (consumed by the next load).
      store?.setItem(city === 'unknown' ? LEGACY_CLEAR_KEY : CLEAR_KEY(city), CLEAR_ON);
      syncPanelState();
      console.log(
        `${TAG} reset QUEUED for ${city} — applies on the next FULL load: restart the app or load `
        + `another city first. (Menu ▸ Continue re-uses the running session and does not reload the save.)`,
      );
    } catch (e) {
      console.error(`${TAG} reset failed`, e);
    }
  }

  function refreshPanelRender(): void {
    // History renders INLINE in the toolbar panel: the game's addFloatingPanel is
    // not a window-opener — it adds a collapsed top-bar icon (see docs/MODDING_UI.md).
    persistentUi.renderPanel = createPanel(
      api,
      overlayStore,
      () => lastMax,
      () => persistentUi.resetInducedDemand?.(),
      createHistoryPanel(api, overlayStore, historyDays),
      () => perf.summary(),
    );
  }

  function registerToolbarPanel(): void {
    refreshPanelRender();
    registerOverlay(api);
    registerHeatmap(api);
    const React = api.utils.React as { createElement: (type: unknown) => unknown };
    api.ui.addToolbarPanel({
      id: TOOLBAR_PANEL_ID,
      icon: 'TrendingUp',
      tooltip: 'Induced Demand',
      title: 'Induced Demand',
      width: 260,
      // Mount Panel as a React component so its store subscription (useEffect) runs.
      // Calling renderPanel() directly skips hooks and the deferred-removal label never updates.
      render: () => {
        const Panel = persistentUi.renderPanel;
        return Panel ? React.createElement(Panel) : null;
      },
    });
  }

  function registerToolbarPanelNow(): void {
    try {
      registerToolbarPanel();
    } catch (e) {
      console.error(`${TAG} overlay/panel registration failed`, e);
    }
  }

  function ensureToolbarPanel(): void {
    if (!isCurrent()) return;
    // addToolbarPanel always pushes; unregister first (same pattern as addFloatingPanel).
    try {
      api.ui.unregisterComponent(TOOLBAR_PLACEMENT, TOOLBAR_PANEL_ID);
    } catch (e) {
      console.error(`${TAG} toolbar unregister failed`, e);
    }
    registerToolbarPanelNow();
  }

  persistentUi.resetInducedDemand = resetInducedDemand;
  refreshPanelRender();

  // Answer the game's own request for our pops' driving routes.
  try {
    installRoutePathFetch(window, (city, popId) => (isCurrent() ? inducedRoutePath(city, popId) : null));
  } catch (e) {
    console.warn(`${TAG} could not serve driving routes to the pop details view`, e);
  }

  // Self-heal orphaned movements (see model/movementRepair): the game logs
  // "Pop not found for pop movement induced:N" through console.error every tick.
  // Patch console.error ONCE per page session (window-keyed — re-patching each mod
  // reload would chain wrappers); each generation takes over the handler.
  const REPAIR_KEY = '__inducedDemandDanglingRepair__';
  interface RepairHook { handle?: (id: string) => void; }
  const wRepair = window as unknown as Record<string, RepairHook | undefined>;
  if (!wRepair[REPAIR_KEY]) {
    const hook: RepairHook = {};
    wRepair[REPAIR_KEY] = hook;
    const original = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
      original(...args);
      try {
        const id = parseDanglingInducedMovementId(args);
        if (id) hook.handle?.(id);
      } catch { /* never interfere with logging */ }
    };
  }
  const repairedIds = new Set<string>();
  wRepair[REPAIR_KEY].handle = (id) => {
    if (!isCurrent() || repairedIds.has(id)) return;
    repairedIds.add(id);
    // Repair outside the console.error call (and its tick) — next macrotask.
    setTimeout(() => {
      if (!isCurrent()) return;
      try {
        const dd = api.gameState.getDemandData();
        if (!dd) return;
        if (repairDanglingMovement(dd, ledger, id, DEFAULT_CONFIG)) {
          persistSession();
          persistLedgerToStore();
          console.log(`${TAG} repaired dangling movement ${id} (stubbed + tombstoned)`);
        }
      } catch (e) {
        console.warn(`${TAG} dangling-movement repair failed for ${id}`, e);
      }
    }, 0);
  };

  // Identity is read LIVE:
  // for save-loaded sessions, so cached values can't be trusted for the storage key.
  const currentCity = (): string => {
    try { return api.utils.getCityCode?.() || cachedCity; } catch { return cachedCity; }
  };
  // Key by CITY ONLY. The save name (getSaveName) is a timestamped autosave label that churns
  // every autosave, so including it meant data was saved under one key and looked up under another
  // on reload — and lost. City-only is stable across all saves/reloads of the same city.
  const key = (): string => currentCity() || 'unknown';

  function hashSeed(s: string, day: number): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h ^ day) >>> 0;
  }

  // Ensure the id counter is past any induced pop already in the loaded save — including
  // retired ids (tombstones/pending) whose stubs may not be in popsMap yet — so
  // regenerated ids cannot collide even if the ledger was not (or was wrongly) persisted.
  function bumpSeq(dd: DemandData): void {
    let max = ledger.seq;
    const consider = (id: string): void => {
      if (!id.startsWith(INDUCED_PREFIX)) return;
      const n = Number(id.slice(INDUCED_PREFIX.length));
      if (Number.isFinite(n) && n + 1 > max) max = n + 1;
    };
    for (const id of dd.popsMap.keys()) consider(id);
    for (const id of ledger.pendingRemovals ?? []) consider(id);
    for (const id of Object.keys(ledger.tombstones ?? {})) consider(id);
    ledger.seq = max;
  }

  // Runs once per load, as soon as demand data is available.
  function ensureReconcile(dd: DemandData): void {
    if (didReconcile) return;
    // Materialized points FIRST: the load dropped them (city-file-authoritative
    // merge), and roster pops may reference induced-pt:* endpoints.
    const mat = recreateMaterializedPoints(dd, ledger);
    if (mat.recreated || mat.dropped) {
      console.log(`${TAG} materialized points: recreated ${mat.recreated}, GC'd ${mat.dropped}`);
    }
    reconcileBaselines(dd, ledger);
    applyPendingAccum(ledger); // restore persisted growth pressure now that baselines exist
    bumpSeq(dd);
    // Restore any induced pops the save/sim dropped (see reconcileInducedPops). Must run AFTER
    // reconcileBaselines/bumpSeq: baselines are then already fixed, so the pops we re-add here
    // can't be mistaken for baseline demand. Idempotent — pops still present are left untouched.
    const slots = liveSlotSet();
    const driving = drivingModel();
    const restored = reconcileInducedPops(dd, ledger, DEFAULT_CONFIG, slots, driving);
    if (restored > 0) console.log(`${TAG} restored ${restored} induced pops missing from the save`);
    // Retired pops must stay resolvable by id (saves keep movements, strip pops).
    restoreTombstoneStubs(dd, ledger, DEFAULT_CONFIG);
    // A pop whose endpoints vanished (city data update, or a stub an older build wrote
    // with empty ids) makes the commute worker throw for the WHOLE batch. Re-anchor
    // them before the simulation next runs.
    const orphans = rescueOrphanedPops(dd, DEFAULT_CONFIG);
    if (orphans > 0) console.log(`${TAG} re-anchored ${orphans} induced pops whose demand points no longer exist`);
    // Repair pops holding stale commute times (older builds pinned every commute to
    // 8:00/17:00). Retimes in place — never re-creates a pop (see model/commuteRescue).
    const retimed = rescueCommuteTimes(dd, slots);
    if (retimed > 0) console.log(`${TAG} rescued ${retimed} induced pops with stale commute times`);
    const redriven = rescueDrivingValues(dd, driving);
    if (redriven > 0) console.log(`${TAG} rescued ${redriven} induced pops with stale driving values`);
    if (retimed > 0 || redriven > 0) refreshNativeDemandDots();
    didReconcile = true;
  }

  function init(applyQueuedMutations = false): void {
    try {
      if (applyQueuedMutations) pendingApplyMutations = true;
      // Deleting pops is only safe on a REAL save load (before the sim builds
      // movements). Mod-reload replays of onGameLoaded carry the same save name
      // and a non-rewound game clock — classify and skip them (see model/loadGuard).
      const sess = ensureSession();
      const elapsed = elapsedSeconds();
      const loadKind = classifyGameLoad(sess.loadMarker ?? null, sess.lastLoadedSaveName ?? null, elapsed);
      const shouldApply = pendingApplyMutations && loadKind === 'fresh-load';
      didReconcile = false;
      const city = key();
      // Always merge session↔store so pendingRemovals aren't lost when one side lags.
      ledger = loadLedgerForInit(city, shouldApply);
      ledgerCity = city !== 'unknown'
        ? city
        : (wSession[SESSION_KEY]?.ledgerCity ?? city);

      const dd = api.gameState.getDemandData();
      if (!dd) {
        if (DEBUG && shouldApply) {
          console.log(`${TAG} init: apply pending but demand data not ready yet — will retry`);
        }
        persistSession();
        return;
      }

      const clearCity = storageCity(city);
      const pendingClear = shouldApply && isClearQueued(clearCity);
      if (pendingClear) { // consume once (both scoped and legacy markers)
        store?.removeItem(CLEAR_KEY(clearCity));
        store?.removeItem(LEGACY_CLEAR_KEY);
      }

      if (pendingClear) {
        // Detach + tombstone, never delete: a hard popsMap.delete orphans in-flight
        // movements (live or restored from the save) → GameLoop tick error every tick.
        const cleared = clearAllInduced(dd, ledger, DEFAULT_CONFIG);
        ledger = cleared.ledger;
        if (store && city !== 'unknown') {
          saveToStore(store, LEDGER_KEY(city), ledger);
        }
        console.log(`${TAG} CLEAR applied: retired ${cleared.removed} induced pops; ledger reset (stubs remain until the game's next save strips them).`);
      }
      if (shouldApply) {
        const queued = ledger.pendingRemovals?.length ?? 0;
        const retired = retirePendingRemovals(dd, ledger, DEFAULT_CONFIG);
        console.log(
          `${TAG} retirePendingRemovals: queued=${queued}, retired=${retired}`,
        );
      }
      if (pendingApplyMutations) {
        // Processed (applied, or skipped as a mod-reload replay) — settle the marker.
        if (loadKind === 'fresh-load') {
          sess.loadMarker = markerForLoad(sess.lastLoadedSaveName ?? null, elapsed);
        } else {
          if (sess.loadMarker) observeElapsed(sess.loadMarker, elapsed);
          if (DEBUG) {
            console.log(`${TAG} onGameLoaded replay (mod reload) — queued clear/removals kept for the next real load`);
          }
        }
        pendingApplyMutations = false;
      }
      ensureReconcile(dd);
      captureBaselines(dd, ledger);
      ready = true;
      void rebuildField();
      refreshOverlay();
      syncPanelState();
      const pts = dd.points.size;
      const stations = api.gameState.getStations().length;
      console.log(`${TAG} ready for ${key()} — ${pts} demand points, ${stations} stations`);
      persistSession();
      persistLedgerToStore();
    } catch (e) {
      console.error(`${TAG} init failed`, e);
    }
  }

  // One-time dump of real runtime shapes to verify the spec's §13 assumptions.
  function logSample(dd: DemandData, stations: Station[]): void {
    if (loggedSample) return;
    loggedSample = true;
    try {
      const p = dd.points.values().next().value;
      const pop = dd.popsMap.values().next().value;
      const st = stations[0];
      console.log(`${TAG} sample point:`, p && {
        id: p.id, residents: p.residents, jobs: p.jobs,
        residentModeShare: p.residentModeShare, workerModeShare: p.workerModeShare,
        popIdCount: p.popIds?.length,
      });
      console.log(`${TAG} sample pop:`, pop && { size: pop.size, residenceId: pop.residenceId, jobId: pop.jobId });
      console.log(`${TAG} sample station:`, st && { id: st.id, coords: st.coords, routeIds: st.routeIds });
    } catch (e) {
      console.error(`${TAG} sample log failed`, e);
    }
  }

  // Toolbar: reloadMods clears uiComponents then re-fires onMapReady + onGameLoaded;
  // save reload only fires onGameLoaded (see docs/MODDING_UI.md).
  function setup(): void {
    if (!isCurrent()) return;
    persistentUi.mapReady = true;
    ensureToolbarPanel();
    void init(false);
    // Menu ▸ Continue (same city) remounts the map WITHOUT applying the pending save
    // (game v1.4.10 StoreInitializer caches init per city|mode), so onGameLoaded never
    // fires and queued work cannot safely apply — the old sim state (in-flight journeys)
    // is still live. Tell the user instead of leaving the count silently stuck.
    const queued = ledger.pendingRemovals?.length ?? 0;
    if (queued > 0 || isClearQueued()) {
      console.log(
        `${TAG} ${queued} queued removal(s)${isClearQueued() ? ' + a full clear' : ''} pending — `
        + `they apply on the next FULL load (app restart, or load a different city and come back). `
        + `Menu ▸ Continue does not actually reload the save.`,
      );
    }
  }

  api.hooks.onMapReady(setup);
  api.hooks.onGameLoaded((saveName) => {
    if (!isCurrent()) return;
    // Always request the apply; init() classifies real load vs mod-reload replay.
    ensureSession().lastLoadedSaveName = saveName ?? null;
    if (DEBUG) console.log(`${TAG} onGameLoaded save=${saveName}`);
    void init(true);
    ensureToolbarPanel();
  });
  // Save reload can fire onGameLoaded before demand data exists; finish deferred apply then.
  api.hooks.onDemandChange(() => {
    if (!isCurrent() || !pendingApplyMutations) return;
    if (DEBUG) console.log(`${TAG} onDemandChange: retrying deferred apply`);
    void init(true);
  });
  api.hooks.onCityLoad((code) => {
    if (!isCurrent()) return;
    cachedCity = code;
    didReconcile = false;
    loggedSample = false;
    // History (and any selected day) belongs to one city; drop both on a city switch.
    const hist = wSession[SESSION_KEY]?.history;
    if (hist && hist.city !== code) {
      delete wSession[SESSION_KEY]!.history;
      if (overlayStore.get().historyDay != null) overlayStore.set({ historyDay: null });
    }
    // City code often arrives after onGameLoaded on save reload — retry apply with the right key.
    if (pendingApplyMutations) {
      if (DEBUG) console.log(`${TAG} onCityLoad(${code}): retrying deferred apply`);
      void init(true);
    }
  });

  api.hooks.onRouteCreated(() => { if (isCurrent()) scheduleFieldRebuild(); });
  api.hooks.onRouteDeleted(() => { if (isCurrent()) scheduleFieldRebuild(); });

  api.hooks.onDayChange(async (day) => {
    if (!isCurrent()) return;
    if (!ready) return;
    // Keep the load marker's game-clock high-water mark current: a later save
    // reload is recognized by the clock rewinding below this (see model/loadGuard).
    const marker = wSession[SESSION_KEY]?.loadMarker;
    if (marker) observeElapsed(marker, elapsedSeconds());
    const dd = api.gameState.getDemandData();
    if (!dd) return;
    const stations = inductionStations();
    if (DEBUG) logSample(dd, stations);
    try {
      ensureReconcile(dd);
      captureBaselines(dd, ledger);
    } catch (e) {
      console.error(`${TAG} reconcile failed`, e);
    }
    // Tier 2 (or hash-promoted Tier 1) BEFORE growth — no growth day on stale weights.
    try {
      refreshFieldWeights(dd);
    } catch (e) {
      console.error(`${TAG} field refresh failed`, e);
    }
    const field = wSession[SESSION_KEY]?.field;
    let result: DayResult = { added: 0, removed: 0, newPoints: 0, deltas: {} };
    if (field && field.city === key()) {
      const jitterDep = (pid: string, nominal: Coordinate, rM: number): Coordinate =>
        jitterPosition(pid, nominal, rM, DEFAULT_CONFIG.J_FRAC, (c) => {
          if (field.water?.isWater(c)) return true;
          // Soft spacing vs every existing point (few k points × ≤ ~17 checks/day).
          // Access (→ spacing) computed ONCE per candidate position, not per point.
          const a = field.accessIdx.at(c);
          const softR = (1 - DEFAULT_CONFIG.J_FRAC) * spacingAt(field.fit, Math.max(a.res, a.com));
          for (const p of dd.points.values()) {
            if (haversine(c, p.location) < softR) return true;
          }
          return false;
        });
      try {
        result = perf.track('day', PERF_BUDGETS.day, () => runDay(
          dd, field.sites, ledger, DEFAULT_CONFIG,
          makeRng(hashSeed(currentCity(), day)),
          {
            massAt: (a) => massAt(field.fit, a),
            spacingAt: (a) => spacingAt(field.fit, a),
            jitter: jitterDep,
          },
          liveSlotSet(), drivingModel(),
        ), (r) => `+${r.added}/-${r.removed}/${r.newPoints}pt`);
      } catch (e) {
        console.error(`${TAG} runDay failed on day ${day}`, e);
      }
      // Demand-mass drift feeds the Tier 2 refresh threshold (opportunities
      // track the growing city without a daily recompute).
      field.massDrift += (result.added + result.removed) * DEFAULT_CONFIG.POP_SIZE * 2;
    } else if (DEBUG) {
      console.log(`${TAG} day ${day}: field not ready — growth skipped this day`);
    }
    recordDayHistory(day, result);
    if (DEBUG) {
      let induced = 0;
      for (const id of dd.popsMap.keys()) if (id.startsWith(INDUCED_PREFIX)) induced++;
      let maxPressure = 0, rp = 0, jp = 0, active = 0;
      for (const id in ledger.points) {
        const e = ledger.points[id];
        if (e.resAccum > 0) rp += e.resAccum;
        if (e.jobAccum > 0) jp += e.jobAccum;
        const m = Math.max(Math.abs(e.resAccum), Math.abs(e.jobAccum));
        if (m > 0) active++;
        if (m > maxPressure) maxPressure = m;
      }
      console.log(
        `${TAG} day ${day}: ${dd.points.size} pts, ${stations.length} stations, ${active} active, ` +
        `induced ${induced} (+${result.added} -${result.removed}), newPts ${result.newPoints}, ` +
        `Rp ${rp.toFixed(0)} Jp ${jp.toFixed(0)}, maxPressure ${maxPressure.toFixed(1)}/${DEFAULT_CONFIG.POP_SIZE}`,
      );
    } else if (result.added || result.removed) {
      console.log(`${TAG} day ${day}: +${result.added} -${result.removed} pops`);
    }
    if (overlayStore.get().enabled) refreshOverlay();
    if (result.added > 0 || result.removed > 0 || result.newPoints > 0) refreshNativeDemandDots();
    syncPanelState();
    refreshHeatmap();
    persistSession();
    if (result.removed > 0 || result.newPoints > 0) persistLedgerToStore();
  });

  api.hooks.onGameSaved(() => {
    if (!isCurrent() || !store) return;
    const city = key();
    // Only persist the ledger we actually loaded for THIS city. Guards the early-load race where
    // init ran before the city code was available (city 'unknown', empty ledger): without this, an
    // autosave could write that empty ledger over a real city's saved roster.
    if (city === 'unknown' || city !== ledgerCity) return;
    persistSession();
    saveToStore(store, LEDGER_KEY(city), ledger);
  });

  // Mod hot-reload: script re-runs; triggerPostReloadLifecycle re-fires hooks (no proactive register).
  try {
    if (api.gameState.getDemandData()) void init(false);
  } catch { /* game not loaded yet — the hooks will fire normally */ }
}
