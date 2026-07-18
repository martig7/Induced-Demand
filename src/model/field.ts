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
import { sampleCatchmentSites, createSpacingIndex } from './sampler';
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
  /** ledger.materialized: point id → { location, siteId? } (siteId legacy-optional). */
  materialized: Record<string, { location: Coordinate; siteId?: string }>;
  catchmentM: number;
  deps: FieldDeps;
  /** City code — sampler seed prefix. */
  seedPrefix: string;
  cfg?: InducedDemandConfig;
}

/**
 * Incremental site builder so the chunked Tier 1 rebuild can time-box the
 * sampling loop across event-loop turns. `step()` samples ONE station's
 * catchment; iteration order (natives first, then routed stations oldest
 * first) is fixed, so any chunking schedule yields identical sites.
 */
export interface SiteBuilder {
  /** Number of routed stations that will be sampled. */
  readonly stationCount: number;
  /** Sample the next station's catchment. Returns false when exhausted. */
  step(): boolean;
  /** The accumulated sites (natives + candidates so far). */
  finish(): Site[];
}

export function createSiteBuilder(opts: BuildSitesOpts): SiteBuilder {
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  const { dd, deps } = opts;
  const sites: Site[] = [];
  const takenSiteIds = new Map<string, string>(); // nominal site id → point id
  for (const [pid, rec] of Object.entries(opts.materialized)) {
    if (rec.siteId !== undefined) takenSiteIds.set(rec.siteId, pid);
  }

  // Natives + materialized points: occupied sites, and blockers in the ONE
  // spacing index shared by every catchment of this build (the per-station
  // priors-array rebuild was the quadratic heart of the 161 s tier1 rebuild).
  const blockers = createSpacingIndex();
  const materializedByPoint = opts.materialized;
  for (const p of dd.points.values()) {
    const rec = materializedByPoint[p.id];
    const a = deps.accessAt(p.location);
    blockers.insert(p.location, deps.spacingAt(p.location));
    sites.push({
      id: rec?.siteId ?? p.id,
      pointId: p.id,
      location: p.location,
      accessRes: a.res,
      accessCom: a.com,
    });
  }

  // Candidates: per routed station, oldest first; accepted samples join the
  // shared index as they land, so later catchments respect them automatically.
  // Low-access spots are rejected inside the sampler (they neither exist nor
  // block), replacing the old post-filter.
  const routed = opts.stations
    .filter((s) => (s.routeIds?.length ?? 0) > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  let next = 0;
  return {
    stationCount: routed.length,
    step(): boolean {
      if (next >= routed.length) return false;
      const st = routed[next++];
      const samples = sampleCatchmentSites({
        seedKey: `${opts.seedPrefix}:${st.id}`,
        center: st.coords,
        radiusM: opts.catchmentM,
        blockers,
        spacingAt: deps.spacingAt,
        reject: (c) => {
          if (deps.isWater(c)) return true;
          const a = deps.accessAt(c);
          return Math.max(a.res, a.com) < cfg.MIN_SITE_ACCESS;
        },
        softFactor: 1 - cfg.J_FRAC,
      });
      for (const s of samples) {
        if (takenSiteIds.has(s.id)) continue; // materialized already occupies this slot
        const a = deps.accessAt(s.location);
        sites.push({ id: s.id, pointId: null, location: s.location, accessRes: a.res, accessCom: a.com });
      }
      return true;
    },
    finish: () => sites,
  };
}

export function buildSites(opts: BuildSitesOpts): Site[] {
  const builder = createSiteBuilder(opts);
  while (builder.step()) { /* run to completion */ }
  return builder.finish();
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
