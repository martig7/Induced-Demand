/**
 * Induced Demand — entry point. Wires the per-day model engine to the game hooks.
 * Reads mode share + catchment; writes only demand (residents/jobs/pops).
 */
import type { DemandData, Station } from './types/game-state';
import { runDay } from './model/engine';
import { DEFAULT_CONFIG } from './model/config';
import { makeRng } from './model/gravity';
import { INDUCED_PREFIX } from './model/popFactory';
import {
  loadLedger, saveLedger, captureBaselines, reconcileBaselines,
  newLedger, type LedgerState, type ModStorage,
} from './model/ledger';
import { buildOverlay } from './overlay/featureCollection';
import { registerOverlay, updateOverlay, setOverlayVisible } from './overlay/overlay';
import { createOverlayStore } from './overlay/state';
import { createPanel } from './ui/panel';

const TAG = '[InducedDemand]';
const DEBUG = true; // verbose per-day heartbeat while verifying; set false to quiet

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found.`);
} else {
  let ledger: LedgerState = newLedger();
  let cachedCity = '';
  let ready = false;
  let didReconcile = false;
  let loggedSample = false;
  let overlayRegistered = false;
  let lastMax = 0;
  const overlayStore = createOverlayStore({ enabled: false, view: 'realized', metric: 'combined' });

  function refreshOverlay(): void {
    if (!overlayStore.get().enabled) { setOverlayVisible(api, false); return; }
    const dd = api.gameState.getDemandData();
    if (!dd) return;
    const s = overlayStore.get();
    const fc = buildOverlay(dd, ledger, api.gameState.getStations(), s.view, s.metric, DEFAULT_CONFIG);
    lastMax = fc.maxValue;
    updateOverlay(api, fc);
    setOverlayVisible(api, true);
  }
  overlayStore.subscribe(refreshOverlay);

  const storage = api.storage as ModStorage;

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
  const currentSave = (): string => {
    try { return api.gameState.getSaveName?.() || ''; } catch { return ''; }
  };
  const key = (): string => `${currentCity() || 'unknown'}:${currentSave()}`;

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
    bumpSeq(dd);
    didReconcile = true;
  }

  async function init(): Promise<void> {
    try {
      didReconcile = false;
      ledger = await loadLedger(storage, key());
      const dd = api.gameState.getDemandData();
      if (dd) { ensureReconcile(dd); captureBaselines(dd, ledger); }
      ready = true;
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

  api.hooks.onCityLoad((code) => { if (!isCurrent()) return; cachedCity = code; didReconcile = false; loggedSample = false; });
  api.hooks.onMapReady(() => {
    if (!isCurrent()) return;
    if (!overlayRegistered) {
      overlayRegistered = true;
      try {
        registerOverlay(api);
        api.ui.addToolbarPanel({
          id: 'induced-demand-map-mode',
          icon: 'TrendingUp',
          tooltip: 'Induced Demand',
          title: 'Induced Demand',
          width: 260,
          render: createPanel(api, overlayStore, () => lastMax),
        });
      } catch (e) {
        console.error(`${TAG} overlay/panel registration failed`, e);
      }
    }
    void init();
  });
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

  api.hooks.onGameSaved(async () => {
    if (!isCurrent()) return;
    try { await saveLedger(storage, key(), ledger); } catch (e) { console.error(`${TAG} save failed`, e); }
  });
}
