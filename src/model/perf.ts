/**
 * Always-on performance indicators (spec §10): every heavy phase is timed and
 * logged as one `[InducedDemand][perf]` line; exceeding its budget warns so
 * regressions surface during normal play. `now` injectable for tests.
 */
export interface PerfEntry { ms: number; info?: string }

export interface PerfTracker {
  /** Time `fn`, log `phase → ms (info)`, warn if over `budgetMs`. Rethrows errors. */
  track<T>(phase: string, budgetMs: number, fn: () => T, info?: (result: T) => string): T;
  /** Most recent timing per phase (for the toolbar panel). */
  last: Record<string, PerfEntry>;
  /** Compact "phase 1.2ms · phase 0.4ms" line of the last runs. */
  summary(): string;
}

export function createPerfTracker(
  log: (msg: string) => void,
  warn: (msg: string) => void,
  now: () => number = () => performance.now(),
): PerfTracker {
  const last: Record<string, PerfEntry> = {};
  const finish = (phase: string, budgetMs: number, start: number, info?: string): void => {
    const ms = now() - start;
    last[phase] = info === undefined ? { ms } : { ms, info };
    const line = `[InducedDemand][perf] ${phase} ${ms.toFixed(1)}ms${info ? ` (${info})` : ''}`;
    log(line);
    if (ms > budgetMs) warn(`${line} — over budget ${budgetMs}ms`);
  };
  return {
    last,
    track<T>(phase: string, budgetMs: number, fn: () => T, info?: (result: T) => string): T {
      const start = now();
      let result: T;
      try {
        result = fn();
      } catch (e) {
        finish(phase, budgetMs, start);
        throw e;
      }
      finish(phase, budgetMs, start, info?.(result));
      return result;
    },
    summary(): string {
      return Object.entries(last).map(([k, v]) => `${k} ${v.ms.toFixed(1)}ms`).join(' · ');
    },
  };
}

/** Spec §10 budgets (ms). */
export const PERF_BUDGETS = {
  tier1: 100,
  tier2: 15,
  day: 50,
  water: 500,
} as const;
