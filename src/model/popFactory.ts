import type { Coordinate } from '../types/core';
import type { DemandData, DemandPoint, ModeChoiceStats, Pop } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import { commuteTimesFor, DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';
import { DEFAULT_DRIVING_MODEL, type DrivingModel } from './drivingModel';
import { INDUCED_PREFIX, isInduced } from './inducedId';

// Re-exported: these were part of popFactory's surface before the split.
export { INDUCED_PREFIX, isInduced };

/**
 * Build a 200-person induced pop. `lastCommute` and `drivingPath` are left for
 * the game sim to populate (see spec §13.4), so we cast the literal to Pop.
 * Departure times are drawn from the game's own commute distribution, seeded by
 * the pop id so they survive a restore unchanged (see model/commuteTimes).
 */
export function makeInducedPop(
  id: string,
  residenceId: string,
  jobId: string,
  resLoc: Coordinate,
  jobLoc: Coordinate,
  cfg: InducedDemandConfig,
  slots: SlotSet = DEFAULT_SLOT_SET,
  driving: DrivingModel = DEFAULT_DRIVING_MODEL,
  size: number = cfg.POP_SIZE,
): Pop {
  const { distance, seconds } = driving.estimate(id, residenceId, jobId, resLoc, jobLoc);
  const { homeDepartureTime, workDepartureTime } = commuteTimesFor(id, jobId, slots);
  return {
    id,
    size,
    residenceId,
    jobId,
    drivingDistance: distance,
    drivingSeconds: seconds,
    homeDepartureTime,
    workDepartureTime,
  } as Pop;
}

/**
 * Add one induced pop; +size residents at residence, +size jobs at job. `size`
 * defaults to a full POP_SIZE; a smaller "crumb" tops a point up to its next
 * POP_SIZE boundary when a whole pop won't fit under cap (see engine.ts §B2).
 */
export function addInducedPop(
  dd: DemandData,
  residenceId: string,
  jobId: string,
  id: string,
  cfg: InducedDemandConfig,
  slots: SlotSet = DEFAULT_SLOT_SET,
  driving: DrivingModel = DEFAULT_DRIVING_MODEL,
  size: number = cfg.POP_SIZE,
): boolean {
  const res = dd.points.get(residenceId);
  const job = dd.points.get(jobId);
  if (!res || !job) return false;
  dd.popsMap.set(id, makeInducedPop(id, residenceId, jobId, res.location, job.location, cfg, slots, driving, size));
  res.popIds.push(id);
  job.popIds.push(id);
  res.residents += size;
  job.jobs += size;
  return true;
}

/**
 * Remove an induced pop, reversing its residents/jobs/popIds effects.
 * WARNING: deletes from popsMap — never call while a game is (or was just) running:
 * in-flight movements (live or restored from a save) resolve pops by id and a
 * missing id throws a GameLoop tick error every tick. Use detachInducedPop +
 * tombstones (ledger.retirePendingRemovals / clearAllInduced) instead.
 */
export function removeInducedPop(dd: DemandData, id: string, cfg: InducedDemandConfig): boolean {
  if (!isInduced(id)) return false;
  const pop = dd.popsMap.get(id);
  if (!pop) return false;
  const res = dd.points.get(pop.residenceId);
  const job = dd.points.get(pop.jobId);
  if (res) { res.residents -= pop.size; dropId(res.popIds, id); }
  if (job) { job.jobs -= pop.size; dropId(job.popIds, id); }
  dd.popsMap.delete(id);
  return true;
}

/**
 * Make a pop demand-neutral without deleting it: subtract its residents/jobs
 * contribution and drop it from endpoint popIds, but KEEP the popsMap entry so
 * anything referencing the id (in-flight movements — live or restored from a
 * save) still resolves. Guarded by popIds membership so it can never subtract
 * twice. Returns true only when demand was actually subtracted.
 */
export function detachInducedPop(dd: DemandData, id: string, cfg: InducedDemandConfig): boolean {
  if (!isInduced(id)) return false;
  const pop = dd.popsMap.get(id);
  if (!pop) return false;
  const res = dd.points.get(pop.residenceId);
  const job = dd.points.get(pop.jobId);
  let detached = false;
  if (res?.popIds.includes(id)) { res.residents -= pop.size; dropId(res.popIds, id); detached = true; }
  if (job?.popIds.includes(id)) { job.jobs -= pop.size; dropId(job.popIds, id); detached = true; }
  // Size 0 makes the retained entry fully inert: it adds nothing to the game's
  // mode-share/ridership sums (which only ever ADD sizes) and our overlay's
  // per-point induced totals. Only the id needs to stay resolvable.
  pop.size = 0;
  return detached;
}

/**
 * Ensure a demand-neutral stub exists in `popsMap` for a retired pop id. Saves
 * keep `popMovementsMap` but strip induced pops, and the sim ticks before
 * `onGameLoaded` reaches the mod — a missing id turns into
 * "[GameLoop] Tick error: Pop not found for pop movement <id>" EVERY tick.
 * The stub touches no demand point, so it induces nothing and rides nothing new.
 */
export function ensureTombstoneStub(
  dd: DemandData,
  id: string,
  rec: { residenceId: string; jobId: string } | undefined,
  cfg: InducedDemandConfig,
): boolean {
  if (!isInduced(id) || dd.popsMap.has(id)) return false;
  // A stub MUST reference live demand points. The commute worker resolves every pop's
  // residenceId/jobId against the point map and throws "Residence and/or job coords
  // not found for pop" — killing the entire batch — if either is missing. Our record
  // can easily be stale (a city data update removed the point; DEN went 5566 → 5532)
  // or absent entirely (a dangling movement from a build that hard-deleted pops), so
  // resolve what we can and anchor the rest to a point that exists. The stub is size 0
  // and unlinked from popIds, so borrowing a point costs nothing in demand or riders.
  const res = rec ? dd.points.get(rec.residenceId) : undefined;
  const job = rec ? dd.points.get(rec.jobId) : undefined;
  const anchor = res ?? job ?? dd.points.values().next().value;
  if (!anchor) return false; // no points at all — nothing safe to point at
  const resPoint = res ?? anchor;
  const jobPoint = job ?? anchor;
  const stub = makeInducedPop(id, resPoint.id, jobPoint.id, resPoint.location, jobPoint.location, cfg);
  stub.size = 0; // inert: nothing in the game divides by a pop's size — it is only summed
  dd.popsMap.set(id, stub);
  return true;
}

/** Runtime mode-share zeroes for a freshly materialized point. */
export function zeroModeShare(): ModeChoiceStats {
  return { walking: 0, driving: 0, transit: 0, unknown: 0 };
}

/**
 * Materialize an empty induced demand point (spec §5). The sim overwrites the
 * mode-share fields on its next cycle; residents/jobs stay 0 until pops attach.
 */
export function createInducedPoint(dd: DemandData, id: string, location: Coordinate): DemandPoint {
  const p: DemandPoint = {
    id,
    location,
    residents: 0,
    jobs: 0,
    popIds: [],
    residentModeShare: zeroModeShare(),
    workerModeShare: zeroModeShare(),
  };
  dd.points.set(id, p);
  return p;
}

/**
 * Decay during live simulation: update demand totals now (matching the old
 * remove path) but keep the pop entry in `popsMap` so in-flight movements can
 * still resolve it by id. The entry becomes a tombstone stub on the next real
 * load via retirePendingRemovals (see ledger.ts) — it is never deleted.
 */
export function deferInducedPopRemoval(
  dd: DemandData,
  ledger: { pendingRemovals?: string[] },
  id: string,
  cfg: InducedDemandConfig,
): boolean {
  if (!isInduced(id)) return false;
  if (ledger.pendingRemovals?.includes(id)) return false;
  if (!dd.popsMap.has(id)) return false;
  detachInducedPop(dd, id, cfg);
  if (!ledger.pendingRemovals) ledger.pendingRemovals = [];
  ledger.pendingRemovals.push(id);
  return true;
}

function dropId(arr: string[], id: string): void {
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
}

export function countInducedPops(dd: DemandData): number {
  let n = 0;
  for (const id of dd.popsMap.keys()) if (isInduced(id)) n++;
  return n;
}

/** Pops that remain in the sim but will be retired on the next real load. */
export function deferredRemovalPopCount(
  dd: DemandData,
  ledger: { pendingRemovals?: string[]; tombstones?: Record<string, unknown> },
  clearQueued: boolean,
): number {
  if (clearQueued) {
    // Count live induced pops only — tombstone stubs are already retired.
    let n = 0;
    for (const id of dd.popsMap.keys()) {
      if (isInduced(id) && !(ledger.tombstones && id in ledger.tombstones)) n++;
    }
    return n;
  }
  return ledger.pendingRemovals?.length ?? 0;
}
