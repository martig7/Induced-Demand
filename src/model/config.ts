export type ReconcileRule = 'average' | 'min' | 'residential' | 'commercial';

export interface InducedDemandConfig {
  /** People per pop — fixed game unit. */
  POP_SIZE: number;
  /** Max induced fraction at score=1 (cap = baseline*(1+K_MAX*score)). */
  K_MAX: number;
  /** Logistic growth rate per day. */
  R_GROW: number;
  /** Decay rate per day when over cap (slower than growth). */
  R_DECAY: number;
  /** Net-equal reconciliation rule for the daily pop count. */
  RECONCILE: ReconcileRule;
  /** Max magnitude held in an accumulator (people). */
  ACCUM_CAP: number;
  /** Walk seconds beyond which a station is out of catchment. */
  CATCHMENT_SECONDS: number;
  /** Gaussian walk-time decay scale for access. */
  TAU_ACCESS: number;
  /** Minimum access credit for a single-line point. */
  ACCESS_CONN_FLOOR: number;
  /** Walking speed (m/s) for access walk-time. */
  WALK_SPEED: number;
  /** Gravity distance-decay exponent. */
  BETA: number;
  /** Gravity distance floor (m). */
  DIST_MIN: number;
  // --- Access v2 (reachability to opportunity) ---
  /** Decay scale (s) for network travel time in the opportunity sum. */
  TAU_REACH: number;
  /** Ride-speed fallback (m/s) when a route lacks stComboTimings. */
  NOMINAL_TRANSIT_SPEED: number;
  /** Cost (s) of an in-complex interchange (station groups). */
  INTERCHANGE_SECONDS: number;
  /** Boarding wait (s) when a route has no usable service data. */
  DEFAULT_WAIT_SECONDS: number;
  /** Floor (s) for the boarding wait. */
  MIN_WAIT_SECONDS: number;
  // --- Spacing curve bounds ---
  /** Min/max point spacing (m) — clamps the fitted spacing curve. */
  R_MIN: number;
  R_MAX: number;
  /** Lattice samples below this max(accessRes, accessCom) are outside the field. */
  MIN_SITE_ACCESS: number;
  // --- Density fit ---
  /** Access bins for the density fit. */
  FIT_BINS: number;
  /** Low quantile of nearest-neighbor distance per bin → spacing curve. */
  FIT_SPACING_QUANTILE: number;
  /** Upper quantile of per-point people mass per bin → mass curve. */
  FIT_MASS_QUANTILE: number;
  /** City-wide people-mass quantile that clamps the mass curve (envelope). */
  ENVELOPE_QUANTILE: number;
  // --- Materialized-point caps ---
  /** Residential / job share of a materialized point's access-derived mass cap. */
  RES_SHARE: number;
  JOB_SHARE: number;
  // --- Voronoi subdivision (spec 2026-07-18) ---
  /** Lattice sample pitch (m) for cell integration. */
  LATTICE_M: number;
  /**
   * Split-pressure threshold (in days). A cell accrues `excess × fill` per day,
   * where excess = supportedMass/capTotal − 1 (extra anchor-loads it supports).
   * So a large, under-subdivided cell (a new station's catchment) crosses this
   * in ~a day, while a right-sized dense cell (excess ≈ 0) barely accrues.
   * A cell at excess·fill = 1 splits in exactly TARGET_SPLIT_DAYS days.
   * City-independent (excess is a ratio).
   */
  TARGET_SPLIT_DAYS: number;
  /**
   * Fraction of the day's demand growth (N·POP_SIZE people) spent opening new
   * locations. Calibrates the split budget to the city's growth rate — a slow
   * town splits rarely, a booming metropolis proportionally more.
   */
  GROWTH_SHARE: number;
  /** Hard ceiling on the calibrated split budget (safety). */
  MAX_SPLITS_PER_DAY: number;
  /**
   * Growth-rate multiplier for materialized (split) points, so a new dot fills
   * in naturally but faster than a native point — it earns its pops over days
   * instead of instantly, without an artificial demand seed. 1 = same as native.
   */
  NEW_POINT_GROWTH_BOOST: number;
}

export const DEFAULT_CONFIG: InducedDemandConfig = {
  POP_SIZE: 200,
  K_MAX: 1.0,
  R_GROW: 0.15,
  R_DECAY: 0.04,
  RECONCILE: 'average',
  ACCUM_CAP: 1000,
  CATCHMENT_SECONDS: 1800,
  TAU_ACCESS: 600,
  // 0.2 (not 0.5): a zero-opportunity station still bootstraps greenfield access
  // above MIN_SITE_ACCESS, but lands in the LOW-access density bins — so empty
  // terrain targets sparse (foothill-scale) density, not mid-city, and the field
  // shows a real opportunity gradient instead of looking uniform (see Fable
  // analysis 2026-07-19). Lower access also slows growth, hence R_GROW +50%.
  ACCESS_CONN_FLOOR: 0.2,
  WALK_SPEED: 1.0,
  BETA: 2.0,
  DIST_MIN: 100,
  TAU_REACH: 900,
  NOMINAL_TRANSIT_SPEED: 15,
  INTERCHANGE_SECONDS: 45,
  DEFAULT_WAIT_SECONDS: 300,
  MIN_WAIT_SECONDS: 30,
  R_MIN: 150,
  R_MAX: 600,
  MIN_SITE_ACCESS: 0.05,
  FIT_BINS: 8,
  FIT_SPACING_QUANTILE: 0.25,
  FIT_MASS_QUANTILE: 0.8,
  ENVELOPE_QUANTILE: 0.95,
  RES_SHARE: 0.5,
  JOB_SHARE: 0.5,
  LATTICE_M: 250,
  TARGET_SPLIT_DAYS: 30,
  GROWTH_SHARE: 0.1,
  MAX_SPLITS_PER_DAY: 12,
  NEW_POINT_GROWTH_BOOST: 5, // split dots fill in ~5x faster than a native point
};
