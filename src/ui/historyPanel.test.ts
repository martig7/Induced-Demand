import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPanel, dayRowLabel } from './historyPanel';
import { createOverlayStore } from '../overlay/state';
import type { DayHistoryEntry } from '../model/history';
import type { ModdingAPI } from '../types/api';

function store() {
  return createOverlayStore({
    enabled: false, view: 'realized', metric: 'combined', revision: 0,
    deferredRemovalCount: 0, clearQueued: false, historyDay: null,
  });
}

const fakeReact = () => {
  let renders = 0;
  return {
    counts: () => renders,
    React: {
      createElement: (type: unknown) => {
        if (typeof type === 'function') { renders++; return (type as () => unknown)(); }
        return {};
      },
      // Dispatch stands in for a re-render (same pattern as panel.test.ts).
      useReducer: () => [0, () => { renders++; }] as const,
      useEffect: (fn: () => void | (() => void)) => { fn(); },
    },
  };
};

test('dayRowLabel formats a day summary', () => {
  assert.equal(dayRowLabel({ day: 350, added: 17, removed: 39 }), 'Day 350 · +17 −39');
  assert.equal(dayRowLabel({ day: 12, added: 0, removed: 0 }), 'Day 12 · +0 −0');
});

test('createHistoryPanel renders without throwing and subscribes to the store', () => {
  const s = store();
  const { React, counts } = fakeReact();
  const api = { utils: { React } } as unknown as ModdingAPI;
  const history: DayHistoryEntry[] = [
    { day: 349, added: 5, removed: 0, deltas: {} },
    { day: 350, added: 17, removed: 39, deltas: {} },
  ];
  const Panel = createHistoryPanel(api, s, () => history);
  assert.doesNotThrow(() => React.createElement(Panel));
  assert.equal(counts(), 1);
  s.set({ historyDay: 350 }); // selection change re-renders
  assert.equal(counts(), 2);
});

test('createHistoryPanel renders the empty state without history', () => {
  const s = store();
  const { React } = fakeReact();
  const api = { utils: { React } } as unknown as ModdingAPI;
  const Panel = createHistoryPanel(api, s, () => []);
  assert.doesNotThrow(() => React.createElement(Panel));
});
