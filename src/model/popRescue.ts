/**
 * Rescue for induced pops carrying stale generated values (commute times, driving
 * distance/time).
 *
 * Our departure times are a pure function of the pop id (see model/commuteTimes),
 * so the correct pair for a pop is always recomputable. Anything else is stale:
 * pops created by mod builds that pinned every commute to 8:00/17:00, pops a save
 * preserved from such a build, or pops left behind when the game's time-of-day
 * table changed. This module recomputes and repairs them.
 *
 * It RETIMES IN PLACE and never touches `popsMap` membership. Deleting a pop to
 * re-add it would orphan in-flight movements and make the game loop throw
 * "Pop not found for pop movement <id>" every tick (see model/movementRepair),
 * and a new id would break the id-seeded determinism. Mutating the two departure
 * fields is enough: the commute worker reads them off the pop each time it plans a
 * commute, so the pop keeps its id, size, endpoints and demand contribution.
 */
import type { Coordinate } from '../types/core';
import type { DemandData, Pop } from '../types/game-state';
import { isInduced } from './inducedId';
import { commuteTimesFor, DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';
import { DEFAULT_DRIVING_MODEL, type DrivingModel } from './drivingModel';

/**
 * True when this pop is one of ours, still live, and its departure times are not
 * the ones our generator produces for its id. Exact comparison is correct here:
 * both sides come from the same deterministic function, and times are never
 * persisted, so there is no serialization round-trip to blur them.
 */
export function needsRetime(pop: Pop, slots: SlotSet = DEFAULT_SLOT_SET): boolean {
  if (!isInduced(pop.id)) return false;
  if (pop.size <= 0) return false; // retired tombstone stub: inert, never rides
  const want = commuteTimesFor(pop.id, pop.jobId, slots);
  return pop.homeDepartureTime !== want.homeDepartureTime
    || pop.workDepartureTime !== want.workDepartureTime;
}

/** Retime every stale induced pop in place. Returns how many were repaired. */
export function rescueCommuteTimes(dd: DemandData, slots: SlotSet = DEFAULT_SLOT_SET): number {
  let retimed = 0;
  for (const pop of dd.popsMap.values()) {
    if (!needsRetime(pop, slots)) continue;
    const want = commuteTimesFor(pop.id, pop.jobId, slots);
    pop.homeDepartureTime = want.homeDepartureTime;
    pop.workDepartureTime = want.workDepartureTime;
    retimed++;
  }
  return retimed;
}

/**
 * Driving values drift for a different reason than commute times: older builds wrote
 * `haversine × 1.30 ÷ 11 m/s` for every pop, which understates real speeds by ~33%
 * and biased those pops onto transit. They are also recomputable — the model is
 * deterministic in the pop id — but unlike times they are floating point results of a
 * per-city speed fit, so an exact comparison would rewrite every pop whenever the fit
 * moves by a hair. Compare with a relative tolerance instead: wide enough to ignore a
 * refit, far tighter than any real drift.
 */
const DRIVING_TOLERANCE = 0.005; // 0.5%

const off = (actual: number, want: number): boolean =>
  !Number.isFinite(actual) || actual <= 0 || Math.abs(actual - want) > want * DRIVING_TOLERANCE;

/** Endpoints of a pop, or null when either no longer exists on the map. */
function endpointsOf(pop: Pop, dd: DemandData): { res: Coordinate; job: Coordinate } | null {
  const res = dd.points.get(pop.residenceId);
  const job = dd.points.get(pop.jobId);
  return res && job ? { res: res.location, job: job.location } : null;
}

export function needsDrivingFix(
  pop: Pop,
  dd: DemandData,
  driving: DrivingModel = DEFAULT_DRIVING_MODEL,
): boolean {
  if (!isInduced(pop.id)) return false;
  if (pop.size <= 0) return false; // retired stub: never drives
  const ends = endpointsOf(pop, dd);
  if (!ends) return false; // can't recompute without endpoints; leave it alone
  const want = driving.estimate(pop.id, pop.residenceId, pop.jobId, ends.res, ends.job);
  return off(pop.drivingDistance, want.distance) || off(pop.drivingSeconds, want.seconds);
}

/** Recompute driving distance/time for stale induced pops, in place. Returns the count. */
export function rescueDrivingValues(
  dd: DemandData,
  driving: DrivingModel = DEFAULT_DRIVING_MODEL,
): number {
  let fixed = 0;
  for (const pop of dd.popsMap.values()) {
    if (!needsDrivingFix(pop, dd, driving)) continue;
    const ends = endpointsOf(pop, dd)!;
    const want = driving.estimate(pop.id, pop.residenceId, pop.jobId, ends.res, ends.job);
    pop.drivingDistance = want.distance;
    pop.drivingSeconds = want.seconds;
    fixed++;
  }
  return fixed;
}
