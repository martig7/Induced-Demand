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
  /** Relocation fraction (0 = pure additive). */
  PHI: number;
  /** Max magnitude held in an accumulator (people). */
  ACCUM_CAP: number;
  /** Walk seconds beyond which a station is out of catchment. */
  CATCHMENT_SECONDS: number;
  /** Gaussian walk-time decay scale for access. */
  TAU_ACCESS: number;
  /** Distinct lines in catchment for full connectivity credit. */
  CONNECTIVITY_REF: number;
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
  // --- Site sampling ---
  /** Min/max blue-noise spacing (m) between sites. */
  R_MIN: number;
  R_MAX: number;
  /** Max jitter radius as a fraction of local spacing; soft spacing = (1−J_FRAC)·r. */
  J_FRAC: number;
  /** Empty candidate sites below this max(accessRes, accessCom) are dropped. */
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
  // --- Empty-site caps ---
  /** Residential / job share of an empty site's access-derived mass cap. */
  RES_SHARE: number;
  JOB_SHARE: number;
  // --- Densification ---
  /** Daily ceiling-creep rate while saturated. */
  RHO_DENSIFY: number;
  /** Saturation (filled induced headroom fraction) above which densify creeps. */
  SAT_THRESHOLD: number;
}

export const DEFAULT_CONFIG: InducedDemandConfig = {
  POP_SIZE: 200,
  K_MAX: 1.0,
  R_GROW: 0.1,
  R_DECAY: 0.04,
  RECONCILE: 'average',
  PHI: 0,
  ACCUM_CAP: 1000,
  CATCHMENT_SECONDS: 1800,
  TAU_ACCESS: 600,
  CONNECTIVITY_REF: 3,
  ACCESS_CONN_FLOOR: 0.5,
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
  J_FRAC: 0.35,
  MIN_SITE_ACCESS: 0.05,
  FIT_BINS: 8,
  FIT_SPACING_QUANTILE: 0.25,
  FIT_MASS_QUANTILE: 0.8,
  ENVELOPE_QUANTILE: 0.95,
  RES_SHARE: 0.5,
  JOB_SHARE: 0.5,
  RHO_DENSIFY: 0.002,
  SAT_THRESHOLD: 0.8,
};
