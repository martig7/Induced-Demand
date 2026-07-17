/** Subway Builder Modding API v1.0.0 */

/**
 * One band of the game's time-of-day demand table, in 24-hour format.
 *
 * NOTE: the published docs describe this as `{ start, end }` with defaults
 * `[{ start: 7, end: 9 }, { start: 17, end: 19 }]`, but that is not what the API
 * does: `getCommuteTimeRanges()` returns the game's internal `TIME_OF_DAY_RANGES`
 * (11 bands covering the whole day), each carrying the demand multipliers that
 * shape the commute distribution — and `setCommuteTimeRanges` REJECTS entries
 * missing any of the four numeric fields. Verified against the v1.4.10 renderer
 * bundle; see docs/DEMAND_API.md.
 */
export interface CommuteTimeRange {
  /** Start hour in 24-hour format (0-23). */
  start: number;
  /** End hour, exclusive (1-24). */
  end: number;
  /** Relative weight of home→work departures during this band. */
  homeDemandMultiplier: number;
  /** Relative weight of work→home departures during this band. */
  workDemandMultiplier: number;
  /** Stable identifier, e.g. `PeakMorningRush`. Present on the game's own ranges. */
  key?: string;
  /** Display name. Present on the game's own ranges. */
  name?: string;
}
