import type { DemandData } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import type { LedgerState } from './ledger';
import type { Site } from './field';
import { isPendingRemoval } from './ledger';
import { residentialScore, commercialScore, MODE_SHARE_FLOOR } from './score';
import { cap, logisticDelta } from './growth';
import { reconcile, allocateInteger } from './allocate';
import { pairByGravity } from './gravity';
import {
  addInducedPop, createInducedPoint, INDUCED_PREFIX, deferInducedPopRemoval,
} from './popFactory';
import { INDUCED_POINT_PREFIX } from './inducedId';
import { creepDensify } from './densityFit';
import { DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';
import { DEFAULT_DRIVING_MODEL, type DrivingModel } from './drivingModel';
import { clamp } from './util';

export interface DayDelta { ar: number; aj: number; rr: number; rj: number }

export interface DayResult {
  added: number;
  removed: number;
  /** Points newly materialized this day. */
  newPoints: number;
  deltas: Record<string, DayDelta>;
}

/** Injected field/fit context for one day (built by main.ts from the field state). */
export interface RunDayDeps {
  /** People cap for an empty/materialized site at a given access. */
  massAt(access: number): number;
  /** Local spacing r (m) at a given access — jitter radius source. */
  spacingAt(access: number): number;
  /** Water- and spacing-checked jitter for a materializing point. */
  jitter(pointId: string, nominal: Coordinate, rM: number): Coordinate;
}

function bumpDelta(deltas: Record<string, DayDelta>, id: string, key: keyof DayDelta): void {
  const d = deltas[id] ?? (deltas[id] = { ar: 0, aj: 0, rr: 0, rj: 0 });
  d[key]++;
}

/** Advance the model one in-game day over the unified site field (spec §5). */
export function runDay(
  dd: DemandData,
  sites: Site[],
  ledger: LedgerState,
  cfg: InducedDemandConfig,
  rng: () => number,
  deps: RunDayDeps,
  slots: SlotSet = DEFAULT_SLOT_SET,
  driving: DrivingModel = DEFAULT_DRIVING_MODEL,
): DayResult {
  const densify = ledger.densify ?? 1;
  const locations = new Map<string, Coordinate>();
  for (const s of sites) locations.set(s.id, s.location);
  const capRes = new Map<string, number>();
  const capJob = new Map<string, number>();
  // Saturation inputs: induced headroom filled vs capacity (spec §3).
  let satFilled = 0;
  let satCapacity = 0;

  // A. accumulate pressure per site
  for (const s of sites) {
    if (s.pointId) {
      const p = dd.points.get(s.pointId);
      if (!p) continue;
      const isMat = !!ledger.materialized?.[s.pointId];
      let e = ledger.points[s.pointId];
      if (!e) {
        e = ledger.points[s.pointId] = {
          baselineResidents: isMat ? 0 : p.residents,
          baselineJobs: isMat ? 0 : p.jobs,
          resAccum: 0,
          jobAccum: 0,
        };
      }
      const sRes = residentialScore(p, s.accessRes);
      const sJob = commercialScore(p, s.accessCom);
      const cR = isMat
        ? cfg.RES_SHARE * deps.massAt(s.accessRes) * densify
        : cap(e.baselineResidents, sRes * densify, cfg.K_MAX);
      const cJ = isMat
        ? cfg.JOB_SHARE * deps.massAt(s.accessCom) * densify
        : cap(e.baselineJobs, sJob * densify, cfg.K_MAX);
      capRes.set(s.id, cR);
      capJob.set(s.id, cJ);
      e.resAccum = clamp(
        e.resAccum + logisticDelta(e.baselineResidents, p.residents, cR, sRes, cfg),
        -cfg.ACCUM_CAP, cfg.ACCUM_CAP,
      );
      e.jobAccum = clamp(
        e.jobAccum + logisticDelta(e.baselineJobs, p.jobs, cJ, sJob, cfg),
        -cfg.ACCUM_CAP, cfg.ACCUM_CAP,
      );
      satFilled += Math.max(0, p.residents - e.baselineResidents) + Math.max(0, p.jobs - e.baselineJobs);
      satCapacity += Math.max(0, cR - e.baselineResidents) + Math.max(0, cJ - e.baselineJobs);
    } else {
      // Empty candidate: absolute caps; seed the logistic with one pop of latent demand
      // (current=0 would never grow), never decay below 0 (nothing there to remove).
      if (!ledger.sites) ledger.sites = {};
      const e = ledger.sites[s.id] ?? (ledger.sites[s.id] = [0, 0]);
      const sRes = s.accessRes * MODE_SHARE_FLOOR;
      const sJob = s.accessCom * MODE_SHARE_FLOOR;
      const cR = cfg.RES_SHARE * deps.massAt(s.accessRes) * densify;
      const cJ = cfg.JOB_SHARE * deps.massAt(s.accessCom) * densify;
      capRes.set(s.id, cR);
      capJob.set(s.id, cJ);
      e[0] = clamp(e[0] + Math.max(0, logisticDelta(0, cfg.POP_SIZE, cR, sRes, cfg)), 0, cfg.ACCUM_CAP);
      e[1] = clamp(e[1] + Math.max(0, logisticDelta(0, cfg.POP_SIZE, cJ, sJob, cfg)), 0, cfg.ACCUM_CAP);
      satCapacity += cR + cJ;
    }
  }

  // B. growth — one shared budget over ALL sites, gravity-paired
  let added = 0;
  let newPoints = 0;
  const deltas: Record<string, DayDelta> = {};
  const addedThisDay = new Set<string>();
  const ids = sites.map((s) => s.id);
  const accumOf = (s: Site): [number, number] => {
    if (s.pointId) {
      const e = ledger.points[s.pointId];
      return e ? [e.resAccum, e.jobAccum] : [0, 0];
    }
    return ledger.sites?.[s.id] ?? [0, 0];
  };
  const resWeights = sites.map((s) => Math.max(0, accumOf(s)[0]));
  const jobWeights = sites.map((s) => Math.max(0, accumOf(s)[1]));
  const rp = resWeights.reduce((a, b) => a + b, 0);
  const jp = jobWeights.reduce((a, b) => a + b, 0);
  const N = Math.floor(reconcile(rp, jp, cfg.RECONCILE) / cfg.POP_SIZE);
  if (N > 0) {
    const remCapRes = sites.map((s) => {
      const c = capRes.get(s.id) ?? 0;
      const current = s.pointId ? (dd.points.get(s.pointId)?.residents ?? 0) : 0;
      return Math.max(0, Math.ceil((c - current) / cfg.POP_SIZE));
    });
    const remCapJob = sites.map((s) => {
      const c = capJob.get(s.id) ?? 0;
      const current = s.pointId ? (dd.points.get(s.pointId)?.jobs ?? 0) : 0;
      return Math.max(0, Math.ceil((c - current) / cfg.POP_SIZE));
    });
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const resPool = expand(ids, allocateInteger(resWeights, N, remCapRes));
    const jobPool = expand(ids, allocateInteger(jobWeights, N, remCapJob));

    /** Condense an empty site into a real DemandPoint; returns its point id. */
    const materialize = (site: Site): string => {
      const pid = `${INDUCED_POINT_PREFIX}${ledger.ptSeq ?? 0}`;
      ledger.ptSeq = (ledger.ptSeq ?? 0) + 1;
      const r = deps.spacingAt(Math.max(site.accessRes, site.accessCom));
      const loc = deps.jitter(pid, site.location, r);
      createInducedPoint(dd, pid, loc);
      if (!ledger.materialized) ledger.materialized = {};
      ledger.materialized[pid] = { location: [loc[0], loc[1]], siteId: site.id };
      const [ra, ja] = ledger.sites?.[site.id] ?? [0, 0];
      ledger.points[pid] = { baselineResidents: 0, baselineJobs: 0, resAccum: ra, jobAccum: ja };
      if (ledger.sites) delete ledger.sites[site.id];
      site.pointId = pid;
      locations.set(site.id, loc);
      newPoints++;
      return pid;
    };
    const pointIdFor = (siteId: string): string | null => {
      const site = siteById.get(siteId);
      if (!site) return null;
      return site.pointId ?? materialize(site);
    };

    for (const [h, w] of pairByGravity(resPool, jobPool, locations, cfg, rng)) {
      const hPid = pointIdFor(h);
      const wPid = pointIdFor(w);
      if (!hPid || !wPid) continue;
      const id = `${INDUCED_PREFIX}${ledger.seq}`;
      if (addInducedPop(dd, hPid, wPid, id, cfg, slots, driving)) {
        ledger.pops[id] = { residenceId: hPid, jobId: wPid };
        ledger.seq++;
        addedThisDay.add(id);
        const eh = ledger.points[hPid];
        const ew = ledger.points[wPid];
        if (eh) eh.resAccum = Math.max(0, eh.resAccum - cfg.POP_SIZE);
        if (ew) ew.jobAccum = Math.max(0, ew.jobAccum - cfg.POP_SIZE);
        bumpDelta(deltas, hPid, 'ar');
        bumpDelta(deltas, wPid, 'aj');
        added++;
        satFilled += cfg.POP_SIZE * 2;
      }
    }
  }

  // C. decay — unchanged from the pre-field engine: only occupied sites can decay.
  let removed = 0;
  for (const s of sites) {
    if (!s.pointId) continue;
    const e = ledger.points[s.pointId];
    if (!e) continue;
    while (e.resAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, ledger, s.pointId, 'residence', addedThisDay);
      if (!id) { e.resAccum = -cfg.POP_SIZE + 1; break; }
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.resAccum += cfg.POP_SIZE;
      removed++;
    }
    while (e.jobAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, ledger, s.pointId, 'job', addedThisDay);
      if (!id) { e.jobAccum = -cfg.POP_SIZE + 1; break; }
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.jobAccum += cfg.POP_SIZE;
      removed++;
    }
  }

  // D. saturation-driven densification (spec §3) — monotone.
  const sigma = satCapacity > 0 ? Math.min(1, satFilled / satCapacity) : 0;
  ledger.densify = creepDensify(densify, sigma, cfg);

  return { added, removed, newPoints, deltas };
}

/** A removed pop changes demand at BOTH endpoints — attribute it to each (before deferral). */
function recordRemoval(dd: DemandData, deltas: Record<string, DayDelta>, id: string): void {
  const pop = dd.popsMap.get(id);
  if (!pop) return;
  bumpDelta(deltas, pop.residenceId, 'rr');
  bumpDelta(deltas, pop.jobId, 'rj');
}

function expand(ids: string[], slots: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) for (let k = 0; k < slots[i]; k++) out.push(ids[i]);
  return out;
}

function findInduced(
  dd: DemandData,
  ledger: LedgerState,
  pointId: string,
  side: 'residence' | 'job',
  exclude?: ReadonlySet<string>,
): string | null {
  const p = dd.points.get(pointId);
  if (!p) return null;
  for (let i = p.popIds.length - 1; i >= 0; i--) {
    const id = p.popIds[i];
    if (!id.startsWith(INDUCED_PREFIX)) continue;
    if (exclude?.has(id)) continue;
    if (isPendingRemoval(ledger, id)) continue;
    const pop = dd.popsMap.get(id);
    if (!pop) continue;
    if (side === 'residence' && pop.residenceId === pointId) return id;
    if (side === 'job' && pop.jobId === pointId) return id;
  }
  return null;
}
