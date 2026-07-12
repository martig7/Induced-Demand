# Subway Builder — Modding UI (reverse-engineering notes)

Findings from unpacking `resources/app.asar` (v1.4.10) and tracing toolbar
registration across **first load**, **save reload**, and **`reloadMods()`**.
Use this when adding toolbar buttons/panels from any mod.

Source bundle: `dist/renderer/public/index-*.js` (modding API). Object keys
(`addToolbarPanel`, `unregisterComponent`, hook names) are literal even when
the rest of the file is obfuscated.

## TL;DR — toolbar panels

- **`addToolbarPanel` always appends** to the internal `top-bar` list. It does
  **not** replace an existing entry with the same `id`.
- **`addFloatingPanel` and `ui.registerComponent` dedupe by `id`** (replace in
  place when the id already exists).
- **`reloadMods()` clears all mod UI** (`uiComponents.clear()`), re-runs every
  enabled mod script, then calls **`triggerPostReloadLifecycle()`**, which
  re-fires **`onMapReady`** and **`onGameLoaded`** if a save is already loaded.
- **Save reload (`loadSave`)** only calls **`triggerGameLoaded(saveName)`**.
  It does **not** clear `uiComponents` and does **not** call `onMapReady`.
- **Recommended pattern:** unregister, then register — idempotent across any
  hook burst:

```ts
const PANEL_ID = 'my-mod-panel';
const TOP_BAR = 'top-bar';

function ensureToolbarPanel(): void {
  api.ui.unregisterComponent(TOP_BAR, PANEL_ID);
  api.ui.addToolbarPanel({
    id: PANEL_ID,
    icon: 'TrendingUp',
    tooltip: 'My Mod',
    title: 'My Mod',
    width: 260,
    render: () => persistentUi.renderPanel?.(), // delegate to latest closure
  });
}

api.hooks.onMapReady(() => {
  ensureToolbarPanel();
});

api.hooks.onGameLoaded(() => {
  ensureToolbarPanel();
});
```

- **Do not** call `addToolbarPanel` synchronously at the bottom of the mod
  script during hot-reload. The game's post-reload lifecycle will fire hooks
  again; proactive registration stacks duplicates.
- **Stale hook callbacks:** the mod loader may execute the script more than
  once per reload wave. Guard hook bodies with a monotonic generation counter
  on `window` so only the latest script instance runs (see Induced Demand
  `main.ts`).

## Lifecycle matrix

| Event | `uiComponents` | Hooks fired | What mods should do |
|-------|----------------|-------------|---------------------|
| First load into save | unchanged until mods register | `onMapReady`, later `onGameLoaded` | Register on `onMapReady`; `onGameLoaded` is optional backup |
| Save load, **different** `city\|mode` | **not cleared** | `onMapReady` (map remounts) + **`onGameLoaded`** | `ensureToolbarPanel()` in `onGameLoaded` |
| Save load, **same** `city\|mode` (menu ▸ Continue / Load Game mid-session) | **not cleared** | **`onMapReady` only — the save is NOT applied** (see below) | Don't expect `onGameLoaded`; the old sim state is still live |
| `reloadMods()` | **cleared** | scripts re-run, then **`onMapReady` + `onGameLoaded`** (if save loaded) | Register in hooks only; unregister-before-add |
| Return to main menu / game end | **cleared** | lifecycle reset | Re-register on next `onMapReady` |

## Same-city loads from the menu do NOT reload the save (v1.4.10)

Verified from the bundle and live logs (2026-07-11): the game screen's
`StoreInitializer` fetches the pending save through `runInitOnce(key, ...)`
where `key = "${cityCode}|${gameMode}"` and the cached init promise lives for
the whole page session. `resetInitializationCache()` is only called from a few
unrelated places (tutorial start, city-data deletion) — **not** from
Resume/Continue or the load flow.

Consequence: main menu ▸ **Continue** (and any load that lands on the same
`city|mode`) runs `load-and-set-pending-save` in the main process (log shows
`PENDING SAVE: LOAD_AND_SET(_SUCCESS)`), remounts the map (`onMapReady`
re-fires, mods re-init) — but the frontend **never issues `PENDING SAVE: GET`**,
`demandData` is never replaced, `triggerGameLoaded` never runs, and the running
sim (including in-flight pop movements) simply continues. From a mod's
perspective nothing was loaded — and it is NOT safe to treat it as a load.

A save is only truly (re)loaded when the `city|mode` key changes or the page
is freshly booted (app restart). Log signature of a real load:
`PENDING SAVE: SET/LOAD_AND_SET` → `PENDING SAVE: GET` ("Frontend requesting
pending save") → `PENDING SAVE: REMOVE`, with `onGameLoaded` in between.

## `reloadMods()` sequence (verified)

1. `SubwayBuilderAPI.reloadMods()` clears hook callback arrays and
   `uiComponents`, then dispatches `modding-api-reload-request`. Its returned
   promise resolves when `modding-api-reload-complete` fires.
2. ModLoader (`handleReloadRequest`) awaits `reloadAllMods()`, which loops over
   enabled mods and **awaits an IPC round-trip per mod**
   (`await window.electron.getModScript(id)`) before `executeModScript`.
   There are real macrotask gaps between script executions and step 3.
3. ModLoader calls `triggerPostReloadLifecycle()`:
   - If `lifecycleState.mapReady`: re-runs all **`onMapReady`** callbacks.
   - If `lifecycleState.currentSaveName !== null`: re-runs all
     **`onGameLoaded`** callbacks (passing `currentSaveName`).
4. Dispatches `modding-api-reload-complete`.

Registering a toolbar panel both at script end **and** inside `onMapReady`
after this sequence produces **two icons** (the user's `1, 2, 0, 2` bug).

## Scripts run TWICE per reload wave; replays can follow `reload-complete`

Both user-facing reload triggers run the sequence above and then run
`reloadAllMods()` **again** themselves:

- **ModManager "Reload all mods" button** (`handleReloadMods`):
  `await api.reloadMods()` (→ steps 1–4 above) then `await reloadAllMods()` —
  a second script execution **after** `modding-api-reload-complete`, with no
  lifecycle trigger of its own (but `hooks.onGameLoaded` registration still
  immediate-invokes the callback while a save is loaded).
- **Hot-reload shortcut (Ctrl/Cmd+Shift+R)** (`handleKeyDown`):
  `await api.reloadMods()` then `await reloadAllMods()` then
  `triggerPostReloadLifecycle()` — a full **`onGameLoaded` replay after
  `modding-api-reload-complete`**.

Consequences for mods:

- **Never use timers** (e.g. `setTimeout(..., 0)`) to bound the reload burst:
  the IPC awaits in step 2 let a 0 ms timer fire *before* step 3's replays.
- **Never treat `modding-api-reload-complete` as "replays are over"**: the
  button/hotkey paths execute scripts and replay hooks after it.
- To tell a **real save load** apart from a replayed `onGameLoaded`, use game
  state, not timing: `lifecycleState.currentSaveName` (the hook's `saveName`
  argument) is written only by `triggerGameLoaded` — i.e. only by real loads;
  replays repeat the last real load's name, and autosaves don't change it.
  `getElapsedSeconds()` never rewinds within a loaded game, so same name +
  rewound clock = the same save was reloaded. See Induced Demand
  `src/model/loadGuard.ts`.

## `onGameLoaded` immediate callback

When you call `hooks.onGameLoaded(fn)` while a save is already loaded,
the API **invokes `fn` immediately** (see `lifecycleState.currentSaveName`
check in the modding bundle). That is expected — `unregisterComponent` +
`addToolbarPanel` must be safe to call multiple times per reload wave.

## Related API surface (typed in `src/types/api.d.ts`)

| Method | Dedupe by `id`? | Placement |
|--------|-----------------|-----------|
| `ui.registerComponent(placement, config)` | Yes (replace) | Any `UIPlacement` |
| `ui.unregisterComponent(placement, id)` | — | Removes one entry |
| `ui.getComponents(placement)` | — | Inspect before register |
| `ui.addToolbarPanel(config)` | **No** (always push) | Always `top-bar` |
| `ui.addFloatingPanel(config)` | Yes (replace) | Always `top-bar` |

### `addFloatingPanel` is NOT a window-opener (verified 2026-07-12)

It registers a **top-bar icon button** whose floating window starts **closed**
(`useState(false)`); the window only opens when the user clicks that icon.
There is no API to open it programmatically. Also: `config.icon` is looked up
in the game's icon map — an unknown name reaches `React.createElement(undefined)`
and breaks the component's render. Consequence: "click a button in my panel →
open a panel" flows cannot be built on `addFloatingPanel`; render expandable
content inline in your own toolbar panel instead (see Induced Demand's history
section).
| `ui.addToolbarButton(config)` | **No** (always push) | Always `top-bar` |

## Re-deriving this later

Game install (Windows): `%LOCALAPPDATA%\Programs\Subway Builder\game\resources\app.asar`

```bash
node scripts/asar.js extract "<path-to-app.asar>" "dist/renderer/public/index-" out
```

Search the extracted bundle for: `addToolbarPanel`, `triggerPostReloadLifecycle`,
`triggerGameLoaded`, `uiComponents`, `reloadMods`, `modding-api-reload-request`.

Log file often includes the asar path, e.g.
`D:\SubwayBuilder\logs\metro-maker-current.log`.
