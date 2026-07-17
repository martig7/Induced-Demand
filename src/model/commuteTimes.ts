/**
 * Commute departure times for induced pops, emulating the game's own generator.
 *
 * Reverse-engineered from the v1.4.10 renderer bundle (`assignCommuteTimes`,
 * `generateTimeSlots`, `generateDepartureTimeBasedOnDemand`) and verified by running
 * that code directly — see docs/DEMAND_API.md. The game builds a per-hour demand
 * multiplier from the active time-of-day ranges, run-length-encodes contiguous equal
 * hours into bins, and normalizes each bin to `multiplier × width / Σ(multiplier × width)`.
 * A departure picks a bin by probability, an hour uniformly inside it, a uniform second
 * inside that hour, then adds ±450 s of jitter clamped to the bin. Work departures are
 * redrawn until they are at least MIN_GAP_SECONDS from the home departure.
 *
 * Pops whose job point is an airport (`AIR_`) or university (`UNI_`) draw from dampened
 * variants, exactly as the game does.
 */
import { makeRng } from './gravity';

/** One entry of the game's time-of-day table (`api.popTiming.getCommuteTimeRanges()`). */
export interface CommuteRange {
  start: number;
  end: number;
  homeDemandMultiplier: number;
  workDemandMultiplier: number;
}

export interface TimeSlot {
  startHour: number;
  endHour: number;
  /** Share of departures falling in this bin; sums to 1 across a direction. */
  probability: number;
}

export interface TimeSlots {
  home: TimeSlot[];
  work: TimeSlot[];
}

/** Slot variants the game keeps for the three pop kinds. */
export interface SlotSet {
  normal: TimeSlots;
  airport: TimeSlots;
  university: TimeSlots;
}

// Game constants (verbatim).
const VERY_LOW = 0.15, LOW = 0.3, LOW_MEDIUM = 0.8, MEDIUM = 1, HIGH = 2.5;
export const MIN_GAP_SECONDS = 90 * 60;
export const DEFAULT_STUDENT_DAMPENING = 0.3;
export const DEFAULT_AIRPORT_DAMPENING = 0.5;
export const AIRPORT_PREFIX = 'AIR_';
export const UNIVERSITY_PREFIX = 'UNI_';
const HOURS = 24;
const SECONDS_PER_HOUR = 3600;
/** Jitter is (rand − 0.5) × 30, then × 30 seconds in the game: ±450 s. */
const JITTER_SPAN_SECONDS = 900;
const MAX_WORK_DRAWS = 100;
const MAX_HOME_REDRAWS = 10;

/** The game's default time-of-day table (fallback when the API is unavailable). */
export const DEFAULT_COMMUTE_RANGES: readonly CommuteRange[] = [
  { start: 0, end: 3, homeDemandMultiplier: VERY_LOW, workDemandMultiplier: VERY_LOW },
  { start: 3, end: 6, homeDemandMultiplier: LOW, workDemandMultiplier: LOW },
  { start: 6, end: 7, homeDemandMultiplier: MEDIUM, workDemandMultiplier: LOW },
  { start: 7, end: 10, homeDemandMultiplier: HIGH, workDemandMultiplier: LOW },
  { start: 10, end: 11, homeDemandMultiplier: MEDIUM, workDemandMultiplier: LOW_MEDIUM },
  { start: 11, end: 15, homeDemandMultiplier: LOW_MEDIUM, workDemandMultiplier: LOW_MEDIUM },
  { start: 15, end: 16, homeDemandMultiplier: LOW_MEDIUM, workDemandMultiplier: MEDIUM },
  { start: 16, end: 19, homeDemandMultiplier: LOW, workDemandMultiplier: HIGH },
  { start: 19, end: 20, homeDemandMultiplier: LOW, workDemandMultiplier: MEDIUM },
  { start: 20, end: 23, homeDemandMultiplier: LOW, workDemandMultiplier: LOW },
  { start: 23, end: 24, homeDemandMultiplier: VERY_LOW, workDemandMultiplier: VERY_LOW },
];

export interface SlotOptions {
  /** Blend toward the flat daily average (0 = untouched, 1 = fully flat). */
  dampened?: number;
  /** Average home and work demand per hour (airports: arrivals mirror departures). */
  mirrored?: boolean;
}

export function buildTimeSlots(
  ranges: readonly CommuteRange[],
  { dampened = 0, mirrored = false }: SlotOptions,
): TimeSlots {
  const mult: Record<'home' | 'work', number[]> = {
    home: new Array(HOURS).fill(0),
    work: new Array(HOURS).fill(0),
  };
  // Overlapping ranges take the strongest multiplier, as the game does.
  for (const r of ranges) {
    for (let h = r.start; h < r.end && h < HOURS; h++) {
      mult.home[h] = Math.max(mult.home[h], r.homeDemandMultiplier);
      mult.work[h] = Math.max(mult.work[h], r.workDemandMultiplier);
    }
  }

  if (dampened > 0) {
    for (const kind of ['home', 'work'] as const) {
      const avg = mult[kind].reduce((a, b) => a + b, 0) / HOURS;
      for (let h = 0; h < HOURS; h++) mult[kind][h] = mult[kind][h] * (1 - dampened) + avg * dampened;
    }
  }

  if (mirrored) {
    for (let h = 0; h < HOURS; h++) {
      const avg = (mult.home[h] + mult.work[h]) / 2;
      mult.home[h] = avg;
      mult.work[h] = avg;
    }
  }

  const slots: TimeSlots = { home: [], work: [] };
  for (const kind of ['home', 'work'] as const) {
    // Run-length encode contiguous equal-demand hours into bins.
    let cur = { startHour: 0, demand: mult[kind][0] };
    for (let h = 1; h <= HOURS; h++) {
      if (h === HOURS || mult[kind][h] !== cur.demand) {
        slots[kind].push({ startHour: cur.startHour, endHour: h, probability: cur.demand });
        if (h < HOURS) cur = { startHour: h, demand: mult[kind][h] };
      }
    }
    // Normalize by hour-weighted demand so wide bins carry proportional share.
    const total = slots[kind].reduce((acc, b) => acc + b.probability * (b.endHour - b.startHour), 0);
    for (const b of slots[kind]) {
      b.probability = total > 0 ? (b.probability * (b.endHour - b.startHour)) / total : 0;
    }
  }
  return slots;
}

export interface SlotSetOptions {
  ranges?: readonly CommuteRange[];
  studentDampening?: number;
  airportDampening?: number;
}

export function buildSlotSet(opts: SlotSetOptions = {}): SlotSet {
  const ranges = opts.ranges?.length ? opts.ranges : DEFAULT_COMMUTE_RANGES;
  const student = opts.studentDampening ?? DEFAULT_STUDENT_DAMPENING;
  const airport = opts.airportDampening ?? DEFAULT_AIRPORT_DAMPENING;
  return {
    normal: buildTimeSlots(ranges, {}),
    airport: buildTimeSlots(ranges, { dampened: airport, mirrored: true }),
    university: buildTimeSlots(ranges, { dampened: student }),
  };
}

/** Slots from the game's defaults — used when live ranges are unavailable. */
export const DEFAULT_SLOT_SET: SlotSet = buildSlotSet();

/** Draw one departure time (seconds into the day) from a direction's slots. */
export function pickDeparture(kind: 'home' | 'work', slots: TimeSlots, rng: () => number): number {
  const list = slots[kind];
  const roll = rng();
  let cumulative = 0;
  let chosen = list[0];
  for (const bin of list) {
    cumulative += bin.probability;
    if (roll <= cumulative) { chosen = bin; break; }
  }
  const startSec = chosen.startHour * SECONDS_PER_HOUR;
  const endSec = chosen.endHour * SECONDS_PER_HOUR;
  const hourStart = startSec + Math.floor(rng() * (chosen.endHour - chosen.startHour)) * SECONDS_PER_HOUR;
  const jitter = (rng() - 0.5) * JITTER_SPAN_SECONDS;
  return Math.max(startSec, Math.min(endSec - 1, hourStart + rng() * SECONDS_PER_HOUR + jitter));
}

function slotsForJob(jobId: string, set: SlotSet): TimeSlots {
  if (jobId.startsWith(AIRPORT_PREFIX)) return set.airport;
  if (jobId.startsWith(UNIVERSITY_PREFIX)) return set.university;
  return set.normal;
}

/** FNV-1a over the pop id — a stable seed so a pop's times never change. */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Departure times for one induced pop, drawn from the game's distribution and
 * seeded by the pop id: the same pop always gets the same times, so a pop restored
 * from the roster after a reload keeps the commute it had (nothing extra to persist).
 */
export function commuteTimesFor(
  popId: string,
  jobId: string,
  set: SlotSet = DEFAULT_SLOT_SET,
): { homeDepartureTime: number; workDepartureTime: number } {
  const rng = makeRng(hashSeed(popId));
  const slots = slotsForJob(jobId, set);
  for (let redraw = 0; redraw < MAX_HOME_REDRAWS; redraw++) {
    const home = pickDeparture('home', slots, rng);
    for (let draw = 0; draw < MAX_WORK_DRAWS; draw++) {
      const work = pickDeparture('work', slots, rng);
      if (work !== home && Math.abs(work - home) >= MIN_GAP_SECONDS) {
        return { homeDepartureTime: home, workDepartureTime: work };
      }
    }
    // The game recurses with a fresh home time here; we redraw instead (bounded).
  }
  // Unreachable with any sane range table; keep a valid, well-separated pair.
  const home = pickDeparture('home', slots, rng);
  return { homeDepartureTime: home, workDepartureTime: (home + 12 * SECONDS_PER_HOUR) % 86400 };
}
