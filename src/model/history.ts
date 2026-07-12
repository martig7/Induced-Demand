import type { DayDelta } from './engine';

/**
 * Rolling buffer of recent per-day induced pop changes, shown in the history
 * panel and rendered as the green/red day overlay. Session-scoped (lives on the
 * window session object, per city) — deliberately not persisted across restarts.
 */
export interface DayHistoryEntry {
  day: number;
  added: number;
  removed: number;
  /** Per-point endpoint deltas from runDay (only touched points present). */
  deltas: Record<string, DayDelta>;
}

export const HISTORY_DAYS = 14;

/**
 * Append a day, newest-last. A same-day entry is replaced (duplicate hook fire);
 * entries with `day >= entry.day` are dropped first so a rewound game clock
 * (save reload) discards stale "future" days. Keeps the newest `cap` entries.
 * Pure — never mutates the input list.
 */
export function pushDayHistory(
  list: readonly DayHistoryEntry[],
  entry: DayHistoryEntry,
  cap: number = HISTORY_DAYS,
): DayHistoryEntry[] {
  const kept = list.filter((e) => e.day < entry.day);
  kept.push(entry);
  return kept.slice(Math.max(0, kept.length - cap));
}
