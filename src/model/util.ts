export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
