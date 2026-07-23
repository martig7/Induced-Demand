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
  /** Cells at the split threshold this day (diagnostic). */
  readyCells: number;
  /** Ready cells that couldn't place a cut this day — findCut null (diagnostic). */
  nullCuts: number;
  deltas: Record<string, DayDelta>;
}

/** Injected field/fit context for one day (built by main.ts from the field state). */
export interface RunDayDeps {
  /**
   * Residential / job cap for a materialized point at a given access, drawn from
   * the native side-distribution at a stable per-point uniform `u` ∈ [0,1] — so
   * new points inherit each side's shape (even residents, heavy-tailed jobs).
   */
  massResAt(access: number, u: number): number;
  massJobAt(access: number, u: number): number;
  /** Latest lattice integrals per anchor point id; null = lattice not ready (no splits). */
  cells: Map<string, CellIntegral> | null;
  /** Valid cut location for a splitting cell, or null (cell cannot split now). */
  findCut(anchorId: string, centroid: Coordinate): Coordinate | null;
  /** Normalized [0,1] local job density for the agglomeration boost; absent → 0. */
  jobDensity?(c: Coordinate): number;
  /**
   * Local RESIDENTIAL density (residents/m²) for the split-headroom gate; absent
   * → no gate (headroom 1). Residents only so job cores stay ungated and
   * agglomeration can still concentrate there. See TARGET_POP_DENSITY_PER_KM2.
   */
  popDensity?(c: Coordinate): number;
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
    // Agglomeration: job-dense land is more attractive for jobs (jobs attract
    // jobs), so a few clusters concentrate instead of jobs spreading evenly. The
    // factor lifts the job GROWTH RATE (via sJob, both point kinds) AND the job
    // CAP — native through sJob, materialized by scaling massJobAt below — so a
    // split point in a job core gets a genuinely larger ceiling, not just faster
    // fill. Residences are untouched.
    const agglom = 1 + cfg.AGGLOM_STRENGTH * (deps.jobDensity?.(p.location) ?? 0);
    const sJob = commercialScore(p, s.accessCom) * agglom;
    // Materialized caps are the point's FULL physical capacity, DRAWN from the
    // native side-distributions (shape: even residents, skewed jobs) at stable,
    // DECORRELATED per-point uniforms, biased toward the tail where access is
    // high. No res/job "share" multiplier: a hard per-point cap should encode the
    // location's stable PHYSICAL capacity, not the shifting global res/job need —
    // that balance is handled downstream by net-equal pairing and the growth
    // budget flowing to the scarce side (weighted by the accumulators). Baking
    // the moving need into each cap made them churn (over-cap → decay) daily.
    const cR = isMat
      ? deps.massResAt(s.accessRes, capDrawU(s.accessRes, `${s.pointId}#r`, cfg))
      : cap(e.baselineResidents, sRes, cfg.K_MAX);
    const cJ = isMat
      ? agglom * deps.massJobAt(s.accessCom, capDrawU(s.accessCom, `${s.pointId}#j`, cfg))
      : cap(e.baselineJobs, sJob, cfg.K_MAX);
    capRes.set(s.id, cR);
    capJob.set(s.id, cJ);
    // Logistic growth is ∝ current, so a freshly split point (residents/jobs 0)
    // could never grow — it would sit empty forever. For materialized points,
    // seed the growth with one pop of latent demand (capped so we never force
    // decay) AND multiply the rate by NEW_POINT_GROWTH_BOOST so the new dot fills
    // in over days rather than ~25. Native points use their actual current at 1×.
    const seed = (cur: number, capV: number): number =>
      isMat ? Math.max(cur, Math.min(cfg.POP_SIZE, capV)) : cur;
    const boost = isMat ? cfg.NEW_POINT_GROWTH_BOOST : 1;
    // An accumulator is capped by the point's REAL remaining headroom, so it says
    // what the point actually needs — a point with 40 people of room holds 40, not
    // ACCUM_CAP. Without this a capped-out point keeps accruing phantom demand that
    // inflates the day's budget and hands its pops to other points. The lower bound
    // stays −ACCUM_CAP so over-cap decay can still drive removals.
    const headRes = Math.max(0, cR - p.residents);
    const headJob = Math.max(0, cJ - p.jobs);
    e.resAccum = clamp(
      e.resAccum + boost * logisticDelta(e.baselineResidents, seed(p.residents, cR), cR, sRes, cfg),
      -cfg.ACCUM_CAP, Math.min(cfg.ACCUM_CAP, headRes),
    );
    e.jobAccum = clamp(
      e.jobAccum + boost * logisticDelta(e.baselineJobs, seed(p.jobs, cJ), cJ, sJob, cfg),
      -cfg.ACCUM_CAP, Math.min(cfg.ACCUM_CAP, headJob),
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
  // FLOOR, not ceil: a pop is added only when the cap fully supports it, so a
  // point settles at the largest POP_SIZE-multiple ≤ cap and never OVERSHOOTS.
  // (ceil let a point with <1 pop of headroom take a whole pop, tipping it over
  // cap, which the over-cap decay then shed — an endless add/decay churn on
  // every point whose cap isn't a clean multiple of POP_SIZE.) Because an add
  // leaves the point at or below cap, decay can never fire right after one —
  // churn is precluded structurally, and a sub-pop remainder simply waits, as
  // honest unmet demand, until the cap grows enough to clear a whole pop.
  const remCapRes = sites.map((s) => {
    const c = capRes.get(s.id) ?? 0;
    const current = s.pointId ? (dd.points.get(s.pointId)?.residents ?? 0) : 0;
    return Math.max(0, Math.floor((c - current) / cfg.POP_SIZE));
  });
  const remCapJob = sites.map((s) => {
    const c = capJob.get(s.id) ?? 0;
    const current = s.pointId ? (dd.points.get(s.pointId)?.jobs ?? 0) : 0;
    return Math.max(0, Math.floor((c - current) / cfg.POP_SIZE));
  });
  // Weights count only PLACEABLE demand — a point's claim is capped at the whole
  // pops it can actually accept. So 40 people of unmet need contribute 0 to the
  // day's budget N instead of inflating it and donating those pops elsewhere.
  const resWeights = sites.map((s, i) => Math.min(Math.max(0, accumOf(s)[0]), remCapRes[i] * cfg.POP_SIZE));
  const jobWeights = sites.map((s, i) => Math.min(Math.max(0, accumOf(s)[1]), remCapJob[i] * cfg.POP_SIZE));
  const rp = resWeights.reduce((a, b) => a + b, 0);
  const jp = jobWeights.reduce((a, b) => a + b, 0);
  const N = Math.floor(reconcile(rp, jp, cfg.RECONCILE) / cfg.POP_SIZE);
  if (N > 0) {
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

  // B2. crumb top-up — complete points sitting OFF the POP_SIZE grid to their
  // next boundary, funded by their own honest unmet demand, when that boundary
  // fits under cap. The whole-pop FLOOR above strands every point's sub-POP_SIZE
  // remainder; where native demand is finely chopped below POP_SIZE (points far
  // smaller than one pop), that stranded remainder is nearly all the headroom, so
  // those points can never grow. A crumb pop carries a partial `size`, added to a
  // residence and a job endpoint equally (net-equal preserved). Each pop completes
  // the smaller of the paired gaps exactly and advances the larger; a point lands
  // at or below cap, so decay can't fire right after — churn stays precluded.
  const crumbGap = (current: number, capV: number, accum: number): number => {
    const gap = (cfg.POP_SIZE - (current % cfg.POP_SIZE)) % cfg.POP_SIZE; // to next boundary
    return gap > 0 && current + gap <= capV && accum >= gap ? gap : 0;
  };
  const resCrumb: { id: string; need: number }[] = [];
  const jobCrumb: { id: string; need: number }[] = [];
  for (const s of sites) {
    if (!s.pointId) continue;
    const p = dd.points.get(s.pointId);
    const e = ledger.points[s.pointId];
    if (!p || !e) continue;
    const gr = crumbGap(p.residents, capRes.get(s.id) ?? 0, e.resAccum);
    if (gr > 0) resCrumb.push({ id: s.pointId, need: gr });
    const gj = crumbGap(p.jobs, capJob.get(s.id) ?? 0, e.jobAccum);
    if (gj > 0) jobCrumb.push({ id: s.pointId, need: gj });
  }
  // Net-equal pairing: each pop adds the same `size` to one residence and one job,
  // so total residents added == total jobs added regardless of match geometry.
  for (let ri = 0, ji = 0; ri < resCrumb.length && ji < jobCrumb.length;) {
    const rc = resCrumb[ri], jc = jobCrumb[ji];
    if (rc.id === jc.id) { ji++; continue; } // no self-commute (matches pairByGravity)
    const size = Math.min(rc.need, jc.need);
    if (size > 0) {
      const id = `${INDUCED_PREFIX}${ledger.seq}`;
      if (addInducedPop(dd, rc.id, jc.id, id, cfg, slots, driving, size)) {
        ledger.pops[id] = { residenceId: rc.id, jobId: jc.id };
        ledger.seq++;
        addedThisDay.add(id);
        const eh = ledger.points[rc.id];
        const ew = ledger.points[jc.id];
        if (eh) eh.resAccum = Math.max(0, eh.resAccum - size);
        if (ew) ew.jobAccum = Math.max(0, ew.jobAccum - size);
        bumpDelta(deltas, rc.id, 'ar');
        bumpDelta(deltas, jc.id, 'aj');
        added++;
        rc.need -= size;
        jc.need -= size;
      } else { ri++; continue; }
    }
    if (rc.need <= 0) ri++;
    if (jc.need <= 0) ji++;
  }

  // C. decay — only occupied sites can decay. Size-aware: a pop is shed only when
  // the accumulated deficit covers its FULL size (the churn deadband, per pop),
  // and the accumulator is credited that pop's actual size (crumb or whole).
  let removed = 0;
  for (const s of sites) {
    if (!s.pointId) continue;
    const e = ledger.points[s.pointId];
    if (!e) continue;
    while (e.resAccum < 0) {
      const id = findInduced(dd, ledger, s.pointId, 'residence', addedThisDay);
      if (!id) { e.resAccum = Math.max(e.resAccum, -cfg.POP_SIZE + 1); break; }
      const size = dd.popsMap.get(id)?.size ?? cfg.POP_SIZE;
      if (e.resAccum > -size) break; // deficit doesn't cover this pop — hold it
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.resAccum += size;
      removed++;
    }
    while (e.jobAccum < 0) {
      const id = findInduced(dd, ledger, s.pointId, 'job', addedThisDay);
      if (!id) { e.jobAccum = Math.max(e.jobAccum, -cfg.POP_SIZE + 1); break; }
      const size = dd.popsMap.get(id)?.size ?? cfg.POP_SIZE;
      if (e.jobAccum > -size) break; // deficit doesn't cover this pop — hold it
      recordRemoval(dd, deltas, id);
      deferInducedPopRemoval(dd, ledger, id, cfg);
      e.jobAccum += size;
      removed++;
    }
  }

  // D. Voronoi subdivision (spec 2026-07-18): split pressure accrues in DAYS,
  // scaled by how UNDER-SUBDIVIDED a cell is. Each day a cell adds
  // `excess × fill`, where excess = supportedMass/capTotal − 1 is how many EXTRA
  // anchor-loads the cell supports beyond its single anchor (unbounded), and
  // fill (0..1) is how full that anchor is. So a big cell — a new station's
  // catchment whose nearest anchor is far, supporting many anchor-loads — reaches
  // the TARGET_SPLIT_DAYS threshold in ~a day, while a right-sized dense cell
  // (excess ≈ 0) barely accrues and densifies via pop growth instead. Still
  // city-independent (excess is a ratio) and persisted pressures stay in days.
  let newPoints = 0;
  let readyCells = 0;
  let nullCuts = 0;
  if (deps.cells) {
    if (!ledger.cells) ledger.cells = {};
    // prune pressure for anchors that no longer exist
    for (const id of Object.keys(ledger.cells)) {
      if (!dd.points.has(id)) delete ledger.cells[id];
    }
    const ready: { id: string; pressure: number; centroid: Coordinate }[] = [];
    for (const [id, integral] of deps.cells) {
      const p = dd.points.get(id);
      if (!p || !integral.centroid || integral.supportedMass <= 0) continue;
      // Readiness is measured against ONE materialized point's worth of mass
      // (pointCap = massAt at the anchor's access), NOT the anchor's baseline cap.
      // supportedMass/pointCap ≈ cell-area / spacing² = how many points the cell's
      // area wants at the access-appropriate density, so a cell reads
      // "over-subdivided" only when there's genuinely room for another point
      // ≥ spacing from the existing ones — readiness ⟺ placeability. (Measuring
      // against the baseline cap instead made low-baseline anchors in already-
      // dense areas read a huge FALSE excess they could never place a cut for:
      // deep-purple cells stuck at max pressure that never split. It also lets a
      // greenfield anchor — no baseline — split on access, same formula.)
      if (integral.pointCap <= 0) continue;
      const excess = Math.max(0, integral.supportedMass / integral.pointCap - 1); // extra points the area wants
      // fill = native-first gate: densify the existing anchor before spreading.
      // Greenfield (no baseline cap) has nothing to densify, so it's ungated.
      const nativeCap = (capRes.get(id) ?? 0) + (capJob.get(id) ?? 0);
      const fill = nativeCap > 0 ? Math.min(1, Math.max(0, (p.residents + p.jobs) / nativeCap)) : 1; // 0..1
      // Population-density HEADROOM gate: a cell stops accruing where local
      // people-per-area already meets the target, so an already-dense city adds
      // few new points while a sparse one subdivides toward it. clamp01(1 −
      // localDensity/target); absent popDensity or target ≤ 0 → ungated (1).
      const targetPerM2 = cfg.TARGET_POP_DENSITY_PER_KM2 / 1e6;
      const headroom = deps.popDensity && targetPerM2 > 0
        ? Math.max(0, 1 - (deps.popDensity(p.location) / targetPerM2))
        : 1;
      // Net accrual with decay: a cell must be SUSTAINABLY over-subdivided
      // (excess·fill·headroom above SPLIT_PRESSURE_DECAY) to build pressure.
      // Marginal cells relax to 0 instead of creeping to the threshold and
      // sticking uncuttable.
      const next = Math.max(0, Math.min(
        cfg.TARGET_SPLIT_DAYS,
        (ledger.cells[id] ?? 0) + excess * fill * headroom - cfg.SPLIT_PRESSURE_DECAY,
      ));
      if (next !== 0) ledger.cells[id] = next; else delete ledger.cells[id];
      if (next >= cfg.TARGET_SPLIT_DAYS) ready.push({ id, pressure: next, centroid: integral.centroid });
    }
    ready.sort((a, b) => (b.pressure - a.pressure) || (a.id < b.id ? -1 : 1));
    readyCells = ready.length;

    // No daily split cap: every placeable ready cell splits this day. The
    // readiness gate (excess·fill → TARGET_SPLIT_DAYS) already decides WHICH
    // cells are over-subdivided enough to split. A cell whose cut is currently
    // unplaceable (findCut null: no valid sample ≥ spacing from existing points,
    // water, or an elongated cell the search disc misses) is SKIPPED — its
    // pressure stays capped and it retries when geometry/access changes.
    for (const cell of ready) {
      const cut = deps.findCut(cell.id, cell.centroid);
      if (!cut) { nullCuts++; continue; }
      const pid = `${INDUCED_POINT_PREFIX}${ledger.ptSeq ?? 0}`;
      ledger.ptSeq = (ledger.ptSeq ?? 0) + 1;
      createInducedPoint(dd, pid, cut);
      if (!ledger.materialized) ledger.materialized = {};
      ledger.materialized[pid] = { location: [cut[0], cut[1]] };
      // Starts empty; it earns its pops naturally over the next days (boosted by
      // NEW_POINT_GROWTH_BOOST in section A), rather than from an artificial seed.
      ledger.points[pid] = { baselineResidents: 0, baselineJobs: 0, resAccum: 0, jobAccum: 0 };
      ledger.cells[cell.id] -= cfg.TARGET_SPLIT_DAYS;
      if (ledger.cells[cell.id] === 0) delete ledger.cells[cell.id];
      newPoints++;
    }
  }

  return { added, removed, newPoints, readyCells, nullCuts, deltas };
}

/** Stable uniform in [0,1) from a string id (FNV-1a) — a point's fixed draw. */
export function hashU(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/**
 * Cap-draw quantile for a materialized point: blends its access with a stable
 * per-point hash, `bias·access + (1−bias)·hash(id)`, clamped to [0,1]. Higher
 * access leans the draw toward the tail (large cap) while the hash preserves a
 * spread. Exported for testing.
 */
export function capDrawU(access: number, id: string, cfg: InducedDemandConfig): number {
  const bias = cfg.SPLIT_CAP_ACCESS_BIAS;
  return clamp(bias * access + (1 - bias) * hashU(id), 0, 1);
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
