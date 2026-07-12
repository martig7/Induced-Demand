import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerOverlay, updateOverlay, HISTORY_SOURCE_ID, HISTORY_LAYER_ID, setOverlayVisible, SOURCE_ID, LAYER_ID } from './overlay';
import type { ModdingAPI } from '../types/api';
import type { OverlayFeatureCollection } from './types';

function mockApi() {
  const calls = {
    sources: [] as Array<[string, unknown]>,
    layers: [] as unknown[],
    setData: [] as Array<[string, unknown]>,
    layout: [] as Array<[string, string, unknown]>,
  };
  const map = {
    getSource: (id: string) => ({ setData: (d: unknown) => calls.setData.push([id, d]) }),
    getLayer: (id: string) => ({ id }),
    setLayoutProperty: (id: string, k: string, v: unknown) => calls.layout.push([id, k, v]),
  };
  const api = {
    map: {
      registerSource: (id: string, cfg: unknown) => calls.sources.push([id, cfg]),
      registerLayer: (cfg: unknown) => calls.layers.push(cfg),
    },
    utils: { getMap: () => map },
  } as unknown as ModdingAPI;
  return { api, calls };
}

test('registerOverlay registers a geojson source and a hidden circle layer', () => {
  const { api, calls } = mockApi();
  registerOverlay(api);
  // Main overlay + the green/red history-day layer, both registered hidden.
  assert.deepEqual(calls.sources.map((s2) => s2[0]), [SOURCE_ID, HISTORY_SOURCE_ID]);
  for (const [, cfg] of calls.sources) assert.equal((cfg as { type: string }).type, 'geojson');
  type Layer = { id: string; type: string; source: string; layout: { visibility: string } };
  const layers = calls.layers as Layer[];
  assert.deepEqual(layers.map((l) => l.id), [LAYER_ID, HISTORY_LAYER_ID]);
  assert.deepEqual(layers.map((l) => l.source), [SOURCE_ID, HISTORY_SOURCE_ID]);
  for (const l of layers) {
    assert.equal(l.type, 'circle');
    assert.equal(l.layout.visibility, 'none');
  }
});

test('updateOverlay pushes data to the source', () => {
  const { api, calls } = mockApi();
  const fc: OverlayFeatureCollection = { type: 'FeatureCollection', features: [], maxValue: 0 };
  updateOverlay(api, fc);
  assert.deepEqual(calls.setData, [[SOURCE_ID, fc]]);
});

test('setOverlayVisible toggles the layer visibility', () => {
  const { api, calls } = mockApi();
  setOverlayVisible(api, true);
  setOverlayVisible(api, false);
  assert.deepEqual(calls.layout, [
    [LAYER_ID, 'visibility', 'visible'],
    [LAYER_ID, 'visibility', 'none'],
  ]);
});
