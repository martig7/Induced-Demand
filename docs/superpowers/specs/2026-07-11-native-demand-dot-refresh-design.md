# Native demand-dot refresh for induced demand — design

**Date:** 2026-07-11
**Status:** approved (Approach A)

## Problem

Induced demand already feeds the game's native demand-dot sizes: the deck.gl
demand layer (`DeckglDemandLayer` in `GameMain-*.js`) sizes unselected dots from
the live `point.residents` / `point.jobs` in `useMainStore.demandData` — the
exact fields this mod increments per induced pop
(`size = √(value/π) × k × demandBubbleScale`, or a log curve behind the
`DEMAND_DOT_SCALING` feature flag).

But the layer re-renders only when a *reference* it subscribes to changes
(demandData object swap, navigation/selection state, `demandBubbleScale`, …).
The mod mutates points in place, so dot sizes are stale snapshots from the last
recompute — a user comparing dots after induced growth sees pre-induction
sizes. (Also noted: any point *selection* switches all dots to a commute-flow
sizing mode where residents are irrelevant; selected dots are pinned to
size 80. Measurements must be taken with nothing selected.)

## Goal

After days where the mod adds or removes induced pops, force the native demand
layer to recompute so open demand views reflect current residents/jobs — with
no visible side effect.

## Approach

`demandBubbleScale` is a memo dependency reachable through the modding API
(`actions.setDemandBubbleScale`, validated positive finite, clamped by the
game; store update only notifies when the value actually changes). Toggle it
imperceptibly between a base value and `base × (1 ∓ 1e-6)`:

- **Pure logic** in `src/overlay/demandDotRefresh.ts`:
  `nextNudge(current, prev)` returns the next scale to set plus the state to
  remember `{ base, lastSet }`.
  - If `current !== prev.lastSet`, the user (or game) changed the scale —
    adopt `base = current`.
  - Toggle: when `current === base`, set `base × (1 − 1e-6)` for `base ≥ 1`
    (or `× (1 + 1e-6)` for smaller bases, keeping clear of the game's clamp
    bounds); otherwise set back to exactly `base`.
  - The returned value always differs from `current` (a same-value set would
    not notify subscribers).
- **Wiring** in `main.ts` `onDayChange`: when `runDay` reports
  `added > 0 || removed > 0`, read `actions.getDemandBubbleScale()`, compute
  the nudge, call `actions.setDemandBubbleScale(...)`. Feature-detect both
  methods (try/catch, skip silently when absent). Nudge state is module-local;
  after a mod reload the first nudge just re-adopts the current scale.
- **Typings:** add `setDemandBubbleScale` / `getDemandBubbleScale` to
  `actions` in `src/types/api.d.ts`.

Load-time apply paths need no nudge: a real load replaces `demandData`, which
re-renders the layer by itself.

## Non-goals

- Induced-only dot sizing in the native layer (formula is compiled into the
  game; not moddable).
- Changing the user's chosen bubble scale (drift bounded at one part in 10⁶,
  and each toggle returns to the exact base).

## Verification

1. In-game DevTools snippet (run with a demand view open, nothing selected):
   read a high-induction point's live `residents` and confirm it exceeds its
   baseline (i.e. induced demand is in the store the dots read).
2. With the demand map open across several game days of growth, dots at
   high-induction points visibly grow without closing the panel.
3. Unit tests for `nextNudge` (adoption, toggle, always-differs, clamp-safe
   direction).

## Testing

`node:test` unit tests for the pure module; existing suite + typecheck + build
must stay green.
