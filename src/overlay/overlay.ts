import type { ModdingAPI } from '../types/api';
import type { OverlayFeatureCollection } from './types';

export const SOURCE_ID = 'induced-demand-source';
export const LAYER_ID = 'induced-demand-circles';

/** Sequential ramp, deliberately distinct from the game's built-in demand palette. */
export const RAMP_LOW = '#edf8fb';
export const RAMP_MID = '#8c96c6';
export const RAMP_HIGH = '#810f7c';

const EMPTY_FC: OverlayFeatureCollection = { type: 'FeatureCollection', features: [], maxValue: 0 };

/**
 * Constant ground-size circles: within [Z_REF_LOW, Z_REF_HIGH] the radius doubles per zoom level
 * (exponential base 2), so a dot keeps a fixed real-world footprint and grows on screen as you zoom
 * in. Outside that window MapLibre clamps to the endpoint outputs, bounding the size at extreme zoom.
 * The base radius (R_MIN..R_MAX px at Z_REF_LOW) still scales with the per-feature value `t`.
 */
const R_MIN = 1;
const R_MAX = 8;
const Z_REF_LOW = 11;
const Z_REF_HIGH = 16;
const Z_FACTOR = 2 ** (Z_REF_HIGH - Z_REF_LOW); // radius multiplier across the reference window
/** Per-feature base radius at Z_REF_LOW: R_MIN..R_MAX scaled by `t`. Fresh array per call. */
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
        Z_REF_LOW, baseRadius(),
        Z_REF_HIGH, ['*', baseRadius(), Z_FACTOR],
      ],
      'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, RAMP_LOW, 0.5, RAMP_MID, 1, RAMP_HIGH],
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
