/**
 * The site field (spec §1): the places that hold demand. Sites are EXACTLY the
 * live demand points — natives plus previously induced points — each carrying
 * cached directional access. There are no empty candidate sites: infill targets
 * come from the Voronoi subdivision lattice instead (see lattice.ts), so
 * the field re-derives trivially each load; only accumulators and induced-point
 * records persist (ledger).
 */
import type { Coordinate } from '../types/core';
import type { DemandData, Route } from '../types/game-state';
import type { DirectionalAccess } from './opportunity';

export interface Site {
  /** The demand point's id (sites are exactly the live demand points). */
  id: string;
  pointId: string;
  location: Coordinate;
  accessRes: number;
  accessCom: number;
}

/** The site list is exactly the live demand points with cached access. */
export function buildPointSites(
  dd: DemandData,
  accessAt: (c: Coordinate) => DirectionalAccess,
): Site[] {
  const sites: Site[] = [];
  for (const p of dd.points.values()) {
    const a = accessAt(p.location);
    sites.push({ id: p.id, pointId: p.id, location: p.location, accessRes: a.res, accessCom: a.com });
  }
  return sites;
}

/** Tier 2 refresh: recompute cached access on every site (topology unchanged). */
export function refreshSiteAccess(
  sites: Site[],
  accessAt: (c: Coordinate) => DirectionalAccess,
): void {
  for (const s of sites) {
    const a = accessAt(s.location);
    s.accessRes = a.res;
    s.accessCom = a.com;
  }
}

/**
 * Structural hash of the live network (spec §8): route ids + per-route station
 * ids. This is the PRIMARY route-edit detector — temp-route commits fire NO
 * hook (decompile-verified), so Tier 2 compares this every day end.
 */
export function computeStructuralHash(routes: Route[]): string {
  return routes
    .filter((r) => r.tempParentId == null)
    .map((r) => `${r.id}:${(r.stations ?? []).map((s) => s.id).join(',')}`)
    .sort()
    .join('|');
}

/**
 * Service-level hash (Tier 2 pruning): everything the graph WEIGHTS depend on —
 * schedules, timetable headways, timings — but not demand masses (those drift
 * daily with growth; the caller tracks drift separately and refreshes on a
 * threshold). Unchanged hash ⇒ the day-end weight refresh can be skipped.
 */
export function computeServiceHash(routes: Route[]): string {
  return routes
    .filter((r) => r.tempParentId == null)
    .map((r) => {
      const ts = r.trainSchedule;
      const tt = r.timetableSchedule;
      const timings = r.stComboTimings ?? [];
      return [
        r.id,
        ts ? `${ts.highDemand},${ts.mediumDemand},${ts.lowDemand},${ts.veryLowDemand ?? ''}` : '',
        r.idealTrainCount ?? '',
        tt?.mode === 'timetable' ? (tt.periods ?? []).map((p) => p.headwaySeconds).join(',') : '',
        timings.length,
        timings.length > 0 ? timings[timings.length - 1].arrivalTime : 0,
      ].join(':');
    })
    .sort()
    .join('|');
}
