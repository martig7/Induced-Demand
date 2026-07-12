/**
 * Imperceptible demandBubbleScale toggle that forces the game's native demand-dot
 * layer to recompute. The layer sizes unselected dots from live point residents/jobs
 * but only re-renders when a subscribed REFERENCE changes; this mod mutates points in
 * place, so after days that add/remove induced pops the dots show stale sizes.
 * `demandBubbleScale` is the one memo dependency reachable through the modding API
 * (`actions.setDemandBubbleScale`) — flipping it between the base value and
 * base × (1 ∓ 1e-6) re-triggers the layer without a visible size change.
 * See docs/superpowers/specs/2026-07-11-native-demand-dot-refresh-design.md.
 */
export interface NudgeState {
  /** The scale the user actually chose; every second nudge restores it exactly. */
  base: number;
  /** What we last set — detects when the user moved the scale in between. */
  lastSet: number;
}

const EPSILON = 1e-6;

export function nextNudge(current: number, prev: NudgeState | null): NudgeState & { set: number } {
  // Adopt the live scale as base unless it is exactly our own last nudge.
  const base = prev !== null && current === prev.lastSet ? prev.base : current;
  // Toggle off the base (away from the game's clamp bounds) or back to it exactly.
  // The result always differs from `current` — a same-value set would not notify
  // the store and the layer would not recompute.
  const set = current === base
    ? (base >= 1 ? base * (1 - EPSILON) : base * (1 + EPSILON))
    : base;
  return { base, lastSet: set, set };
}
