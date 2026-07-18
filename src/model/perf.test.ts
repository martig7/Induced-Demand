import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPerfTracker } from './perf';

test('track: runs fn, records ms, logs summary line', () => {
  const logs: string[] = [];
  const warns: string[] = [];
  let t = 0;
  const perf = createPerfTracker((m) => logs.push(m), (m) => warns.push(m), () => (t += 5));
  const out = perf.track('fit', 100, () => 42, () => '6k pts');
  assert.equal(out, 42);
  assert.equal(perf.last.fit.ms, 5);
  assert.equal(perf.last.fit.info, '6k pts');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fit/);
  assert.match(logs[0], /5\.0ms/);
  assert.equal(warns.length, 0);
});

test('track: budget breach warns', () => {
  const warns: string[] = [];
  let t = 0;
  const perf = createPerfTracker(() => {}, (m) => warns.push(m), () => (t += 200));
  perf.track('tier1', 100, () => null);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /tier1/);
  assert.match(warns[0], /budget 100ms/);
});

test('track: fn throwing still records timing, rethrows', () => {
  let t = 0;
  const perf = createPerfTracker(() => {}, () => {}, () => (t += 3));
  assert.throws(() => perf.track('x', 100, () => { throw new Error('boom'); }));
  assert.equal(perf.last.x.ms, 3);
});

test('summary: compact one-liner of last runs', () => {
  let t = 0;
  const perf = createPerfTracker(() => {}, () => {}, () => (t += 2));
  perf.track('a', 100, () => 0);
  perf.track('b', 100, () => 0);
  assert.match(perf.summary(), /a 2\.0ms · b 2\.0ms/);
});

test('record: externally-measured duration logs, stores, and budgets like track', () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const perf = createPerfTracker((m) => logs.push(m), (m) => warns.push(m), () => 0);
  perf.record('tier1', 100, 250.5, '3 chunks');
  assert.equal(perf.last.tier1.ms, 250.5);
  assert.equal(perf.last.tier1.info, '3 chunks');
  assert.match(logs[0], /tier1 250\.5ms \(3 chunks\)/);
  assert.equal(warns.length, 1);
});
