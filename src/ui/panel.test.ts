import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitsLabel, createPanel } from './panel';
import { createOverlayStore } from '../overlay/state';
import type { ModdingAPI } from '../types/api';

test('unitsLabel describes the active view', () => {
  assert.equal(unitsLabel('realized'), 'people (induced)');
  assert.equal(unitsLabel('targeting'), 'attractiveness score');
});

test('createPanel returns a component function (does not throw to construct)', () => {
  const store = createOverlayStore({ enabled: false, view: 'realized', metric: 'combined' });
  const api = { utils: { React: { createElement: () => ({}), useReducer: () => [0, () => {}], useEffect: () => {} } } } as unknown as ModdingAPI;
  let resetCalls = 0;
  const Panel = createPanel(api, store, () => 0, () => { resetCalls++; });
  assert.equal(typeof Panel, 'function');
  assert.doesNotThrow(() => Panel()); // exercise the render body (legend + reset button)
  assert.equal(resetCalls, 0); // onReset is wired but not fired by rendering
});
