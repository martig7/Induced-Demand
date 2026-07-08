/**
 * Induced Demand — entry point. Wires the per-day model engine to the game hooks.
 * Reads mode share + catchment; writes only demand (residents/jobs/pops).
 */
import type { DemandData, Station } from './types/game-state';
import { runDay } from './model/engine';
import { DEFAULT_CONFIG } from './model/config';
import { makeRng } from './model/gravity';
import { INDUCED_PREFIX, removeInducedPop } from './model/popFactory';
import {
  loadFromStore, saveToStore, captureBaselines, reconcileBaselines, reconcileInducedPops,
  applyPendingAccum, newLedger, type LedgerState, type KVStore,
} from './model/ledger';
import { buildOverlay } from './overlay/featureCollection';
import { registerOverlay, updateOverlay, setOverlayVisible } from './overlay/overlay';
import { createOverlayStore, type OverlayStore } from './overlay/state';
import { createPanel } from './ui/panel';

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

  // Cross-reload UI state, persisted on `window` like `myGen` below: "Reload all mods" re-executes
  // this whole script, but `api.ui.addToolbarPanel` has no id-based de-dupe — it just pushes onto an
  // array — so calling it again on every reload stacked a 2nd (3rd, ...) inert-but-visible icon
  // forever. Register the panel/overlay AT MOST ONCE per app session (module-local `registered` would
  // reset on every reload; this doesn't), and share the SAME overlayStore object across reloads too —
  // the panel added on session 1 is the only one that's ever shown, and because later generations'
  // fresh onDayChange hooks read/subscribe to that SAME store (not a fresh disabled-by-default one),
  // toggling the (permanently gen-1-bound) panel still drives every later generation's auto-refresh.
  interface PersistentUi { registered: boolean; overlayStore: OverlayStore }
  const UI_KEY = '__inducedDemandUi__';
  const wUi = window as unknown as Record<string, PersistentUi>;
  if (!wUi[UI_KEY]) {
    wUi[UI_KEY] = {
      registered: false,
      overlayStore: createOverlayStore({ enabled: false, view: 'realized', metric: 'combined' }),
    };
  }
  const persistentUi = wUi[UI_KEY];
  const overlayStore = persistentUi.overlayStore;
  let lastMax = 0;

  function refreshOverlay(): void {
    if (!overlayStore.get().enabled) { setOverlayVisible(api, false); return; }
    const dd = api.gameState.getDemandData();
    if (!dd) return;
    const s = overlayStore.get();
    const fc = buildOverlay(dd, api.gameState.getStations(), s.view, s.metric, DEFAULT_CONFIG);
    lastMax = fc.maxValue;
    updateOverlay(api, fc);
    setOverlayVisible(api, true);
  }
  overlayStore.subscribe(refreshOverlay);

  // Persist through localStorage, NOT api.storage: the game's mod-storage keeps an in-memory map it
  // does NOT rehydrate from disk on a cold launch, so api.storage.get returns nothing after a full
  // restart (it survived only warm, in-session reloads). localStorage IS hydrated by Electron on
  // cold start, so the roster actually round-trips. (Same approach as the Improved Schematics mod.)
  const store: KVStore | null = (() => {
    try { return window.localStorage; } catch { return null; }
  })();
  const LEDGER_KEY = (city: string): string => `induceddemand:ledger:${city}`;
  // Clear-demand marker: set on click, applied + cleared on the next load. Kept as its own key.
  const CLEAR_KEY = 'induceddemand:clear';
  const CLEAR_ON = '1';

  /**
   * "Clear induced demand" — queue a reset applied on the NEXT load. We can't delete pops in a
   * running sim (the game holds in-flight train/journey movements that reference them by id, which
   * we can't reach, so a deletion throws every tick). Instead we persist a marker; on reload init()
   * removes every induced pop before the simulation builds movements (safe), then resets the ledger.
   */
  function resetInducedDemand(): void {
    try {
      store?.setItem(CLEAR_KEY, CLEAR_ON);
      console.log(`${TAG} reset QUEUED — reload the save to clear induced demand (applied safely at load).`);
    } catch (e) {
      console.error(`${TAG} reset failed`, e);
    }
  }

  // Guard against duplicate execution: the mod loader may run this script more than
  // once (e.g. initial load + "Reload all mods"), leaving stale hook callbacks
  // registered. Each execution claims a generation; callbacks from any but the latest
  // generation no-op, so exactly one instance is ever active (newest wins; hot-reload-safe).
  const GEN_KEY = '__inducedDemandGeneration__';
  const w = window as unknown as Record<string, number>;
  const myGen = (w[GEN_KEY] = (w[GEN_KEY] ?? 0) + 1);
  const isCurrent = (): boolean => w[GEN_KEY] === myGen;

  // Identity is read LIVE: onCityLoad/onGameInit may be skipped or fire out of order
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

  // Ensure the id counter is past any induced pop already in the loaded save, so
  // regenerated ids cannot collide even if the ledger was not (or was wrongly) persisted.
  function bumpSeq(dd: DemandData): void {
    let max = ledger.seq;
    for (const id of dd.popsMap.keys()) {
      if (!id.startsWith(INDUCED_PREFIX)) continue;
      const n = Number(id.slice(INDUCED_PREFIX.length));
      if (Number.isFinite(n) && n + 1 > max) max = n + 1;
    }
    ledger.seq = max;
  }

  // Runs once per load, as soon as demand data is available.
  function ensureReconcile(dd: DemandData): void {
    if (didReconcile) return;
    reconcileBaselines(dd, ledger);
    applyPendingAccum(ledger); // restore persisted growth pressure now that baselines exist
    bumpSeq(dd);
    // Restore any induced pops the save/sim dropped (see reconcileInducedPops). Must run AFTER
    // reconcileBaselines/bumpSeq: baselines are then already fixed, so the pops we re-add here
    // can't be mistaken for baseline demand. Idempotent — pops still present are left untouched.
    const restored = reconcileInducedPops(dd, ledger, DEFAULT_CONFIG);
    if (restored > 0) console.log(`${TAG} restored ${restored} induced pops missing from the save`);
    didReconcile = true;
  }

  function init(): void {
    try {
      didReconcile = false;
      const city = key();
      // localStorage is synchronous and cold-start-hydrated, so this load actually returns the
      // persisted roster (unlike api.storage). Load the ledger for the CURRENT city and remember
      // which city it belongs to, so a save can never write it under the wrong (e.g. 'unknown') key.
      ledger = store ? loadFromStore(store, LEDGER_KEY(city)) : newLedger();
      ledgerCity = city;
      const pendingClear = store?.getItem(CLEAR_KEY) === CLEAR_ON;
      if (pendingClear) store?.removeItem(CLEAR_KEY); // consume once

      const dd = api.gameState.getDemandData();
      if (dd && pendingClear) {
        // Apply a queued "Clear induced demand" now — before the simulation builds movements for
        // this session, so removing the pops can't dangle any in-flight journey.
        let removed = 0;
        for (const id of [...dd.popsMap.keys()]) {
          if (id.startsWith(INDUCED_PREFIX) && removeInducedPop(dd, id, DEFAULT_CONFIG)) removed++;
        }
        ledger = newLedger();
        if (store) saveToStore(store, LEDGER_KEY(city), ledger); // persist the cleared state immediately
        console.log(`${TAG} CLEAR applied on load: removed ${removed} induced pops; ledger reset.`);
      }
      if (dd) { ensureReconcile(dd); captureBaselines(dd, ledger); }
      ready = true;
      refreshOverlay();
      const pts = dd ? dd.points.size : 0;
      const stations = api.gameState.getStations().length;
      console.log(`${TAG} ready for ${key()} — ${pts} demand points, ${stations} stations`);
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

  // Register the overlay/panel (once) and initialize. Driven by onMapReady, and also called
  // proactively below when the game is already loaded (mod hot-reload — see note at the bottom).
  function setup(): void {
    if (!isCurrent()) return;
    if (!persistentUi.registered) {
      persistentUi.registered = true;
      try {
        registerOverlay(api);
        api.ui.addToolbarPanel({
          id: 'induced-demand-map-mode',
          icon: 'TrendingUp',
          tooltip: 'Induced Demand',
          title: 'Induced Demand',
          width: 260,
          render: createPanel(api, overlayStore, () => lastMax, resetInducedDemand),
        });
      } catch (e) {
        console.error(`${TAG} overlay/panel registration failed`, e);
      }
    }
    void init();
  }

  api.hooks.onCityLoad((code) => { if (!isCurrent()) return; cachedCity = code; didReconcile = false; loggedSample = false; });
  api.hooks.onMapReady(setup);
  api.hooks.onGameLoaded(() => { if (!isCurrent()) return; void init(); });

  api.hooks.onDayChange((day) => {
    if (!isCurrent()) return;
    if (!ready) return;
    const dd = api.gameState.getDemandData();
    if (!dd) return;
    const stations = api.gameState.getStations();
    if (DEBUG) logSample(dd, stations);
    try {
      ensureReconcile(dd);
      captureBaselines(dd, ledger);
    } catch (e) {
      console.error(`${TAG} reconcile failed`, e);
    }
    let result = { added: 0, removed: 0 };
    try {
      result = runDay(dd, stations, ledger, DEFAULT_CONFIG, makeRng(hashSeed(currentCity(), day)));
    } catch (e) {
      console.error(`${TAG} runDay failed on day ${day}`, e);
    }
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
        `induced ${induced} (+${result.added} -${result.removed}), ` +
        `Rp ${rp.toFixed(0)} Jp ${jp.toFixed(0)}, maxPressure ${maxPressure.toFixed(1)}/${DEFAULT_CONFIG.POP_SIZE}`,
      );
    } else if (result.added || result.removed) {
      console.log(`${TAG} day ${day}: +${result.added} -${result.removed} pops`);
    }
    if (overlayStore.get().enabled) refreshOverlay();
  });

  api.hooks.onGameSaved(() => {
    if (!isCurrent() || !store) return;
    const city = key();
    // Only persist the ledger we actually loaded for THIS city. Guards the early-load race where
    // init ran before the city code was available (city 'unknown', empty ledger): without this, an
    // autosave could write that empty ledger over a real city's saved roster.
    if (city === 'unknown' || city !== ledgerCity) return;
    saveToStore(store, LEDGER_KEY(city), ledger);
  });

  // Mod hot-reload safety: on "Reload all mods" this script re-runs, but onMapReady/onGameLoaded
  // won't fire again for an already-loaded game — so the fresh instance would never become `ready`
  // and would stop triggering growth. If demand data is already available, set up right now.
  try {
    if (api.gameState.getDemandData()) setup();
  } catch { /* game not loaded yet — the hooks will fire normally */ }
}
