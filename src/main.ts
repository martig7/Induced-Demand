/**
 * Induced Demand — entry point. Wires the per-day model engine to the game hooks.
 * Reads mode share + catchment; writes only demand (residents/jobs/pops).
 */
import { runDay } from './model/engine';
import { DEFAULT_CONFIG } from './model/config';
import { makeRng } from './model/gravity';
import {
  loadLedger, saveLedger, captureBaselines, reconcileBaselines,
  newLedger, type LedgerState, type ModStorage,
} from './model/ledger';

const TAG = '[InducedDemand]';
const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found.`);
} else {
  let ledger: LedgerState = newLedger();
  let cityCode = '';
  let saveName = '';
  let ready = false;
  const storage = api.storage as ModStorage;
  const key = () => `${cityCode}:${saveName}`;

  const hashSeed = (s: string, day: number): number => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h ^ day) >>> 0;
  };

  api.hooks.onCityLoad((code) => {
    cityCode = code;
  });

  api.hooks.onMapReady(async () => {
    try {
      saveName = api.gameState.getSaveName?.() ?? '';
      ledger = await loadLedger(storage, key());
      const dd = api.gameState.getDemandData();
      if (dd) {
        reconcileBaselines(dd, ledger);
        captureBaselines(dd, ledger);
      }
      ready = true;
      console.log(`${TAG} ready for ${key()}`);
    } catch (e) {
      console.error(`${TAG} init failed`, e);
    }
  });

  api.hooks.onDayChange((day) => {
    try {
      if (!ready) return;
      const dd = api.gameState.getDemandData();
      if (!dd) return;
      captureBaselines(dd, ledger);
      const result = runDay(dd, api.gameState.getStations(), ledger, DEFAULT_CONFIG, makeRng(hashSeed(cityCode, day)));
      if (result.added || result.removed) {
        console.log(`${TAG} day ${day}: +${result.added} -${result.removed} pops`);
      }
    } catch (e) {
      console.error(`${TAG} day step failed`, e);
    }
  });

  api.hooks.onGameSaved(async (name) => {
    saveName = name;
    try {
      await saveLedger(storage, key(), ledger);
    } catch (e) {
      console.error(`${TAG} save failed`, e);
    }
  });

  api.hooks.onGameLoaded(async (name) => {
    saveName = name;
    try {
      ledger = await loadLedger(storage, key());
      const dd = api.gameState.getDemandData();
      if (dd) reconcileBaselines(dd, ledger);
      ready = true;
    } catch (e) {
      console.error(`${TAG} load failed`, e);
    }
  });
}
