import type { Coordinate } from '../types/core';
import type { DemandData, Pop } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

export const INDUCED_PREFIX = 'induced:';

export function isInduced(popId: string): boolean {
  return popId.startsWith(INDUCED_PREFIX);
}

/**
 * Build a 200-person induced pop. `lastCommute` and `drivingPath` are left for
 * the game sim to populate (see spec §13.4), so we cast the literal to Pop.
 */
export function makeInducedPop(
  id: string,
  residenceId: string,
  jobId: string,
  resLoc: Coordinate,
  jobLoc: Coordinate,
  cfg: InducedDemandConfig,
): Pop {
  const drivingDistance = haversine(resLoc, jobLoc) * cfg.DETOUR_FACTOR;
  return {
    id,
    size: cfg.POP_SIZE,
    residenceId,
    jobId,
    drivingDistance,
    drivingSeconds: drivingDistance / cfg.DRIVE_SPEED,
    homeDepartureTime: cfg.DEFAULT_HOME_DEPART_SEC,
    workDepartureTime: cfg.DEFAULT_WORK_DEPART_SEC,
  } as Pop;
}

/** Add one induced pop; +POP_SIZE residents at residence, +POP_SIZE jobs at job. */
export function addInducedPop(
  dd: DemandData,
  residenceId: string,
  jobId: string,
  id: string,
  cfg: InducedDemandConfig,
): boolean {
  const res = dd.points.get(residenceId);
  const job = dd.points.get(jobId);
  if (!res || !job) return false;
  dd.popsMap.set(id, makeInducedPop(id, residenceId, jobId, res.location, job.location, cfg));
  res.popIds.push(id);
  job.popIds.push(id);
  res.residents += cfg.POP_SIZE;
  job.jobs += cfg.POP_SIZE;
  return true;
}

/** Remove an induced pop, reversing its residents/jobs/popIds effects. */
export function removeInducedPop(dd: DemandData, id: string, cfg: InducedDemandConfig): boolean {
  if (!isInduced(id)) return false;
  const pop = dd.popsMap.get(id);
  if (!pop) return false;
  const res = dd.points.get(pop.residenceId);
  const job = dd.points.get(pop.jobId);
  if (res) { res.residents -= cfg.POP_SIZE; dropId(res.popIds, id); }
  if (job) { job.jobs -= cfg.POP_SIZE; dropId(job.popIds, id); }
  dd.popsMap.delete(id);
  return true;
}

function dropId(arr: string[], id: string): void {
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
}
