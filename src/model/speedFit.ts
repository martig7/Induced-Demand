/**
 * Calibrate road-class speeds against the city's own pops.
 *
 * Every native pop is a labelled example: routing its residence→job pair gives the
 * metres spent on each road class, and the pop already carries the answer the game's
 * offline router produced (`drivingSeconds`). Least squares on
 *   seconds ≈ Lhighway·x0 + Lmajor·x1 + Lminor·x2      (xi = 1 / speed_i)
 * therefore recovers the speed profile that reproduces the game's own timings —
 * per city, with no constants to guess. On Denver this converges to
 * highway 20.3, major 12.7, minor 8.4 m/s.
 */
import type { Coordinate } from '../types/core';
import { createRouter, DEFAULT_SPEEDS, type Speeds } from './router';
import { snapToNode, type RoadGraph } from './roadGraph';

export interface FitSample {
  /** Metres per road class, [highway, major, minor]. */
  classLengths: [number, number, number];
  /** The game's own driving time for this pair. */
  seconds: number;
}

const MIN_SAMPLES = 10;
const MIN_SPEED = 2;
const MAX_SPEED = 45;

/** Solve a 3x3 system by Gaussian elimination with partial pivoting. */
function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[pivot][i])) pivot = k;
    if (Math.abs(m[pivot][i]) < 1e-9) return null; // singular
    [m[i], m[pivot]] = [m[pivot], m[i]];
    for (let k = i + 1; k < 3; k++) {
      const f = m[k][i] / m[i][i];
      for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let sum = m[i][3];
    for (let j = i + 1; j < 3; j++) sum -= m[i][j] * x[j];
    x[i] = sum / m[i][i];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

export function fitSpeeds(samples: readonly FitSample[]): Speeds {
  const usable = samples.filter(
    (s) => Number.isFinite(s.seconds) && s.seconds > 0
      && s.classLengths.every((l) => Number.isFinite(l) && l >= 0)
      && s.classLengths.some((l) => l > 0),
  );
  if (usable.length < MIN_SAMPLES) return DEFAULT_SPEEDS;

  // Normal equations for the least-squares fit of the inverse speeds.
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const atb = [0, 0, 0];
  for (const s of usable) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) ata[i][j] += s.classLengths[i] * s.classLengths[j];
      atb[i] += s.classLengths[i] * s.seconds;
    }
  }
  const inverse = solve3(ata, atb);
  if (!inverse) return DEFAULT_SPEEDS;

  const clamp = (v: number): number => Math.max(MIN_SPEED, Math.min(MAX_SPEED, v));
  const speed = (inv: number, fallback: number): number =>
    inv > 0 && Number.isFinite(inv) ? clamp(1 / inv) : fallback;
  return {
    highway: speed(inverse[0], DEFAULT_SPEEDS.highway),
    major: speed(inverse[1], DEFAULT_SPEEDS.major),
    minor: speed(inverse[2], DEFAULT_SPEEDS.minor),
  };
}

/**
 * Median of routed/real. The least-squares fit minimizes absolute error, which leaves
 * the ratio slightly off-centre (0.94 on Denver); scaling speeds by this puts the
 * median back on 1.00, and the median is what biases mode choice.
 */
export function medianRatio(pairs: readonly { routed: number; real: number }[]): number {
  const ratios = pairs
    .filter((p) => p.real > 0 && Number.isFinite(p.routed) && Number.isFinite(p.real))
    .map((p) => p.routed / p.real)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return 1;
  const mid = ratios.length >> 1;
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

/** Scale a speed profile by a correction factor, keeping it in the sane range. */
export function scaleSpeeds(speeds: Speeds, factor: number): Speeds {
  if (!Number.isFinite(factor) || factor <= 0) return speeds;
  const clamp = (v: number): number => Math.max(MIN_SPEED, Math.min(MAX_SPEED, v * factor));
  return { highway: clamp(speeds.highway), major: clamp(speeds.major), minor: clamp(speeds.minor) };
}


/** A native pop reduced to what calibration needs: its endpoints and the game's own time. */
export interface CalibrationPair {
  residence: Coordinate;
  job: Coordinate;
  seconds: number;
}

/**
 * Fit road-class speeds so routing this city reproduces the game's own driving times.
 *
 * Two passes: the first routes with a guess to learn which classes each trip uses, the
 * second re-routes with the fitted speeds (better speeds change the routes themselves).
 * Then scale so the MEDIAN routed/real ratio lands on 1 — least squares minimizes
 * absolute error, which leaves the median ~6% fast, and the median is what biases the
 * game's mode choice.
 */
export function calibrateSpeeds(graph: RoadGraph, pairs: readonly CalibrationPair[]): Speeds {
  if (pairs.length === 0) return DEFAULT_SPEEDS;

  const measure = (speeds: Speeds): { samples: FitSample[]; ratios: { routed: number; real: number }[] } => {
    const router = createRouter(graph, speeds);
    const samples: FitSample[] = [];
    const ratios: { routed: number; real: number }[] = [];
    for (const pair of pairs) {
      const from = snapToNode(graph, pair.residence);
      const to = snapToNode(graph, pair.job);
      if (!from || !to) continue;
      const r = router.route(from.node, to.node);
      if (!r || !(r.seconds > 0)) continue;
      samples.push({ classLengths: r.classLengths, seconds: pair.seconds });
      ratios.push({ routed: r.seconds, real: pair.seconds });
    }
    return { samples, ratios };
  };

  let speeds = DEFAULT_SPEEDS;
  for (let pass = 0; pass < 2; pass++) speeds = fitSpeeds(measure(speeds).samples);
  return scaleSpeeds(speeds, medianRatio(measure(speeds).ratios));
}

/** Hand control back to the host between chunks of work. */
export type Yield = () => Promise<void>;
const macrotask: Yield = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Same fit, but yields every `chunk` routes.
 *
 * Calibration is ~900 A* queries — 3-5 seconds of straight-line JS, which would freeze
 * the renderer if run in one go. Callers in the game must use this variant; the
 * synchronous one is for tests and offline harnesses.
 */
export async function calibrateSpeedsAsync(
  graph: RoadGraph,
  pairs: readonly CalibrationPair[],
  opts: { chunk?: number; onYield?: Yield } = {},
): Promise<Speeds> {
  if (pairs.length === 0) return DEFAULT_SPEEDS;
  const chunk = opts.chunk ?? 25;
  const breathe = opts.onYield ?? macrotask;

  const measure = async (speeds: Speeds): Promise<{ samples: FitSample[]; ratios: { routed: number; real: number }[] }> => {
    const router = createRouter(graph, speeds);
    const samples: FitSample[] = [];
    const ratios: { routed: number; real: number }[] = [];
    let since = 0;
    for (const pair of pairs) {
      if (++since >= chunk) { since = 0; await breathe(); }
      const from = snapToNode(graph, pair.residence);
      const to = snapToNode(graph, pair.job);
      if (!from || !to) continue;
      const r = router.route(from.node, to.node);
      if (!r || !(r.seconds > 0)) continue;
      samples.push({ classLengths: r.classLengths, seconds: pair.seconds });
      ratios.push({ routed: r.seconds, real: pair.seconds });
    }
    return { samples, ratios };
  };

  let speeds = DEFAULT_SPEEDS;
  for (let pass = 0; pass < 2; pass++) speeds = fitSpeeds((await measure(speeds)).samples);
  return scaleSpeeds(speeds, medianRatio((await measure(speeds)).ratios));
}
