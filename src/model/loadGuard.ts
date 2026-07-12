/**
 * Distinguishes a REAL save load/open from a mod-reload replay of `onGameLoaded`.
 *
 * Why this exists (verified against the v1.4.10 bundle — see docs/MODDING_UI.md):
 * during `reloadMods()` the game re-fires `onGameLoaded` one or more times — at
 * registration (immediate-invoke), from `triggerPostReloadLifecycle()`, and in the
 * ModManager/hotkey paths a second time AFTER `modding-api-reload-complete`. The
 * loader awaits IPC between mod scripts, so no timer or event can bound the burst.
 * Applying queued pop removals during such a replay deletes pops the running sim
 * still references (in-flight movements) and breaks the game.
 *
 * So the decision is made from GAME STATE, not timing:
 *  - `lifecycleState.currentSaveName` (the hook's `saveName` argument) is written
 *    only by `triggerGameLoaded`, i.e. only on a real load — replays repeat the
 *    name of the last real load, and autosaves do not touch it;
 *  - elapsed game seconds never rewind within a loaded game, so a rewind proves a
 *    save was (re)loaded even when the name is unchanged.
 * Equal name + non-rewound elapsed ⇒ replay. The one false negative — reloading
 * the same save having never unpaused since it was loaded — skips the apply, which
 * is harmless: the queued clear stays queued for the next load.
 */
export interface LoadMarker {
  /** `saveName` from the last onGameLoaded processed as a real load. */
  saveName: string | null;
  /** High-water mark of elapsed game seconds observed since that load. */
  maxElapsed: number;
}

export type LoadKind = 'fresh-load' | 'replay';

export function classifyGameLoad(
  prev: LoadMarker | null | undefined,
  saveName: string | null,
  elapsed: number | null,
): LoadKind {
  if (!prev) return 'fresh-load';
  if (saveName !== prev.saveName) return 'fresh-load';
  if (elapsed !== null && elapsed < prev.maxElapsed) return 'fresh-load';
  return 'replay';
}

export function markerForLoad(saveName: string | null, elapsed: number | null): LoadMarker {
  return { saveName, maxElapsed: elapsed ?? 0 };
}

/** Advance the high-water mark; stale/unknown readings never lower it. */
export function observeElapsed(marker: LoadMarker, elapsed: number | null): void {
  if (elapsed !== null && elapsed > marker.maxElapsed) marker.maxElapsed = elapsed;
}
