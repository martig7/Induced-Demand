import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerOverlay, updateOverlay, setOverlayVisible, SOURCE_ID, LAYER_ID } from './overlay';
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
  assert.equal(calls.sources.length, 1);
  assert.equal(calls.sources[0][0], SOURCE_ID);
  assert.equal((calls.sources[0][1] as { type: string }).type, 'geojson');
  assert.equal(calls.layers.length, 1);
  const layer = calls.layers[0] as { id: string; type: string; source: string; layout: { visibility: string } };
  assert.equal(layer.id, LAYER_ID);
  assert.equal(layer.type, 'circle');
  assert.equal(layer.source, SOURCE_ID);
  assert.equal(layer.layout.visibility, 'none');
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
