/**
 * The site field (spec §1): every place that can hold demand. Native demand
 * points are occupied sites; blue-noise candidates in station catchments are
 * empty sites. Candidates are sampled PER STATION (seeded `<city>:<stationId>`,
 * older stations first) so adding a line elsewhere never reshuffles existing
 * candidates, and re-derive identically each load — only accumulators and
 * materialized-point records persist (ledger).
 */
import type { Coordinate } from '../types/core';
import type { DemandData, Route, Station } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import type { DirectionalAccess } from './opportunity';
import { sampleCatchmentSites } from './sampler';
import { DEFAULT_CONFIG } from './config';

export interface Site {
  /** Demand-point id for natives; nominal sampler id for candidates/materialized. */
  id: string;
  /** Demand-point id when occupied, null for empty candidates. */
  pointId: string | null;
  location: Coordinate;
  accessRes: number;
  accessCom: number;
}

export interface FieldDeps {
  spacingAt(c: Coordinate): number;
  accessAt(c: Coordinate): DirectionalAccess;
  isWater(c: Coordinate): boolean;
}

export interface BuildSitesOpts {
  dd: DemandData;
  stations: Station[];
  /** ledger.materialized: point id → { location, siteId }. */
  materialized: Record<string, { location: Coordinate; siteId: string }>;
  catchmentM: number;
  deps: FieldDeps;
  /** City code — sampler seed prefix. */
  seedPrefix: string;
  cfg?: InducedDemandConfig;
}

export function buildSites(opts: BuildSitesOpts): Site[] {
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  const { dd, deps } = opts;
  const sites: Site[] = [];
  const takenSiteIds = new Map<string, string>(); // nominal site id → point id
  for (const [pid, rec] of Object.entries(opts.materialized)) {
    takenSiteIds.set(rec.siteId, pid);
  }

  // Natives + materialized points: occupied sites. Materialized keep their
  // nominal site id so re-sampling dedupe knows the slot is taken.
  const materializedByPoint = opts.materialized;
  for (const p of dd.points.values()) {
    const rec = materializedByPoint[p.id];
    const a = deps.accessAt(p.location);
    sites.push({
      id: rec ? rec.siteId : p.id,
      pointId: p.id,
      location: p.location,
      accessRes: a.res,
      accessCom: a.com,
    });
  }

  // Candidates: per routed station, oldest first; priors = everything placed so far.
  const routed = opts.stations
    .filter((s) => (s.routeIds?.length ?? 0) > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  const priorLocs = (): Coordinate[] => sites.map((s) => s.location);
  for (const st of routed) {
    const samples = sampleCatchmentSites({
      seedKey: `${opts.seedPrefix}:${st.id}`,
      center: st.coords,
      radiusM: opts.catchmentM,
      priors: priorLocs(),
      spacingAt: deps.spacingAt,
      reject: deps.isWater,
      softFactor: 1 - cfg.J_FRAC,
    });
    for (const s of samples) {
      if (takenSiteIds.has(s.id)) continue; // materialized already occupies this slot
      const a = deps.accessAt(s.location);
      if (Math.max(a.res, a.com) < cfg.MIN_SITE_ACCESS) continue;
      sites.push({ id: s.id, pointId: null, location: s.location, accessRes: a.res, accessCom: a.com });
    }
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
