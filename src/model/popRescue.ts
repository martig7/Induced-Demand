/**
 * Rescue for induced pops carrying wrong commute times.
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
import type { DemandData, Pop } from '../types/game-state';
import { isInduced } from './popFactory';
import { commuteTimesFor, DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';

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
