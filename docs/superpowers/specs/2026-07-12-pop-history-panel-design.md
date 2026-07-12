# Pop history panel + green/red day overlay — design

**Date:** 2026-07-12
**Status:** approved

## Goal

A "History…" button in the mod's toolbar panel opens a floating panel listing the
last 14 game days of induced pop additions/removals. Clicking a day renders a map
overlay: green circles where pops were added, red where removed, sized by the
count at each location under the existing Res/Com/Both metric toggle.

## Data capture — `model/engine.ts`

`DayResult` gains `deltas: Record<pointId, DayDelta>` with
`DayDelta = { ar, aj, rr, rj }` (added-residence, added-job, removed-residence,
removed-job; only touched points present). An added pop bumps `ar` at its home
point and `aj` at its work point; a decayed pop bumps `rr`/`rj` at its two
endpoints (looked up before deferral).

## History buffer — new `model/history.ts`

- `DayHistoryEntry = { day, added, removed, deltas }`, `HISTORY_DAYS = 14`.
- `pushDayHistory(list, entry, cap)` returns a new array: replaces a same-day
  entry, drops entries with `day >= entry.day` when the clock rewound (save
  reload), appends, keeps the newest `cap` days. Zero-activity days are kept
  (predictable "last 14 days"), rendered dimmed.
- Stored on the window session object as `{ city, days }`; reset when the city
  changes. Survives mod reloads; NOT persisted across app restarts (non-goal).

## Overlay — new `overlay/historyCollection.ts` + second layer

- `buildHistoryOverlay(entry, points, metric)` → FeatureCollection. Per point:
  `added = ar | aj | ar+aj` and `removed = rr | rj | rr+rj` by metric. One green
  feature per point with adds, one red per point with removes; red emitted first
  so green renders on top. `t` normalized against the day's max count across
  both colors; `maxValue` for the legend. Points missing from the live map are
  skipped. Colors: `HISTORY_ADDED = '#2ecc71'`, `HISTORY_REMOVED = '#e74c3c'`.
- `overlay/overlay.ts` registers a second source+layer
  (`induced-demand-history-*`) with the same constant-ground-size radius math
  and `circle-color: ['get', 'color']`, plus update/visibility helpers.
- `OverlayState` gains `historyDay: number | null`. `refreshOverlay` precedence:
  a selected history day shows the history layer (regardless of the main
  overlay's On/Off) and hides the main layer; otherwise the history layer is
  hidden and current behavior applies.

## UI

**Amended 2026-07-12:** the game's `addFloatingPanel` is NOT a window-opener —
it registers a collapsed top-bar icon and offers no programmatic open (see
docs/MODDING_UI.md). The history list therefore renders INLINE in the existing
toolbar panel:

- `createPanel` takes a `HistorySection` component and a `historyOpen` store
  flag; the "▸ History" button toggles the flag and shows the selected day in
  its label.
- `ui/historyPanel.ts`: `createHistoryPanel(api, store, getHistory)` — rows
  newest-first (`Day 350 · +17 −39`), click toggles `historyDay`, selected row
  highlighted, zero days dimmed, one-line green/red legend.
- `onCityLoad` with a city change clears `historyDay` and the buffer.

## Testing

Unit tests: engine delta reporting; pushDayHistory (replace/rewind/cap/order);
buildHistoryOverlay (metric filtering, normalization, colors, ordering, missing
points); history panel render smoke tests per the existing panel-test pattern.
