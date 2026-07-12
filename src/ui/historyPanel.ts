import type { ModdingAPI } from '../types/api';
import type { OverlayStore } from '../overlay/state';
import type { DayHistoryEntry } from '../model/history';
import { HISTORY_DAYS } from '../model/history';
import { HISTORY_ADDED, HISTORY_REMOVED } from '../overlay/historyCollection';

export function dayRowLabel(e: Pick<DayHistoryEntry, 'day' | 'added' | 'removed'>): string {
  return `Day ${e.day} · +${e.added} −${e.removed}`;
}

/**
 * Floating "history" panel: the last HISTORY_DAYS game days of pop additions and
 * removals, newest first. Clicking a row toggles `historyDay`, which switches the
 * map to the green/red day overlay (metric follows the main panel's toggle).
 * Built with `api.utils.React.createElement` (no JSX), same pattern as panel.ts.
 */
export function createHistoryPanel(
  api: ModdingAPI,
  store: OverlayStore,
  getHistory: () => readonly DayHistoryEntry[],
): () => unknown {
  const React = api.utils.React as unknown as {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
    useReducer: (r: (x: number) => number, i: number) => [number, () => void];
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => void;
  };
  const h = React.createElement;

  return function HistoryPanel(): unknown {
    const [, force] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => store.subscribe(force), []);
    const s = store.get();
    const days = [...getHistory()].reverse(); // newest first

    const legend = h('div', { style: { fontSize: '11px', opacity: 0.8, marginBottom: '6px' } },
      h('span', { style: { color: HISTORY_ADDED } }, '● added'),
      h('span', { style: { color: HISTORY_REMOVED, marginLeft: '10px' } }, '● removed'));

    const rows = days.map((e) => {
      const selected = s.historyDay === e.day;
      const idle = e.added === 0 && e.removed === 0;
      return h('div', {
        key: e.day,
        onClick: () => store.set({ historyDay: selected ? null : e.day }),
        style: {
          padding: '3px 6px', marginBottom: '2px', borderRadius: '4px', cursor: 'pointer',
          fontSize: '12px', lineHeight: 1.4,
          border: '1px solid ' + (selected ? HISTORY_ADDED : 'transparent'),
          background: selected ? 'rgba(46, 204, 113, 0.15)' : 'transparent',
          opacity: idle && !selected ? 0.45 : 1,
        },
      },
      h('span', null, dayRowLabel(e)));
    });

    const empty = h('div', { style: { fontSize: '12px', opacity: 0.7 } },
      `No induced-demand activity recorded yet this session (last ${HISTORY_DAYS} days are kept).`);

    return h('div', { style: { padding: '8px', minWidth: '240px' } },
      legend,
      ...(rows.length > 0 ? rows : [empty]));
  };
}
