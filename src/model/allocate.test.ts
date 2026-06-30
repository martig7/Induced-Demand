import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, allocateInteger } from './allocate';

test('reconcile rules', () => {
  assert.equal(reconcile(10, 20, 'average'), 15);
  assert.equal(reconcile(10, 20, 'min'), 10);
  assert.equal(reconcile(10, 20, 'residential'), 10);
  assert.equal(reconcile(10, 20, 'commercial'), 20);
});

test('allocateInteger: proportional, sums to total', () => {
  assert.deepEqual(allocateInteger([1, 1], 4, [10, 10]), [2, 2]);
  assert.deepEqual(allocateInteger([3, 1], 4, [10, 10]), [3, 1]);
});

test('allocateInteger: respects per-point caps', () => {
  assert.deepEqual(allocateInteger([1, 1], 10, [2, 2]), [2, 2]); // capped to 4 total
});

test('allocateInteger: zero weights -> zeros', () => {
  assert.deepEqual(allocateInteger([0, 0], 5, [3, 3]), [0, 0]);
});

test('allocateInteger: distributes remainder by largest fraction', () => {
  const r = allocateInteger([1, 1], 3, [9, 9]);
  assert.equal(r[0] + r[1], 3);
  assert.ok(Math.abs(r[0] - r[1]) === 1);
});
