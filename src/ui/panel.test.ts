import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitsLabel, createPanel } from './panel';
import { createOverlayStore } from '../overlay/state';
import type { ModdingAPI } from '../types/api';

test('unitsLabel describes the active view', () => {
  assert.equal(unitsLabel('realized'), 'people (induced)');
  assert.equal(unitsLabel('targeting'), 'attractiveness score');
});

test('createPanel renders the inline history section when historyOpen is set', () => {
  // addFloatingPanel is NOT a window-opener (it adds a collapsed top-bar icon —
  // see docs/MODDING_UI.md), so the history list renders inline in our panel.
  const store = createOverlayStore({
    enabled: false, view: 'realized', metric: 'combined', revision: 0,
    deferredRemovalCount: 0, clearQueued: false, historyDay: null, historyOpen: true,
  });
  let sectionRendered = 0;
  const React = {
    createElement: (type: unknown) => (typeof type === 'function' ? (type as () => unknown)() : {}),
    useReducer: (r: (x: number) => number, i: number) => [i, () => r(i + 1)] as const,
    useEffect: (fn: () => void | (() => void)) => { fn(); },
  };
  const api = { utils: { React } } as unknown as ModdingAPI;
  const HistorySection = (): unknown => { sectionRendered++; return {}; };
  const Panel = createPanel(api, store, () => 0, () => {}, HistorySection);
  React.createElement(Panel);
  assert.equal(sectionRendered, 1);

  sectionRendered = 0;
  store.set({ historyOpen: false });
  React.createElement(Panel);
  assert.equal(sectionRendered, 0); // collapsed → section not rendered
});

test('createPanel returns a component function (does not throw to construct)', () => {
  const store = createOverlayStore({
    enabled: false, view: 'realized', metric: 'combined', revision: 0,
    deferredRemovalCount: 3, clearQueued: false,
  });
  const React = {
    createElement: (type: unknown) => (typeof type === 'function' ? (type as () => unknown)() : {}),
    useReducer: (r: (x: number) => number, i: number) => [i, () => r(i + 1)] as const,
    useEffect: (fn: () => void | (() => void)) => { fn(); },
  };
  const api = { utils: { React } } as unknown as ModdingAPI;
  let resetCalls = 0;
  const Panel = createPanel(api, store, () => 0, () => { resetCalls++; });
  assert.equal(typeof Panel, 'function');
  assert.doesNotThrow(() => React.createElement(Panel));
  assert.equal(resetCalls, 0); // onReset is wired but not fired by rendering
});

test('createPanel subscribes to overlay store updates', () => {
  const store = createOverlayStore({
    enabled: false, view: 'realized', metric: 'combined', revision: 0,
    deferredRemovalCount: 0, clearQueued: false,
  });
  let renderCount = 0;
  const React = {
    createElement: (type: unknown) => {
      if (typeof type === 'function') {
        renderCount++;
        return (type as () => unknown)();
      }
      return {};
    },
    useReducer: () => [0, () => { renderCount++; }] as const,
    useEffect: (fn: () => void | (() => void)) => { fn(); },
  };
  const api = { utils: { React } } as unknown as ModdingAPI;
  const Panel = createPanel(api, store, () => 0);
  React.createElement(Panel);
  assert.equal(renderCount, 1);
  store.set({ deferredRemovalCount: 2, revision: 1 });
  assert.equal(renderCount, 2);
});
