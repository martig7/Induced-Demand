import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeSlots, buildSlotSet, pickDeparture, commuteTimesFor,
  DEFAULT_COMMUTE_RANGES, DEFAULT_SLOT_SET, MIN_GAP_SECONDS,
  AIRPORT_PREFIX, UNIVERSITY_PREFIX,
} from './commuteTimes';
import { makeRng } from './gravity';

/**
 * Reference values below were produced by RUNNING the game's own
 * generateTimeSlots/generateDepartureTimeBasedOnDemand (v1.4.10, extracted from the
 * renderer bundle) — see docs/DEMAND_API.md. They are the contract we emulate.
 */
const pct = (slots: { startHour: number; endHour: number; probability: number }[]): string =>
  slots.map((b) => `${b.startHour}-${b.endHour}@${(b.probability * 100).toFixed(2)}`).join(' ');

test('default home slots match the game exactly', () => {
  const s = buildTimeSlots(DEFAULT_COMMUTE_RANGES, {});
  assert.equal(
    pct(s.home),
    '0-3@2.63 3-6@5.26 6-7@5.85 7-10@43.86 10-11@5.85 11-16@23.39 16-23@12.28 23-24@0.88',
  );
});

test('default work slots match the game exactly (evening peak mirrors morning)', () => {
  const s = buildTimeSlots(DEFAULT_COMMUTE_RANGES, {});
  assert.equal(
    pct(s.work),
    '0-3@2.63 3-10@12.28 10-15@23.39 15-16@5.85 16-19@43.86 19-20@5.85 20-23@5.26 23-24@0.88',
  );
});

test('probabilities are normalized to 1 for both directions', () => {
  const s = buildTimeSlots(DEFAULT_COMMUTE_RANGES, {});
  for (const kind of ['home', 'work'] as const) {
    const total = s[kind].reduce((a, b) => a + b.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${kind} sums to ${total}`);
  }
});

test('airport slots are dampened and mirrored (home === work) like the game', () => {
  const s = buildTimeSlots(DEFAULT_COMMUTE_RANGES, { dampened: 0.5, mirrored: true });
  assert.equal(
    pct(s.home),
    '0-3@7.57 3-6@8.88 6-7@3.98 7-10@18.53 10-11@4.71 11-15@17.69 15-16@4.71 16-19@18.53 19-20@3.98 20-23@8.88 23-24@2.52',
  );
  assert.equal(pct(s.work), pct(s.home));
});

test('university slots are dampened toward flat like the game', () => {
  const s = buildTimeSlots(DEFAULT_COMMUTE_RANGES, { dampened: 0.3 });
  assert.equal(
    pct(s.home),
    '0-3@5.59 3-6@7.43 6-7@5.34 7-10@34.45 10-11@5.34 11-16@22.62 16-23@17.35 23-24@1.86',
  );
});

test('buildSlotSet applies the right dampening per job kind', () => {
  const set = buildSlotSet({ studentDampening: 0.3, airportDampening: 0.5 });
  assert.equal(pct(set.normal.home), pct(buildTimeSlots(DEFAULT_COMMUTE_RANGES, {}).home));
  assert.equal(pct(set.airport.home), pct(set.airport.work)); // mirrored
  assert.equal(pct(set.university.home), pct(buildTimeSlots(DEFAULT_COMMUTE_RANGES, { dampened: 0.3 }).home));
});

test('buildSlotSet honors custom ranges (another mod may replace them)', () => {
  const custom = [
    { start: 0, end: 12, homeDemandMultiplier: 1, workDemandMultiplier: 1 },
    { start: 12, end: 24, homeDemandMultiplier: 3, workDemandMultiplier: 1 },
  ];
  const s = buildSlotSet({ ranges: custom });
  assert.equal(pct(s.normal.home), '0-12@25.00 12-24@75.00');
  assert.equal(pct(s.normal.work), '0-24@100.00');
});

test('pickDeparture stays inside its bin and returns seconds within the day', () => {
  const slots = buildTimeSlots(DEFAULT_COMMUTE_RANGES, {});
  const rng = makeRng(42);
  for (let i = 0; i < 2000; i++) {
    const t = pickDeparture('home', slots, rng);
    assert.ok(t >= 0 && t < 86400, `out of day: ${t}`);
    const bin = slots.home.find((b) => t >= b.startHour * 3600 && t <= b.endHour * 3600 - 1);
    assert.ok(bin, `t=${t} fell outside every bin`);
  }
});

test('home departures follow the game distribution (~44% in the 7-10h peak)', () => {
  const slots = buildTimeSlots(DEFAULT_COMMUTE_RANGES, {});
  const rng = makeRng(7);
  const N = 20000;
  let peak = 0, night = 0;
  for (let i = 0; i < N; i++) {
    const h = pickDeparture('home', slots, rng) / 3600;
    if (h >= 7 && h < 10) peak++;
    if (h >= 0 && h < 3) night++;
  }
  assert.ok(Math.abs(peak / N - 0.4386) < 0.02, `peak share ${peak / N}`);
  assert.ok(Math.abs(night / N - 0.0263) < 0.01, `night share ${night / N}`);
});

test('commuteTimesFor is deterministic per pop id', () => {
  const a = commuteTimesFor('induced:1', 'p', DEFAULT_SLOT_SET);
  const b = commuteTimesFor('induced:1', 'p', DEFAULT_SLOT_SET);
  assert.deepEqual(a, b);
  const c = commuteTimesFor('induced:2', 'p', DEFAULT_SLOT_SET);
  assert.notDeepEqual(a, c);
});

test('commuteTimesFor always respects the game 90 minute minimum gap', () => {
  for (let i = 0; i < 3000; i++) {
    const { homeDepartureTime, workDepartureTime } = commuteTimesFor(`induced:${i}`, 'p', DEFAULT_SLOT_SET);
    assert.ok(Math.abs(workDepartureTime - homeDepartureTime) >= MIN_GAP_SECONDS,
      `gap too small at ${i}: ${homeDepartureTime} / ${workDepartureTime}`);
    for (const t of [homeDepartureTime, workDepartureTime]) {
      assert.ok(Number.isFinite(t) && t >= 0 && t < 86400, `bad time ${t}`);
    }
  }
});

test('commuteTimesFor picks slots by job id prefix like the game', () => {
  // Airport/university pops draw from their own (dampened) distributions, so over
  // many pops their peak share differs from the normal one.
  const share = (jobId: string): number => {
    let peak = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const h = commuteTimesFor(`induced:${i}`, jobId, DEFAULT_SLOT_SET).homeDepartureTime / 3600;
      if (h >= 7 && h < 10) peak++;
    }
    return peak / N;
  };
  const normal = share('p');
  const airport = share(`${AIRPORT_PREFIX}1`);
  const uni = share(`${UNIVERSITY_PREFIX}1`);
  assert.ok(Math.abs(normal - 0.4386) < 0.03, `normal ${normal}`);
  assert.ok(Math.abs(airport - 0.1853) < 0.03, `airport ${airport}`);
  assert.ok(Math.abs(uni - 0.3445) < 0.03, `uni ${uni}`);
});
