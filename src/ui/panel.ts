import type { ModdingAPI } from '../types/api';
import type { OverlayStore } from '../overlay/state';
import type { OverlayView, OverlayMetric } from '../overlay/types';
import { RAMP_LOW, RAMP_MID, RAMP_HIGH } from '../overlay/overlay';

export function unitsLabel(view: OverlayView): string {
  return view === 'realized' ? 'people (induced)' : 'attractiveness score';
}

/**
 * Build the toolbar-panel render function. Uses `api.utils.React.createElement`
 * (no JSX). The returned component re-renders when the store changes.
 * `getMax()` returns the most recent FeatureCollection's maxValue for the legend.
 */
export function createPanel(
  api: ModdingAPI,
  store: OverlayStore,
  getMax: () => number,
  onReset: () => void = () => {},
  // Rendered inline below the History button when `historyOpen` (the game's
  // addFloatingPanel only adds a collapsed top-bar icon — see docs/MODDING_UI.md).
  HistorySection: (() => unknown) | null = null,
  getPerf: () => string = () => '',
): () => unknown {
  const React = api.utils.React as unknown as {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
    useReducer: (r: (x: number) => number, i: number) => [number, () => void];
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => void;
  };
  const h = React.createElement;
  let confirming = false; // two-click guard for the destructive reset button

  const seg = (label: string, active: boolean, onClick: () => void): unknown =>
    h('button', {
      onClick,
      style: {
        padding: '2px 8px', marginRight: '4px', borderRadius: '4px', cursor: 'pointer',
        border: '1px solid #8c96c6',
        background: active ? RAMP_MID : 'transparent',
        color: active ? '#fff' : 'inherit',
        fontSize: '12px',
      },
    }, label);

  return function Panel(): unknown {
    const [, force] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => store.subscribe(force), []);
    const s = store.get();
    const setView = (view: OverlayView) => store.set({ view });
    const setMetric = (metric: OverlayMetric) => store.set({ metric });

    const row = (label: string, children: unknown[]): unknown =>
      h('div', { style: { display: 'flex', alignItems: 'center', margin: '6px 0' } },
        h('span', { style: { width: '54px', fontSize: '12px', opacity: 0.8 } }, label),
        h('div', null, ...children));

    const legend = h('div', { style: { marginTop: '8px' } },
      h('div', {
        style: {
          height: '10px', borderRadius: '4px',
          background: `linear-gradient(to right, ${RAMP_LOW}, ${RAMP_MID}, ${RAMP_HIGH})`,
        },
      }),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', opacity: 0.8 } },
        h('span', null, '0'),
        h('span', null, String(Math.round(getMax())))),
      h('div', { style: { fontSize: '11px', opacity: 0.7, marginTop: '2px' } }, unitsLabel(s.view)));

    const clearQueued = s.clearQueued;
    const RESET_RED = '#c0392b';
    const resetBtn = h('button', {
      onClick: () => {
        if (clearQueued) return; // already queued; reload to apply
        if (!confirming) {
          confirming = true; force();
          setTimeout(() => { confirming = false; force(); }, 3000);
        } else {
          confirming = false; onReset(); force();
        }
      },
      style: {
        marginTop: '10px', width: '100%', padding: '4px 8px', borderRadius: '4px',
        cursor: clearQueued ? 'default' : 'pointer',
        border: '1px solid ' + RESET_RED, background: confirming ? RESET_RED : 'transparent',
        color: confirming ? '#fff' : 'inherit', fontSize: '12px',
      },
    }, clearQueued ? '↻ Clear queued — applies on next full load' : confirming ? 'Click again to confirm' : 'Clear induced demand');

    const historyActive = s.historyDay != null;
    const historyOpen = !!s.historyOpen;
    const historyBtn = h('button', {
      onClick: () => store.set({ historyOpen: !historyOpen }),
      style: {
        marginTop: '10px', width: '100%', padding: '4px 8px', borderRadius: '4px',
        cursor: 'pointer', border: '1px solid #8c96c6',
        background: historyActive ? RAMP_MID : 'transparent',
        color: historyActive ? '#fff' : 'inherit', fontSize: '12px',
      },
    }, `${historyOpen ? '▾' : '▸'} History`);

    const historySection = historyOpen && HistorySection
      ? h('div', { style: { marginTop: '6px' } }, h(HistorySection))
      : null;

    return h('div', { style: { padding: '8px', minWidth: '220px' } },
      row('Show', [seg('On', s.enabled, () => store.set({ enabled: true })), seg('Off', !s.enabled, () => store.set({ enabled: false }))]),
      row('View', [seg('Realized', s.view === 'realized', () => setView('realized')), seg('Targeting', s.view === 'targeting', () => setView('targeting'))]),
      row('Metric', [
        seg('Res', s.metric === 'residential', () => setMetric('residential')),
        seg('Com', s.metric === 'commercial', () => setMetric('commercial')),
        seg('Both', s.metric === 'combined', () => setMetric('combined')),
      ]),
      row('Field', [
        seg('Off', (s.heatView ?? 'off') === 'off', () => store.set({ heatView: 'off' })),
        seg('Res', s.heatView === 'accessRes', () => store.set({ heatView: 'accessRes' })),
        seg('Com', s.heatView === 'accessCom', () => store.set({ heatView: 'accessCom' })),
        seg('Pres', s.heatView === 'pressure', () => store.set({ heatView: 'pressure' })),
      ]),
      legend,
      historyBtn,
      ...(historySection ? [historySection] : []),
      h('div', { style: { fontSize: '10px', opacity: 0.6, marginTop: '6px' } }, getPerf() || ' '),
      resetBtn);
  };
}
