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
  /**
   * Over-cap decay tolerance, as a fraction of the induced headroom (cap −
   * baseline). Decay only fires above `cap + DECAY_TOLERANCE·(cap − baseline)`,
   * absorbing the daily jitter of a recomputed cap without churning a pop off.
   * Scales with headroom so it vanishes at baseline (transit removal → full
   * revert, no residual). 0 = decay the instant current exceeds cap.
   */
  DECAY_TOLERANCE: number;
  /** Net-equal reconciliation rule for the daily pop count. */
  RECONCILE: ReconcileRule;
  /** Max magnitude held in an accumulator (people). */
  ACCUM_CAP: number;
  /** Walk seconds beyond which a station is out of catchment. */
  CATCHMENT_SECONDS: number;
  /**
   * Walk-time (s) at which access tapers LINEARLY to 0 — `walkProx = max(0, 1 −
   * t/TAU_ACCESS)`. Set to CATCHMENT_SECONDS so access spans the game's full
   * catchment (decompile: hard 1800s straight-line cutoff, no distance decay).
   * Lower it to concentrate access nearer stations; must be ≤ CATCHMENT_SECONDS
   * to matter (points beyond the catchment are dropped first).
   */
  TAU_ACCESS: number;
  /** Minimum access credit for a single-line point. */
  ACCESS_CONN_FLOOR: number;
  /**
   * Weight on the demand-INDEPENDENT network-reach term in the opportunity Ô
   * (0..1): Ô = w·reach + (1−w)·reachable-demand, per direction. `reach` is the
   * decay-weighted fraction of the network a station reaches, so a well-connected
   * station in a BLANK area still scores — letting new development bootstrap
   * where transit is good but demand hasn't arrived yet (without it, Ô is pinned
   * low in empty areas and their caps never lift). 0.5 = equal with demand.
   */
  ACCESS_TRANSIT_WEIGHT: number;
  /**
   * Job AGGLOMERATION: the commercial (job) score is multiplied by
   * `1 + AGGLOM_STRENGTH·jobDensity`, where jobDensity ∈ [0,1] is the normalized
   * local job mass within AGGLOM_RADIUS_M. Job-dense land scores higher → grows
   * more jobs → a few clusters run away instead of jobs spreading evenly (the
   * agglomeration economics that make downtowns). 0 = off; 2 = up to 3× in cores.
   */
  AGGLOM_STRENGTH: number;
  /** Neighborhood radius (m) for the local job-density agglomeration term. */
  AGGLOM_RADIUS_M: number;
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
  /**
   * Max walk time (s) for a coordinate-derived transfer edge between two
   * stations. The game API leaves `station.nearbyStations` empty, so transfers
   * are computed from actual spacing (walk = dist/WALK_SPEED) up to this cap —
   * this is what links two lines that meet, so without it a network is only as
   * connected as its explicit interchange groups.
   */
  TRANSFER_MAX_SECONDS: number;
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
  /**
   * How much a materialized point's cap DRAW is biased by its access (0..1). The
   * draw quantile is `bias·access + (1−bias)·hash(id)`: at 0 the size is a pure
   * per-point hash (large caps scatter to any access); at 1 it's purely access
   * (all high-access points max out, no spread). Between, high-access points lean
   * toward the tail (large centers) while randomness keeps a spread — so the few
   * large draws concentrate where access is high (jobs where accessCom reaches
   * residents), not on low-access edges.
   */
  SPLIT_CAP_ACCESS_BIAS: number;
  /**
   * Lower edge of the quantile bracket [SPLIT_CAP_QUANTILE_FLOOR, 1] a
   * materialized point's cap is drawn from — how DENSE new cut points land in the
   * native mass distribution. Raised to 0.75 (upper quartile): paired with the
   * residential-density split gate this drives the sparse-vs-dense induction
   * spread — a sparse city (ungated, many cut points) fattens all of them for
   * high induction, while a dense city (gated, few points) barely moves — AND it
   * restores big agglomeration job centers that a low floor flattened. Higher →
   * denser new development everywhere; above ~0.8 induction goes vertical.
   */
  SPLIT_CAP_QUANTILE_FLOOR: number;
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
   * Split-pressure DECAY per day (in the same day-unit). Net accrual is
   * excess·fill − SPLIT_PRESSURE_DECAY, so a cell must be SUSTAINABLY
   * over-subdivided (excess·fill above this) to build pressure at all — marginal
   * cells (a whisper of excess) relax back to 0 instead of slowly creeping to the
   * threshold over hundreds of days and sticking there uncuttable. Without it,
   * pressure only ever rises, so every cell with any positive excess eventually
   * hatches even when it has no room for another point.
   */
  SPLIT_PRESSURE_DECAY: number;
  /**
   * Split HEADROOM target: local RESIDENTIAL density (residents per km²) at or
   * above which a cell stops accruing split pressure. Readiness is multiplied by
   * `headroom = clamp01(1 − localResDensity/target)`, so residentially-dense
   * areas add few new demand points while sparse ones subdivide toward the
   * target — the density-DIFFERENTIAL lever (dense NYC splits little, sparse
   * Denver more). Residents only (not jobs), so job cores stay ungated and
   * agglomeration still concentrates there. Measured over POP_DENSITY_RADIUS_M.
   * Lower = fewer new points; a very high value disables the gate (headroom ≈ 1).
   */
  TARGET_POP_DENSITY_PER_KM2: number;
  /** Neighborhood radius (m) for the local population-density headroom measure. */
  POP_DENSITY_RADIUS_M: number;
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
  R_GROW: 0.05,
  R_DECAY: 0.04,
  DECAY_TOLERANCE: 0.25,
  RECONCILE: 'average',
  ACCUM_CAP: 1000,
  CATCHMENT_SECONDS: 1800,
  TAU_ACCESS: 1800, // = CATCHMENT_SECONDS: access spans the full game catchment
  // 0.3: a zero-opportunity station still bootstraps greenfield access above
  // MIN_SITE_ACCESS and lands in the LOW-access density bins (empty terrain
  // targets sparse density, and the field keeps a real opportunity gradient),
  // but 0.2 cut induced headroom in low-opportunity areas so hard that lowering
  // it from 0.5 dumped a large share of the city over its new caps → sustained
  // net removal. 0.3 is the compromise: gradient preserved, re-leveling gentler.
  // Paired with the frozen-native Ô denominator so growth no longer dilutes it.
  ACCESS_CONN_FLOOR: 0.3,
  ACCESS_TRANSIT_WEIGHT: 0.5,
  AGGLOM_STRENGTH: 2,
  AGGLOM_RADIUS_M: 800,
  WALK_SPEED: 1.0,
  BETA: 2.0,
  DIST_MIN: 100,
  TAU_REACH: 900,
  NOMINAL_TRANSIT_SPEED: 15,
  INTERCHANGE_SECONDS: 45,
  TRANSFER_MAX_SECONDS: 300,
  DEFAULT_WAIT_SECONDS: 300,
  MIN_WAIT_SECONDS: 30,
  R_MIN: 150,
  R_MAX: 600,
  MIN_SITE_ACCESS: 0.05,
  FIT_BINS: 8,
  FIT_SPACING_QUANTILE: 0.25,
  FIT_MASS_QUANTILE: 0.8,
  ENVELOPE_QUANTILE: 0.95,
  SPLIT_CAP_ACCESS_BIAS: 0.5,
  SPLIT_CAP_QUANTILE_FLOOR: 0.75, // dense new cut points → sparse cities induce hard, dense cities gate
  LATTICE_M: 250,
  TARGET_SPLIT_DAYS: 10,
  SPLIT_PRESSURE_DECAY: 1.0, // net accrual excess·fill − 1: needs room for ~a full extra point
  TARGET_POP_DENSITY_PER_KM2: 3000, // split headroom target (res+jobs/km²): dense cities gate, sparse subdivide
  POP_DENSITY_RADIUS_M: 600,
  NEW_POINT_GROWTH_BOOST: 5, // split dots fill in ~5x faster than a native point
};
