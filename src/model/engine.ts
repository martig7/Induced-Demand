import type { DemandData, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import type { LedgerState } from './ledger';
import { isPendingRemoval } from './ledger';
import { access, toAccessStations } from './access';
import { residentialScore, commercialScore } from './score';
import { cap, logisticDelta } from './growth';
import { reconcile, allocateInteger } from './allocate';
import { pairByGravity } from './gravity';
import { addInducedPop, INDUCED_PREFIX, deferInducedPopRemoval } from './popFactory';
import { DEFAULT_SLOT_SET, type SlotSet } from './commuteTimes';
import { clamp } from './util';

/** Per-point demand changes of one day: added/removed pops at residence/job side. */
export interface DayDelta {
  ar: number;
  aj: number;
  rr: number;
  rj: number;
}

export interface DayResult {
  added: number;
  removed: number;
  /** Only points touched this day are present (feeds the history panel/overlay). */
  deltas: Record<string, DayDelta>;
}

function bumpDelta(deltas: Record<string, DayDelta>, id: string, key: keyof DayDelta): void {
  const d = deltas[id] ?? (deltas[id] = { ar: 0, aj: 0, rr: 0, rj: 0 });
  d[key]++;
}

/** Advance the induced-demand model one in-game day, mutating `dd` and `ledger`. */
export function runDay(
  dd: DemandData,
  stations: Station[],
  ledger: LedgerState,
  cfg: InducedDemandConfig,
  rng: () => number,
  /** Live commute-time slots (from the game's ranges); defaults to the game's table. */
  slots: SlotSet = DEFAULT_SLOT_SET,
): DayResult {
  const points = [...dd.points.values()];
  const accessStations = toAccessStations(stations);
  const locations = new Map<string, Coordinate>();
  for (const p of points) locations.set(p.id, p.location);
  const capRes = new Map<string, number>();
  const capJob = new Map<string, number>();
  const scoreSum = new Map<string, number>();

  // A. accumulate pressure
  for (const p of points) {
    let e = ledger.points[p.id];
    if (!e) {
      e = ledger.points[p.id] = {
        baselineResidents: p.residents,
        baselineJobs: p.jobs,
        resAccum: 0,
        jobAccum: 0,
      };
    }
    const a = access(p.location, accessStations, cfg);
    const sRes = residentialScore(p, a);
    const sJob = commercialScore(p, a);
    const cR = cap(e.baselineResidents, sRes, cfg.K_MAX);
    const cJ = cap(e.baselineJobs, sJob, cfg.K_MAX);
    capRes.set(p.id, cR);
    capJob.set(p.id, cJ);
    scoreSum.set(p.id, sRes + sJob);
    e.resAccum = clamp(
      e.resAccum + logisticDelta(e.baselineResidents, p.residents, cR, sRes, cfg),
      -cfg.ACCUM_CAP,
      cfg.ACCUM_CAP,
    );
    e.jobAccum = clamp(
      e.jobAccum + logisticDelta(e.baselineJobs, p.jobs, cJ, sJob, cfg),
      -cfg.ACCUM_CAP,
      cfg.ACCUM_CAP,
    );
  }

  // B. optional relocation: trim growth pressure at the lowest-score points
  if (cfg.PHI > 0) applyRelocation(points, ledger, scoreSum, cfg);

  // C. growth — net-equal, cap-respecting, gravity-paired
  let added = 0;
  const deltas: Record<string, DayDelta> = {};
  const addedThisDay = new Set<string>();
  const ids = points.map((p) => p.id);
  const resWeights = points.map((p) => Math.max(0, ledger.points[p.id].resAccum));
  const jobWeights = points.map((p) => Math.max(0, ledger.points[p.id].jobAccum));
  const rp = resWeights.reduce((a, b) => a + b, 0);
  const jp = jobWeights.reduce((a, b) => a + b, 0);
  const N = Math.floor(reconcile(rp, jp, cfg.RECONCILE) / cfg.POP_SIZE);
  if (N > 0) {
    const remCapRes = points.map((p) =>
      Math.max(0, Math.ceil((capRes.get(p.id)! - p.residents) / cfg.POP_SIZE)),
    );
    const remCapJob = points.map((p) =>
      Math.max(0, Math.ceil((capJob.get(p.id)! - p.jobs) / cfg.POP_SIZE)),
    );
    const resPool = expand(ids, allocateInteger(resWeights, N, remCapRes));
    const jobPool = expand(ids, allocateInteger(jobWeights, N, remCapJob));
    for (const [h, w] of pairByGravity(resPool, jobPool, locations, cfg, rng)) {
      const id = `${INDUCED_PREFIX}${ledger.seq}`;
      if (addInducedPop(dd, h, w, id, cfg, slots)) {
        ledger.pops[id] = { residenceId: h, jobId: w }; // track so a lost save can restore it
        ledger.seq++;
        addedThisDay.add(id);
        ledger.points[h].resAccum = Math.max(0, ledger.points[h].resAccum - cfg.POP_SIZE);
        ledger.points[w].jobAccum = Math.max(0, ledger.points[w].jobAccum - cfg.POP_SIZE);
        bumpDelta(deltas, h, 'ar');
        bumpDelta(deltas, w, 'aj');
        added++;
      }
    }
  }

  // D. decay (rare) — queue induced pops for removal while accumulator is below −POP_SIZE.
  // Never delete from live demand data here: the game may still have in-flight movements
  // referencing the pop id (retired to tombstone stubs at the next real load — see
  // ledger.retirePendingRemovals).
  let removed = 0;
  for (const p of points) {
    const e = ledger.points[p.id]; // always initialised in section A above
    while (e.resAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, ledger, p.id, 'residence', addedThisDay);
      if (!id) { e.resAccum = -cfg.POP_SIZE + 1; break; }
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.resAccum += cfg.POP_SIZE;
      removed++;
    }
    while (e.jobAccum <= -cfg.POP_SIZE) {
      const id = findInduced(dd, ledger, p.id, 'job', addedThisDay);
      if (!id) { e.jobAccum = -cfg.POP_SIZE + 1; break; }
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.jobAccum += cfg.POP_SIZE;
      removed++;
    }
  }

  return { added, removed, deltas };
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

function applyRelocation(
  points: { id: string }[],
  ledger: LedgerState,
  scoreSum: Map<string, number>,
  cfg: InducedDemandConfig,
): void {
  const gross = points.reduce(
    (s, p) =>
      s + Math.max(0, ledger.points[p.id].resAccum) + Math.max(0, ledger.points[p.id].jobAccum),
    0,
  );
  let budget = cfg.PHI * gross;
  if (budget <= 0) return;
  const sorted = [...points].sort(
    (a, b) => (scoreSum.get(a.id) ?? 0) - (scoreSum.get(b.id) ?? 0),
  );
  for (const p of sorted) {
    if (budget <= 0) break;
    const e = ledger.points[p.id];
    const takeR = Math.min(budget, Math.max(0, e.resAccum));
    e.resAccum -= takeR;
    budget -= takeR;
    const takeJ = Math.min(budget, Math.max(0, e.jobAccum));
    e.jobAccum -= takeJ;
    budget -= takeJ;
  }
}
