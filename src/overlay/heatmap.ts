/**
 * Field heat view (spec §7): the targeting display IS the model's input. Views:
 * residential access, commercial access, growth pressure.
 *
 * NOT a MapLibre `heatmap` layer, and deliberately free of every zoom/density
 * coupling that made the field unreadable:
 *  - Color encodes each site's value on an ABSOLUTE scale (access is already in
 *    [0,1]; pressure is accum/POP_SIZE clamped to 1), NOT normalized to the
 *    citywide max — so a given color always means the same value, comparable
 *    across time and across cities.
 *  - Circles are a CONSTANT pixel size (no zoom scaling) and fully opaque with
 *    no blur, so overlapping marks never stack their translucency into a hotter
 *    color. Color depends only on `t`; zoom and neighbor density change nothing.
 */
import type { ModdingAPI } from '../types/api';
import type { InducedDemandConfig } from '../model/config';
import type { LedgerState } from '../model/ledger';
import type { Site } from '../model/field';
import { clamp01 } from '../model/util';
import { RAMP_LOW, RAMP_MID, RAMP_HIGH } from './overlay';

export const HEAT_SOURCE_ID = 'induced-demand-heat-source';
export const HEAT_LAYER_ID = 'induced-demand-heatmap';

export type HeatView = 'off' | 'accessRes' | 'accessCom' | 'pressure';

export interface HeatFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  /** `t` = the site's ABSOLUTE value in [0,1]; the color ramp reads only this. */
  properties: { id: string; t: number };
}
export interface HeatFeatureCollection {
  type: 'FeatureCollection';
  features: HeatFeature[];
  /** Citywide max of the raw view value (for a legend); 0 when the field is empty. */
  maxValue: number;
}

const EMPTY: HeatFeatureCollection = { type: 'FeatureCollection', features: [], maxValue: 0 };
/** Drop features below this absolute value (keeps the layer sparse; not a normalizer). */
const MIN_T = 0.02;

/**
 * Absolute [0,1] value for a view. Access scores are already in [0,1]. Pressure
 * is the accumulator relative to one POP_SIZE of readiness (a site spawns a pop
 * near accum == POP_SIZE), clamped so a fully-pressured site is the ramp's top.
 */
function absoluteValue(s: Site, ledger: LedgerState, view: Exclude<HeatView, 'off'>, cfg: InducedDemandConfig): number {
  if (view === 'accessRes') return clamp01(s.accessRes);
  if (view === 'accessCom') return clamp01(s.accessCom);
  const [ra, ja] = s.pointId
    ? [(ledger.points[s.pointId]?.resAccum ?? 0), (ledger.points[s.pointId]?.jobAccum ?? 0)]
    : (ledger.sites?.[s.id] ?? [0, 0]);
  return clamp01(Math.max(ra, ja, 0) / cfg.POP_SIZE);
}

export function buildHeatFeatures(
  sites: Site[],
  ledger: LedgerState,
  view: Exclude<HeatView, 'off'>,
  cfg: InducedDemandConfig,
): HeatFeatureCollection {
  const features: HeatFeature[] = [];
  let maxValue = 0;
  for (const s of sites) {
    const t = absoluteValue(s, ledger, view, cfg);
    if (t > maxValue) maxValue = t;
    if (t < MIN_T) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.location[0], s.location[1]] },
      properties: { id: s.id, t },
    });
  }
  return { type: 'FeatureCollection', features, maxValue };
}

/**
 * Constant PIXEL radius: circles do not resize with zoom, so their overlap (and
 * any color stacking it could cause) never changes as you zoom. Fully opaque +
 * no blur means overlapping marks occlude rather than blend — color is exactly
 * the site's value, never a hotter mix.
 */
const RADIUS_PX = 6;

/** Register source + (hidden) field circle layer. Idempotent via the API's upsert. */
export function registerHeatmap(api: ModdingAPI): void {
  api.map.registerSource(HEAT_SOURCE_ID, { type: 'geojson', data: EMPTY });
  api.map.registerLayer({
    id: HEAT_LAYER_ID,
    type: 'circle',
    source: HEAT_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': RADIUS_PX,
      // Color encodes the absolute value; identical at every zoom, no stacking.
      'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, RAMP_LOW, 0.5, RAMP_MID, 1, RAMP_HIGH],
      'circle-blur': 0,
      'circle-opacity': 1,
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
