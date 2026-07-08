import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitsLabel, createPanel, deferredRemovalLabel } from './panel';
import { createOverlayStore } from '../overlay/state';
import type { ModdingAPI } from '../types/api';

test('unitsLabel describes the active view', () => {
  assert.equal(unitsLabel('realized'), 'people (induced)');
  assert.equal(unitsLabel('targeting'), 'attractiveness score');
});

test('deferredRemovalLabel formats the deferred count', () => {
  assert.equal(deferredRemovalLabel(0), null);
  assert.equal(deferredRemovalLabel(1), '1 pop deferred for removal on save reload');
  assert.equal(deferredRemovalLabel(3), '3 pops deferred for removal on save reload');
});

test('createPanel returns a component function (does not throw to construct)', () => {
  const store = createOverlayStore({
    enabled: false, view: 'realized', metric: 'combined', revision: 0,
    deferredRemovalCount: 3, clearQueued: false,
  });
  const api = { utils: { React: { createElement: () => ({}), useReducer: () => [0, () => {}], useEffect: () => {} } } } as unknown as ModdingAPI;
  let resetCalls = 0;
  const Panel = createPanel(api, store, () => 0, () => { resetCalls++; });
  assert.equal(typeof Panel, 'function');
  assert.doesNotThrow(() => Panel()); // exercise the render body (legend + reset button)
  assert.equal(resetCalls, 0); // onReset is wired but not fired by rendering
});
