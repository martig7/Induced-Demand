import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushDayHistory, HISTORY_DAYS, type DayHistoryEntry } from './history';

function entry(day: number, added = 0, removed = 0): DayHistoryEntry {
  return { day, added, removed, deltas: {} };
}

test('pushDayHistory appends newest-last and keeps zero-activity days', () => {
  let list: DayHistoryEntry[] = [];
  list = pushDayHistory(list, entry(10, 5, 0));
  list = pushDayHistory(list, entry(11, 0, 0)); // zero day kept
  list = pushDayHistory(list, entry(12, 0, 3));
  assert.deepEqual(list.map((e) => e.day), [10, 11, 12]);
});

test('pushDayHistory replaces a same-day entry (duplicate onDayChange)', () => {
  let list: DayHistoryEntry[] = [entry(10, 1, 0)];
  list = pushDayHistory(list, entry(10, 4, 2));
  assert.equal(list.length, 1);
  assert.equal(list[0].added, 4);
});

test('pushDayHistory truncates future entries when the game clock rewinds (save reload)', () => {
  let list: DayHistoryEntry[] = [entry(10), entry(11), entry(12), entry(13)];
  list = pushDayHistory(list, entry(11, 9, 0)); // reloaded an older save, day 11 again
  assert.deepEqual(list.map((e) => e.day), [10, 11]);
  assert.equal(list[1].added, 9); // stale days 12/13 dropped
});

test('pushDayHistory caps at HISTORY_DAYS, dropping the oldest', () => {
  let list: DayHistoryEntry[] = [];
  for (let d = 1; d <= HISTORY_DAYS + 5; d++) list = pushDayHistory(list, entry(d));
  assert.equal(list.length, HISTORY_DAYS);
  assert.equal(list[0].day, 6);
  assert.equal(list[list.length - 1].day, HISTORY_DAYS + 5);
});

test('pushDayHistory does not mutate its input', () => {
  const original: DayHistoryEntry[] = [entry(10)];
  const result = pushDayHistory(original, entry(11));
  assert.equal(original.length, 1);
  assert.equal(result.length, 2);
});
