/**
 * Field heat view (spec §7): the targeting display IS the model's input. Views:
 * residential access, commercial access, growth pressure.
 *
 * NOT a MapLibre `heatmap` layer. That type colors by screen-space accumulated
 * DENSITY, which (a) changes with zoom as kernels overlap differently, and
 * (b) is near-uniform here anyway — the field is deliberately even blue-noise
 * spacing, so density carries almost no signal and the view looked washed out.
 * The signal lives in each site's VALUE, so we encode value as per-feature
 * color normalized to the CITYWIDE MAX of the active view: the hottest color is
 * always the city's current maximum, and because the color is per feature (not
 * an accumulation) it is identical at every zoom. Radius keeps a constant
 * real-world footprint (doubles per zoom level, same technique as the demand
 * overlay), with blur so the even field reads as a smooth surface.
 */
import type { ModdingAPI } from '../types/api';
import type { InducedDemandConfig } from '../model/config';
import type { LedgerState } from '../model/ledger';
import type { Site } from '../model/field';
import { RAMP_LOW, RAMP_MID, RAMP_HIGH } from './overlay';

export const HEAT_SOURCE_ID = 'induced-demand-heat-source';
export const HEAT_LAYER_ID = 'induced-demand-heatmap';

export type HeatView = 'off' | 'accessRes' | 'accessCom' | 'pressure';

export interface HeatFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  /** `t` = value / citywide-max, in [0,1]; the color ramp reads only this. */
  properties: { id: string; t: number };
}
export interface HeatFeatureCollection {
  type: 'FeatureCollection';
  features: HeatFeature[];
  /** Citywide max of the raw view value (for a legend); 0 when the field is empty. */
  maxValue: number;
}

const EMPTY: HeatFeatureCollection = { type: 'FeatureCollection', features: [], maxValue: 0 };
/** Drop features whose normalized value is negligible (keeps the layer sparse). */
const MIN_T = 0.02;

/** Raw per-site value for a view (undivided). */
function rawValue(s: Site, ledger: LedgerState, view: Exclude<HeatView, 'off'>, cfg: InducedDemandConfig): number {
  if (view === 'accessRes') return s.accessRes;
  if (view === 'accessCom') return s.accessCom;
  const [ra, ja] = s.pointId
    ? [(ledger.points[s.pointId]?.resAccum ?? 0), (ledger.points[s.pointId]?.jobAccum ?? 0)]
    : (ledger.sites?.[s.id] ?? [0, 0]);
  return Math.max(ra, ja, 0) / cfg.POP_SIZE;
}

export function buildHeatFeatures(
  sites: Site[],
  ledger: LedgerState,
  view: Exclude<HeatView, 'off'>,
  cfg: InducedDemandConfig,
): HeatFeatureCollection {
  // First pass: raw values + the citywide max (the normalizer, so the ramp's
  // top is always the current city maximum — zoom-independent by construction).
  const raw: { id: string; loc: [number, number]; v: number }[] = [];
  let maxValue = 0;
  for (const s of sites) {
    const v = rawValue(s, ledger, view, cfg);
    if (v <= 0) continue;
    raw.push({ id: s.id, loc: [s.location[0], s.location[1]], v });
    if (v > maxValue) maxValue = v;
  }
  const features: HeatFeature[] = [];
  for (const r of raw) {
    const t = maxValue > 0 ? r.v / maxValue : 0;
    if (t < MIN_T) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: r.loc },
      properties: { id: r.id, t },
    });
  }
  return { type: 'FeatureCollection', features, maxValue };
}

// Constant real-world footprint: radius doubles per zoom level, so a site keeps
// a fixed ground size and the field looks the same at every zoom (same method
// as overlay.ts). Larger + blurred than the demand dots so the even field reads
// as a continuous surface rather than discrete points.
const BASE_RADIUS = 14; // px at REF_ZOOM
const REF_ZOOM = 11;
const Z_LO = 0;
const Z_HI = 24;
const radiusExpr = (): unknown => ([
  'interpolate', ['exponential', 2], ['zoom'],
  Z_LO, BASE_RADIUS * 2 ** (Z_LO - REF_ZOOM),
  Z_HI, BASE_RADIUS * 2 ** (Z_HI - REF_ZOOM),
]);

/** Register source + (hidden) field circle layer. Idempotent via the API's upsert. */
export function registerHeatmap(api: ModdingAPI): void {
  api.map.registerSource(HEAT_SOURCE_ID, { type: 'geojson', data: EMPTY });
  api.map.registerLayer({
    id: HEAT_LAYER_ID,
    type: 'circle',
    source: HEAT_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': radiusExpr(),
      // Color encodes the citywide-normalized value; identical at every zoom.
      'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, RAMP_LOW, 0.5, RAMP_MID, 1, RAMP_HIGH],
      'circle-blur': 0.8,
      'circle-opacity': 0.55,
    },
  });
}

export function updateHeatmap(api: ModdingAPI, fc: HeatFeatureCollection): void {
  const map = api.utils.getMap();
  const src = map?.getSource(HEAT_SOURCE_ID) as unknown as { setData?: (d: unknown) => void } | undefined;
  src?.setData?.(fc);
}

export function setHeatmapVisible(api: ModdingAPI, visible: boolean): void {
  const map = api.utils.getMap();
  if (map && map.getLayer(HEAT_LAYER_ID)) {
    map.setLayoutProperty(HEAT_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
}
