import type { DemandData } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import {
  INDUCED_PREFIX, isInduced, addInducedPop, detachInducedPop, ensureTombstoneStub,
} from './popFactory';
import { DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';

export interface PointLedger {
  baselineResidents: number;
  baselineJobs: number;
  resAccum: number;
  jobAccum: number;
}

/** The residence/job endpoints of one induced pop — enough to rebuild it. */
export interface InducedPopRecord {
  residenceId: string;
  jobId: string;
}

export interface LedgerState {
  points: Record<string, PointLedger>;
  /**
   * Authoritative roster of the induced pops this mod created, keyed by pop id.
   * The game save is NOT trusted to preserve them: if a reload (or the sim's
   * per-cycle re-derivation) drops an induced pop, `reconcileInducedPops` re-adds
   * every roster entry the live demand data is missing.
   */
  pops: Record<string, InducedPopRecord>;
  /** Monotonic counter for induced pop ids. */
  seq: number;
  /**
   * Induced pop ids queued for removal. Decay schedules removals here instead of
   * deleting from live demand data mid-simulation — the game keeps in-flight train
   * movements that reference pops by id, and deleting one throws every tick.
   * Retired safely at the next real load via `retirePendingRemovals` (demand-neutral
   * tombstone stubs — the entries are never deleted from popsMap).
   */
  pendingRemovals?: string[];
  /**
   * Transient: growth accumulators loaded from the store, keyed by point id as `[res, job]`.
   * Applied by `applyPendingAccum` AFTER baselines are re-derived (baselines aren't persisted),
   * then deleted. Never set on a live ledger — only present between load and reconcile.
   */
  pendingAccum?: Record<string, [number, number]>;
  /**
   * Retired induced pops. Their demand is gone, but a demand-neutral stub must stay
   * in `popsMap` (re-created each load) because saves keep `popMovementsMap` while
   * stripping induced pops — a movement whose pop id is missing throws a GameLoop
   * tick error every tick. FIFO-capped at TOMBSTONE_CAP (insertion order).
   */
  tombstones?: Record<string, InducedPopRecord>;
}

/** Movements only survive a few save cycles; a bounded FIFO of retired ids suffices. */
export const TOMBSTONE_CAP = 500;

function capTombstones(t: Record<string, InducedPopRecord>): Record<string, InducedPopRecord> {
  const keys = Object.keys(t);
  if (keys.length <= TOMBSTONE_CAP) return t;
  const kept: Record<string, InducedPopRecord> = {};
  for (const k of keys.slice(keys.length - TOMBSTONE_CAP)) kept[k] = t[k];
  return kept;
}

export function isTombstoned(ledger: LedgerState, id: string): boolean {
  return !!ledger.tombstones && id in ledger.tombstones;
}

export function recordTombstone(ledger: LedgerState, id: string, rec: InducedPopRecord): void {
  if (!ledger.tombstones) ledger.tombstones = {};
  delete ledger.tombstones[id]; // refresh insertion order (recency)
  ledger.tombstones[id] = rec;
  ledger.tombstones = capTombstones(ledger.tombstones);
}

/**
 * Minimal synchronous key/value store (the `localStorage` shape). We persist through
 * `localStorage`, NOT `api.storage`: the game's mod-storage keeps an in-memory map that it
 * does NOT rehydrate from disk on a cold launch, so `api.storage.get` returns nothing after a
 * full restart (it only survived warm, in-session reloads). `localStorage` is hydrated by
 * Electron on cold start, so the roster actually round-trips (this is what Improved Schematics
 * uses). Injectable so the persistence is unit-testable.
 */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function newLedger(): LedgerState {
  return { points: {}, pops: {}, seq: 0 };
}

/**
 * True only for a fully-empty ledger (no baselines, no roster, no growth). A real
 * saved ledger always has baseline points (capture runs before any save), so this
 * distinguishes a genuine load from a `storage`-returned-nothing load during the
 * game's load-window storage bug — such a load must not be trusted or persisted.
 */
export function isPristineLedger(l: LedgerState): boolean {
  return l.seq === 0
    && Object.keys(l.pops).length === 0
    && Object.keys(l.points).length === 0;
}

/**
 * Reconcile the induced-pop roster against live demand data (run once per load):
 *  - adopt any induced pop present in `dd` but not yet tracked (self-heal when the
 *    ledger was blank/lost but the save kept the pops);
 *  - restore any tracked pop the save dropped by re-adding it to `dd`.
 * A roster entry whose endpoints no longer exist is stale and gets pruned.
 * Returns the number of pops re-added to `dd`.
 */
export function queueInducedPopRemoval(ledger: LedgerState, id: string): void {
  if (!isInduced(id)) return;
  if (!ledger.pendingRemovals) ledger.pendingRemovals = [];
  if (!ledger.pendingRemovals.includes(id)) ledger.pendingRemovals.push(id);
}

export function isPendingRemoval(ledger: LedgerState, id: string): boolean {
  return ledger.pendingRemovals?.includes(id) ?? false;
}

/** Union deferred-removal queues from two ledger snapshots (session vs localStorage). */
export function mergePendingRemovals(primary: LedgerState, secondary: LedgerState): LedgerState {
  const a = primary.pendingRemovals ?? [];
  const b = secondary.pendingRemovals ?? [];
  if (b.length === 0) return primary;
  const merged = [...a];
  for (const id of b) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged.length === a.length ? primary : { ...primary, pendingRemovals: merged };
}

export function reconcileInducedPops(
  dd: DemandData,
  ledger: LedgerState,
  cfg: InducedDemandConfig,
  slots: SlotSet = DEFAULT_SLOT_SET,
): number {
  for (const pop of dd.popsMap.values()) {
    // Adopt only LIVE pops (size > 0): a size-0 entry is an inert retired stub —
    // adopting one (e.g. after storage loss wiped the tombstone registry) would
    // resurrect it at full size on a later restore.
    if (isInduced(pop.id) && pop.size > 0 && !ledger.pops[pop.id]
      && !isPendingRemoval(ledger, pop.id) && !isTombstoned(ledger, pop.id)) {
      ledger.pops[pop.id] = { residenceId: pop.residenceId, jobId: pop.jobId };
    }
  }
  let restored = 0;
  for (const [id, rec] of Object.entries(ledger.pops)) {
    if (dd.popsMap.has(id)) continue;
    if (isPendingRemoval(ledger, id)) {
      // Decayed pop the save stripped: its demand is already gone — re-adding it via
      // addInducedPop would leak +POP_SIZE. Stub it so saved movements still resolve;
      // retirePendingRemovals turns it into a tombstone.
      ensureTombstoneStub(dd, id, rec, cfg);
      continue;
    }
    if (addInducedPop(dd, rec.residenceId, rec.jobId, id, cfg, slots)) restored++;
    else delete ledger.pops[id]; // endpoints gone — drop the stale roster entry
  }
  return restored;
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
    // Tombstone/pending stubs contribute NO demand — counting them here would
    // underestimate baselines by POP_SIZE per stub.
    if (isTombstoned(ledger, pop.id) || isPendingRemoval(ledger, pop.id)) continue;
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

/**
 * Compact persisted form: `seq`, the induced-pop roster, and the SPARSE growth accumulators
 * (only points with nonzero pressure). Baselines are deliberately dropped — every point has one,
 * so they'd bloat the payload; they re-derive from live demand on load (`reconcileBaselines`),
 * while the accumulators (few points) are carried so growth pressure survives a reload.
 * localStorage is shared + quota-limited, hence the sparseness.
 */
export function serializeForStore(ledger: LedgerState): string {
  const accum: Record<string, [number, number]> = {};
  for (const [id, e] of Object.entries(ledger.points)) {
    if (e.resAccum !== 0 || e.jobAccum !== 0) accum[id] = [e.resAccum, e.jobAccum];
  }
  const payload: Record<string, unknown> = { seq: ledger.seq, pops: ledger.pops, accum };
  if (ledger.pendingRemovals?.length) payload.pendingRemovals = ledger.pendingRemovals;
  if (ledger.tombstones && Object.keys(ledger.tombstones).length > 0) {
    payload.tombstones = capTombstones(ledger.tombstones);
  }
  return JSON.stringify(payload);
}

export function deserializeFromStore(s: string | null | undefined): LedgerState {
  if (!s) return newLedger();
  try {
    const o = JSON.parse(s);
    const led: LedgerState = {
      points: {}, // baselines re-derived from live demand each load
      pops: o.pops ?? {},
      seq: typeof o.seq === 'number' ? o.seq : 0,
    };
    if (Array.isArray(o.pendingRemovals)) led.pendingRemovals = o.pendingRemovals;
    if (o.accum && typeof o.accum === 'object') led.pendingAccum = o.accum;
    if (o.tombstones && typeof o.tombstones === 'object') {
      led.tombstones = capTombstones(o.tombstones);
    }
    return led;
  } catch {
    return newLedger();
  }
}

/**
 * Apply accumulators loaded from the store onto their points, then clear the pending record.
 * Must run AFTER baselines are derived (`reconcileBaselines`) so it only sets pressure on points
 * that already have baselines; points that no longer exist are skipped.
 */
export function applyPendingAccum(ledger: LedgerState): void {
  const acc = ledger.pendingAccum;
  if (!acc) return;
  for (const [id, [res, job]] of Object.entries(acc)) {
    const e = ledger.points[id];
    if (e) { e.resAccum = res; e.jobAccum = job; }
  }
  delete ledger.pendingAccum;
}

/**
 * Retire every pop queued in `ledger.pendingRemovals`: subtract any demand still
 * attached (guarded — decay usually subtracted it live already), keep/create a
 * demand-neutral popsMap stub, and remember the id as a tombstone. NEVER deletes
 * from popsMap: the sim ticks before onGameLoaded reaches the mod and saves carry
 * popMovementsMap, so a deleted id orphans in-flight movements and the game loop
 * throws "Pop not found for pop movement <id>" every tick.
 */
export function retirePendingRemovals(
  dd: DemandData,
  ledger: LedgerState,
  cfg: InducedDemandConfig,
): number {
  const pending = ledger.pendingRemovals;
  if (!pending?.length) return 0;
  let retired = 0;
  for (const id of pending) {
    const pop = dd.popsMap.get(id);
    const rec: InducedPopRecord = ledger.pops[id]
      ?? (pop ? { residenceId: pop.residenceId, jobId: pop.jobId } : { residenceId: '', jobId: '' });
    detachInducedPop(dd, id, cfg);
    ensureTombstoneStub(dd, id, rec, cfg);
    recordTombstone(ledger, id, rec);
    delete ledger.pops[id];
    retired++;
  }
  delete ledger.pendingRemovals;
  return retired;
}

/** Re-create demand-neutral stubs for retired ids (run once per load, after reconcile). */
export function restoreTombstoneStubs(
  dd: DemandData,
  ledger: LedgerState,
  cfg: InducedDemandConfig,
): number {
  let stubbed = 0;
  for (const [id, rec] of Object.entries(ledger.tombstones ?? {})) {
    if (ensureTombstoneStub(dd, id, rec, cfg)) stubbed++;
  }
  return stubbed;
}

/**
 * "Clear induced demand": detach every induced pop (demand reverts) and retire
 * them all as tombstones, returning a fresh ledger that keeps `seq` (ids must
 * never be reused while stubs exist) and the tombstone registry.
 */
export function clearAllInduced(
  dd: DemandData,
  ledger: LedgerState,
  cfg: InducedDemandConfig,
): { removed: number; ledger: LedgerState } {
  const fresh = newLedger();
  fresh.seq = ledger.seq;
  fresh.tombstones = { ...(ledger.tombstones ?? {}) };
  const ids = new Set<string>(Object.keys(ledger.pops));
  for (const id of dd.popsMap.keys()) if (isInduced(id)) ids.add(id);
  let removed = 0;
  for (const id of ids) {
    if (fresh.tombstones[id]) continue; // already retired earlier
    const pop = dd.popsMap.get(id);
    const rec: InducedPopRecord = ledger.pops[id]
      ?? (pop ? { residenceId: pop.residenceId, jobId: pop.jobId } : { residenceId: '', jobId: '' });
    if (detachInducedPop(dd, id, cfg)) removed++;
    ensureTombstoneStub(dd, id, rec, cfg);
    fresh.tombstones[id] = rec;
  }
  fresh.tombstones = capTombstones(fresh.tombstones);
  return { removed, ledger: fresh };
}

export function loadFromStore(store: KVStore, key: string): LedgerState {
  try {
    return deserializeFromStore(store.getItem(key));
  } catch {
    return newLedger();
  }
}

export function saveToStore(store: KVStore, key: string, ledger: LedgerState): void {
  try {
    store.setItem(key, serializeForStore(ledger));
  } catch {
    /* quota or unavailable — the roster just won't survive this cold restart; not fatal */
  }
}
