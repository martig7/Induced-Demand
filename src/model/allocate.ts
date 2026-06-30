import type { ReconcileRule } from './config';

/** Reconcile residential vs commercial pressure into one common total. */
export function reconcile(rp: number, jp: number, rule: ReconcileRule): number {
  switch (rule) {
    case 'min': return Math.min(rp, jp);
    case 'residential': return rp;
    case 'commercial': return jp;
    case 'average':
    default: return (rp + jp) / 2;
  }
}

/**
 * Largest-remainder apportionment of `total` integer units across indices,
 * proportional to non-negative `weights`, capped per index by `perPointMax`.
 * Result sums to min(total, sum(perPointMax)).
 */
export function allocateInteger(
  weights: number[],
  total: number,
  perPointMax: number[],
): number[] {
  const n = weights.length;
  const result = new Array<number>(n).fill(0);
  const caps = perPointMax.map((c) => Math.max(0, Math.floor(c)));
  const capSum = caps.reduce((a, b) => a + b, 0);
  const remaining = Math.min(Math.max(0, Math.floor(total)), capSum);
  const w = weights.map((x) => Math.max(0, x));
  const wSum = w.reduce((a, b) => a + b, 0);
  if (remaining <= 0 || wSum <= 0) return result;

  const frac: { i: number; f: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ideal = (remaining * w[i]) / wSum;
    result[i] = Math.min(Math.floor(ideal), caps[i]);
    frac.push({ i, f: ideal - Math.floor(ideal) });
  }
  let leftover = remaining - result.reduce((a, b) => a + b, 0);
  frac.sort((a, b) => b.f - a.f);
  while (leftover > 0) {
    let placed = false;
    for (const { i } of frac) {
      if (result[i] < caps[i]) {
        result[i]++; leftover--; placed = true;
        if (leftover === 0) break;
      }
    }
    if (!placed) break;
  }
  return result;
}
