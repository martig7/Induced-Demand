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
};
