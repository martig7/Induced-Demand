import type { DemandData } from '../types/game-state';
import { INDUCED_PREFIX } from './popFactory';

export interface PointLedger {
  baselineResidents: number;
  baselineJobs: number;
  resAccum: number;
  jobAccum: number;
}

export interface LedgerState {
  points: Record<string, PointLedger>;
  /** Monotonic counter for induced pop ids. */
  seq: number;
}

/** Minimal slice of `api.storage` we depend on (keeps ledger testable). */
export interface ModStorage {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function newLedger(): LedgerState {
  return { points: {}, seq: 0 };
}

/** Record baselines for points not yet in the ledger. Never overwrites. */
export function captureBaselines(dd: DemandData, ledger: LedgerState): void {
  for (const p of dd.points.values()) {
    if (!ledger.points[p.id]) {
      ledger.points[p.id] = {
        baselineResidents: p.residents,
        baselineJobs: p.jobs,
        resAccum: 0,
        jobAccum: 0,
      };
    }
  }
}

/**
 * Self-heal: when a save already contains induced pops but the ledger is
 * missing (e.g. storage cleared), recover baseline = current − induced.
 */
export function reconcileBaselines(dd: DemandData, ledger: LedgerState): void {
  const indRes: Record<string, number> = {};
  const indJob: Record<string, number> = {};
  for (const pop of dd.popsMap.values()) {
    if (!pop.id.startsWith(INDUCED_PREFIX)) continue;
    indRes[pop.residenceId] = (indRes[pop.residenceId] ?? 0) + pop.size;
    indJob[pop.jobId] = (indJob[pop.jobId] ?? 0) + pop.size;
  }
  for (const p of dd.points.values()) {
    if (!ledger.points[p.id]) {
      ledger.points[p.id] = {
        baselineResidents: p.residents - (indRes[p.id] ?? 0),
        baselineJobs: p.jobs - (indJob[p.id] ?? 0),
        resAccum: 0,
        jobAccum: 0,
      };
    }
  }
}

export function serialize(ledger: LedgerState): string {
  return JSON.stringify(ledger);
}

export function deserialize(s: string | null | undefined): LedgerState {
  if (!s) return newLedger();
  try {
    const o = JSON.parse(s);
    return { points: o.points ?? {}, seq: typeof o.seq === 'number' ? o.seq : 0 };
  } catch {
    return newLedger();
  }
}

export async function loadLedger(storage: ModStorage, key: string): Promise<LedgerState> {
  const raw = await storage.get<string>(key, '');
  return deserialize(raw);
}

export async function saveLedger(storage: ModStorage, key: string, ledger: LedgerState): Promise<void> {
  await storage.set(key, serialize(ledger));
}
