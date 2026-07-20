import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

/** Deterministic mulberry32 PRNG in [0,1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pair each residence id with a job id drawn (without replacement) with
 * probability ∝ 1 / dist^BETA. Returns min(pool lengths) [residence, job] pairs.
 */
export function pairByGravity(
  residencePool: string[],
  jobPool: string[],
  locations: Map<string, Coordinate>,
  cfg: InducedDemandConfig,
  rng: () => number,
): [string, string][] {
  const jobs = [...jobPool];
  const pairs: [string, string][] = [];
  for (const h of residencePool) {
    if (jobs.length === 0) break;
    const hLoc = locations.get(h);
    if (!hLoc) continue;
    // Exclude the residence's OWN point from its job choices: a residence==job
    // pair is a zero-distance self-commute that the game routes as a walk — the
    // opposite of induced transit demand (it was showing up on fresh split
    // points, which accrue both sides and would otherwise pair with themselves).
    const weights = jobs.map((w) => {
      if (w === h) return 0;
      const wLoc = locations.get(w);
      if (!wLoc) return 0;
      const d = Math.max(cfg.DIST_MIN, haversine(hLoc, wLoc));
      return 1 / Math.pow(d, cfg.BETA);
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) continue; // only self (or unplaceable) jobs available — leave h for a later day
    let idx = 0;
    let r = rng() * sum;
    for (; idx < weights.length; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    if (idx >= jobs.length) idx = jobs.length - 1;
    pairs.push([h, jobs[idx]]);
    jobs.splice(idx, 1);
  }
  return pairs;
}
