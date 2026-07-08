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
| Save reload | **not cleared** | **`onGameLoaded` only** | `ensureToolbarPanel()` in `onGameLoaded` (map may not remount) |
| `reloadMods()` | **cleared** | scripts re-run, then **`onMapReady` + `onGameLoaded`** (if save loaded) | Register in hooks only; unregister-before-add |
| Return to main menu / game end | **cleared** | lifecycle reset | Re-register on next `onMapReady` |

## `reloadMods()` sequence (verified)

1. `SubwayBuilderAPI.reloadMods()` clears hook callback arrays and
   `uiComponents`, then dispatches `modding-api-reload-request`.
2. ModLoader re-executes each enabled mod script (`executeModScript`).
3. ModLoader calls `triggerPostReloadLifecycle()`:
   - If `lifecycleState.mapReady`: re-runs all **`onMapReady`** callbacks.
   - If `lifecycleState.currentSaveName !== null`: re-runs all
     **`onGameLoaded`** callbacks.
4. Dispatches `modding-api-reload-complete`.

Registering a toolbar panel both at script end **and** inside `onMapReady`
after this sequence produces **two icons** (the user's `1, 2, 0, 2` bug).

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
