import type { DemandData } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import type { LedgerState } from './ledger';
import type { Site } from './field';
import type { CellIntegral } from './lattice';
import { isPendingRemoval } from './ledger';
import { residentialScore, commercialScore } from './score';
import { cap, logisticDelta } from './growth';
import { reconcile, allocateInteger } from './allocate';
import { pairByGravity } from './gravity';
import {
  addInducedPop, createInducedPoint, INDUCED_PREFIX, deferInducedPopRemoval,
} from './popFactory';
import { INDUCED_POINT_PREFIX } from './inducedId';
import { DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';
import { DEFAULT_DRIVING_MODEL, type DrivingModel } from './drivingModel';
import { clamp } from './util';

export interface DayDelta { ar: number; aj: number; rr: number; rj: number }

export interface DayResult {
  added: number;
  removed: number;
  /** Cells split (points materialized) this day. */
  newPoints: number;
  deltas: Record<string, DayDelta>;
}

/** Injected field/fit context for one day (built by main.ts from the field state). */
export interface RunDayDeps {
  /** People cap for a materialized point at a given access. */
  massAt(access: number): number;
  /** Latest lattice integrals per anchor point id; null = lattice not ready (no splits). */
  cells: Map<string, CellIntegral> | null;
  /** Valid cut location for a splitting cell, or null (cell cannot split now). */
  findCut(anchorId: string, centroid: Coordinate): Coordinate | null;
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
  const locations = new Map<string, Coordinate>();
  for (const s of sites) locations.set(s.id, s.location);
  const capRes = new Map<string, number>();
  const capJob = new Map<string, number>();

  // A. accumulate pressure per point
  for (const s of sites) {
    if (!s.pointId) continue; // occupied-only field; defensive for stale lists
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
    const cR = isMat ? cfg.RES_SHARE * deps.massAt(s.accessRes) : cap(e.baselineResidents, sRes, cfg.K_MAX);
    const cJ = isMat ? cfg.JOB_SHARE * deps.massAt(s.accessCom) : cap(e.baselineJobs, sJob, cfg.K_MAX);
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
  }

  // B. growth — one shared budget over ALL sites, gravity-paired
  let added = 0;
  const deltas: Record<string, DayDelta> = {};
  const addedThisDay = new Set<string>();
  const ids = sites.map((s) => s.id);
  const accumOf = (s: Site): [number, number] => {
    const e = s.pointId ? ledger.points[s.pointId] : undefined;
    return e ? [e.resAccum, e.jobAccum] : [0, 0];
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
    const resPool = expand(ids, allocateInteger(resWeights, N, remCapRes));
    const jobPool = expand(ids, allocateInteger(jobWeights, N, remCapJob));

    for (const [h, w] of pairByGravity(resPool, jobPool, locations, cfg, rng)) {
      const id = `${INDUCED_PREFIX}${ledger.seq}`;
      if (addInducedPop(dd, h, w, id, cfg, slots, driving)) {
        ledger.pops[id] = { residenceId: h, jobId: w };
        ledger.seq++;
        addedThisDay.add(id);
        const eh = ledger.points[h];
        const ew = ledger.points[w];
        if (eh) eh.resAccum = Math.max(0, eh.resAccum - cfg.POP_SIZE);
        if (ew) ew.jobAccum = Math.max(0, ew.jobAccum - cfg.POP_SIZE);
        bumpDelta(deltas, h, 'ar');
        bumpDelta(deltas, w, 'aj');
        added++;
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

  // D. Voronoi subdivision (spec 2026-07-18): split pressure accrues per cell
  // ∝ deficit × fill; the top cells at threshold split into a new point at a
  // valid sample near the access-weighted centroid. Slow by construction —
  // SPLIT_RATE/SPLIT_THRESHOLD/MAX_SPLITS_PER_DAY are the tuning knobs.
  let newPoints = 0;
  if (deps.cells) {
    if (!ledger.cells) ledger.cells = {};
    // prune pressure for anchors that no longer exist
    for (const id of Object.keys(ledger.cells)) {
      if (!dd.points.has(id)) delete ledger.cells[id];
    }
    const ready: { id: string; pressure: number; centroid: Coordinate }[] = [];
    for (const [id, integral] of deps.cells) {
      const p = dd.points.get(id);
      if (!p || !integral.centroid) continue;
      const capTotal = (capRes.get(id) ?? 0) + (capJob.get(id) ?? 0);
      if (capTotal <= 0) continue;
      const deficit = Math.max(0, integral.supportedMass - capTotal);
      const fill = Math.min(1, Math.max(0, (p.residents + p.jobs) / capTotal));
      const next = Math.min(
        cfg.SPLIT_THRESHOLD,
        (ledger.cells[id] ?? 0) + cfg.SPLIT_RATE * deficit * fill,
      );
      if (next !== 0) ledger.cells[id] = next; else delete ledger.cells[id];
      if (next >= cfg.SPLIT_THRESHOLD) ready.push({ id, pressure: next, centroid: integral.centroid });
    }
    ready.sort((a, b) => (b.pressure - a.pressure) || (a.id < b.id ? -1 : 1));
    for (const cell of ready.slice(0, cfg.MAX_SPLITS_PER_DAY)) {
      const cut = deps.findCut(cell.id, cell.centroid);
      if (!cut) continue; // pressure stays capped; retries when geometry/access changes
      const pid = `${INDUCED_POINT_PREFIX}${ledger.ptSeq ?? 0}`;
      ledger.ptSeq = (ledger.ptSeq ?? 0) + 1;
      createInducedPoint(dd, pid, cut);
      if (!ledger.materialized) ledger.materialized = {};
      ledger.materialized[pid] = { location: [cut[0], cut[1]] };
      ledger.points[pid] = { baselineResidents: 0, baselineJobs: 0, resAccum: 0, jobAccum: 0 };
      ledger.cells[cell.id] -= cfg.SPLIT_THRESHOLD;
      if (ledger.cells[cell.id] === 0) delete ledger.cells[cell.id];
      newPoints++;
    }
  }

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
