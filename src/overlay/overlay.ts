import type { ModdingAPI } from '../types/api';
import type { OverlayFeatureCollection, HistoryFeatureCollection } from './types';

export const SOURCE_ID = 'induced-demand-source';
export const LAYER_ID = 'induced-demand-circles';
export const HISTORY_SOURCE_ID = 'induced-demand-history-source';
export const HISTORY_LAYER_ID = 'induced-demand-history-circles';

/** Sequential ramp, deliberately distinct from the game's built-in demand palette. */
export const RAMP_LOW = '#edf8fb';
export const RAMP_MID = '#8c96c6';
export const RAMP_HIGH = '#810f7c';

const EMPTY_FC: OverlayFeatureCollection = { type: 'FeatureCollection', features: [], maxValue: 0 };

/**
 * Constant ground-size circles at EVERY zoom (no clamping): the radius doubles per zoom level
 * (`radius = baseRadius × 2^(zoom − REF_ZOOM)`), so a dot keeps a fixed real-world footprint and
 * grows/shrinks exactly with the map. Anchored by two stops at the zoom extremes that both lie on
 * that exponential curve, so the base-2 interpolation reproduces it exactly across the full range.
 * The base radius (R_MIN..R_MAX px at REF_ZOOM) still scales with the per-feature value `t`.
 */
const R_MIN = 1;
const R_MAX = 8;
const REF_ZOOM = 11; // radius == baseRadius at this zoom
const Z_LO = 0;
const Z_HI = 24;
/** Per-feature base radius at REF_ZOOM: R_MIN..R_MAX scaled by `t`. Fresh array per call. */
const baseRadius = (): unknown => ['+', R_MIN, ['*', ['get', 't'], R_MAX - R_MIN]];

/** Register the GeoJSON source and the (initially hidden) circle layer. Idempotent via the API's upsert. */
export function registerOverlay(api: ModdingAPI): void {
  api.map.registerSource(SOURCE_ID, { type: 'geojson', data: EMPTY_FC });
  api.map.registerLayer({
    id: LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate', ['exponential', 2], ['zoom'],
        Z_LO, ['*', baseRadius(), 2 ** (Z_LO - REF_ZOOM)],
        Z_HI, ['*', baseRadius(), 2 ** (Z_HI - REF_ZOOM)],
      ],
      'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, RAMP_LOW, 0.5, RAMP_MID, 1, RAMP_HIGH],
      'circle-opacity': 0.85,
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#00000055',
    },
  });
  // History-day layer: same constant-ground-size radius, but per-feature color
  // (green = added, red = removed — see historyCollection.ts).
  api.map.registerSource(HISTORY_SOURCE_ID, { type: 'geojson', data: EMPTY_FC });
  api.map.registerLayer({
    id: HISTORY_LAYER_ID,
    type: 'circle',
    source: HISTORY_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate', ['exponential', 2], ['zoom'],
        Z_LO, ['*', baseRadius(), 2 ** (Z_LO - REF_ZOOM)],
        Z_HI, ['*', baseRadius(), 2 ** (Z_HI - REF_ZOOM)],
      ],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.85,
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#00000055',
    },
  });
}

/** Push a new FeatureCollection to the live source. */
export function updateOverlay(api: ModdingAPI, fc: OverlayFeatureCollection): void {
  const map = api.utils.getMap();
  const src = map?.getSource(SOURCE_ID) as unknown as { setData?: (d: unknown) => void } | undefined;
  src?.setData?.(fc);
}

/** Show or hide the circle layer. */
export function setOverlayVisible(api: ModdingAPI, visible: boolean): void {
  const map = api.utils.getMap();
  if (map && map.getLayer(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
}

/** Push a new history-day FeatureCollection to its live source. */
export function updateHistoryOverlay(api: ModdingAPI, fc: HistoryFeatureCollection): void {
  const map = api.utils.getMap();
  const src = map?.getSource(HISTORY_SOURCE_ID) as unknown as { setData?: (d: unknown) => void } | undefined;
  src?.setData?.(fc);
}

/** Show or hide the history circle layer. */
export function setHistoryOverlayVisible(api: ModdingAPI, visible: boolean): void {
  const map = api.utils.getMap();
  if (map && map.getLayer(HISTORY_LAYER_ID)) {
    map.setLayoutProperty(HISTORY_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
}
