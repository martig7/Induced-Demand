/**
 * Heatmap of the site field (spec §7): the targeting display IS the model's
 * input. MapLibre native heatmap layer over site weights; views: residential
 * access, commercial access, growth pressure. Own source/layer via the same
 * registration pipeline as the circle overlay.
 */
import type { ModdingAPI } from '../types/api';
import type { InducedDemandConfig } from '../model/config';
import type { LedgerState } from '../model/ledger';
import type { Site } from '../model/field';

export const HEAT_SOURCE_ID = 'induced-demand-heat-source';
export const HEAT_LAYER_ID = 'induced-demand-heatmap';

export type HeatView = 'off' | 'accessRes' | 'accessCom' | 'pressure';

export interface HeatFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; w: number };
}
export interface HeatFeatureCollection {
  type: 'FeatureCollection';
  features: HeatFeature[];
}

const EMPTY: HeatFeatureCollection = { type: 'FeatureCollection', features: [] };
const MIN_WEIGHT = 0.02;

export function buildHeatFeatures(
  sites: Site[],
  ledger: LedgerState,
  view: Exclude<HeatView, 'off'>,
  cfg: InducedDemandConfig,
): HeatFeatureCollection {
  const features: HeatFeature[] = [];
  for (const s of sites) {
    let w: number;
    if (view === 'accessRes') w = s.accessRes;
    else if (view === 'accessCom') w = s.accessCom;
    else {
      const [ra, ja] = s.pointId
        ? [(ledger.points[s.pointId]?.resAccum ?? 0), (ledger.points[s.pointId]?.jobAccum ?? 0)]
        : (ledger.sites?.[s.id] ?? [0, 0]);
      w = Math.min(1, Math.max(ra, ja, 0) / cfg.POP_SIZE);
    }
    if (w < MIN_WEIGHT) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.location[0], s.location[1]] },
      properties: { id: s.id, w },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Register source + (hidden) heatmap layer. Idempotent via the API's upsert. */
export function registerHeatmap(api: ModdingAPI): void {
  api.map.registerSource(HEAT_SOURCE_ID, { type: 'geojson', data: EMPTY });
  api.map.registerLayer({
    id: HEAT_LAYER_ID,
    type: 'heatmap',
    source: HEAT_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['get', 'w'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.2],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 18, 14, 60],
      'heatmap-opacity': 0.55,
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
