import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGameLoad, markerForLoad, observeElapsed, type LoadMarker } from './loadGuard';

// Background (verified against the v1.4.10 bundle, see docs/MODDING_UI.md):
// `onGameLoaded` fires both for REAL save loads (loadSave → triggerGameLoaded) and as
// REPLAYS during mod reloads (immediate-invoke at registration + triggerPostReloadLifecycle,
// which can run before OR after `modding-api-reload-complete`, with async IPC gaps).
// Timing cannot distinguish them. State can:
//  - `saveName` (lifecycleState.currentSaveName) changes ONLY on a real load;
//  - elapsed game seconds never rewind within a loaded game — a rewind means a save was loaded.

test('first load of a page session (no marker) is a fresh load', () => {
  assert.equal(classifyGameLoad(undefined, 'auto_100', 500), 'fresh-load');
  assert.equal(classifyGameLoad(null, null, null), 'fresh-load');
});

test('different save name is a fresh load (opened another save)', () => {
  const prev: LoadMarker = { saveName: 'auto_100', maxElapsed: 500 };
  assert.equal(classifyGameLoad(prev, 'auto_200', 900), 'fresh-load');
});

test('same save name with rewound elapsed is a fresh load (reloaded the same save)', () => {
  const prev: LoadMarker = { saveName: 'auto_100', maxElapsed: 800 };
  assert.equal(classifyGameLoad(prev, 'auto_100', 500), 'fresh-load');
});

test('same save name with elapsed moving forward is a mod-reload replay', () => {
  const prev: LoadMarker = { saveName: 'auto_100', maxElapsed: 500 };
  assert.equal(classifyGameLoad(prev, 'auto_100', 800), 'replay');
});

test('same save name with equal elapsed is a replay (paused mod reload must not clear pops)', () => {
  const prev: LoadMarker = { saveName: 'auto_100', maxElapsed: 500 };
  assert.equal(classifyGameLoad(prev, 'auto_100', 500), 'replay');
});

test('unknown elapsed falls back to the save-name rule only', () => {
  const prev: LoadMarker = { saveName: 'auto_100', maxElapsed: 500 };
  assert.equal(classifyGameLoad(prev, 'auto_100', null), 'replay');
  assert.equal(classifyGameLoad(prev, 'auto_200', null), 'fresh-load');
});

test('null save names compare equal (replay while the game never named the save)', () => {
  const prev: LoadMarker = { saveName: null, maxElapsed: 500 };
  assert.equal(classifyGameLoad(prev, null, 600), 'replay');
});

test('markerForLoad captures the load point; unknown elapsed starts at 0', () => {
  assert.deepEqual(markerForLoad('auto_100', 500), { saveName: 'auto_100', maxElapsed: 500 });
  assert.deepEqual(markerForLoad(null, null), { saveName: null, maxElapsed: 0 });
});

test('observeElapsed only ever moves maxElapsed forward', () => {
  const m = markerForLoad('auto_100', 500);
  observeElapsed(m, 800);
  assert.equal(m.maxElapsed, 800);
  observeElapsed(m, 600); // stale/backwards reading must not lower the high-water mark
  assert.equal(m.maxElapsed, 800);
  observeElapsed(m, null); // unknown reading is a no-op
  assert.equal(m.maxElapsed, 800);
});
