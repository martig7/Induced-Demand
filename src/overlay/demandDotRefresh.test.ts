import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextNudge, type NudgeState } from './demandDotRefresh';

// The native demand-dot layer only recomputes when a subscribed reference changes;
// demandBubbleScale is the one dependency the modding API can touch. nextNudge toggles
// the scale between the user's base value and an imperceptible offset so the layer
// re-reads live residents/jobs. See docs/superpowers/specs/2026-07-11-*.md.

test('first nudge adopts the current scale as base and offsets it imperceptibly', () => {
  const r = nextNudge(1, null);
  assert.equal(r.base, 1);
  assert.notEqual(r.set, 1);            // a same-value set would not notify the store
  assert.ok(Math.abs(r.set - 1) < 1e-5); // imperceptible
  assert.equal(r.lastSet, r.set);
});

test('second nudge toggles back to the exact base (no drift)', () => {
  const first = nextNudge(1, null);
  const second = nextNudge(first.set, first);
  assert.equal(second.set, 1);          // restored exactly
  assert.notEqual(second.set, first.set);
});

test('adopts a user-changed scale instead of fighting it', () => {
  const first = nextNudge(1, null);
  // user moved the vanilla slider to 2.5 since our last nudge
  const r = nextNudge(2.5, first);
  assert.equal(r.base, 2.5);
  assert.ok(Math.abs(r.set - 2.5) < 1e-5);
  assert.notEqual(r.set, 2.5);
});

test('nudges downward for base >= 1 and upward below 1, staying clear of the clamp bounds', () => {
  assert.ok(nextNudge(4, null).set < 4);   // at a high scale, never nudge further up
  assert.ok(nextNudge(0.25, null).set > 0.25); // at a low scale, never nudge further down
});

test('returned set always differs from current across repeated cycles', () => {
  let state: NudgeState | null = null;
  let current = 1.3;
  for (let i = 0; i < 6; i++) {
    const r: ReturnType<typeof nextNudge> = nextNudge(current, state);
    assert.notEqual(r.set, current);
    state = r;
    current = r.set;
  }
});
