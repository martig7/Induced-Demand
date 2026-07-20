/**
 * Field heat view (spec §7): the targeting display IS the model's input. Views:
 * residential access, commercial access, growth pressure.
 *
 * Rendered as a single BAKED RASTER, not stacked marks. Every site is splatted
 * as a soft Gaussian and combined by MAX across sites (a union of kernels, never
 * a sum), so the field is one smooth surface with the color gradient baked into
 * its pixels. Because it is one georeferenced image:
 *  - it scales with the map (fixed ground footprint at every zoom), and
 *  - overlapping sites can never alpha-stack into a saturated blob — the reason
 *    the translucent-circle version turned solid red when zoomed out.
 * Color still encodes each site's ABSOLUTE value (access already in [0,1];
 * pressure = accum/POP_SIZE clamped), so a color always means the same value.
 */
import type { ModdingAPI } from '../types/api';
import type { InducedDemandConfig } from '../model/config';
import type { LedgerState } from '../model/ledger';
import type { Site } from '../model/field';
import { clamp01 } from '../model/util';
import { RAMP_LOW, RAMP_MID, RAMP_HIGH } from './overlay';

export const HEAT_SOURCE_ID = 'induced-demand-heat-source';
export const HEAT_LAYER_ID = 'induced-demand-heatmap';

export type HeatView = 'off' | 'accessRes' | 'accessCom' | 'pressure' | 'cells';

export interface HeatFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  /** `t` = the site's ABSOLUTE value in [0,1]; drives the baked color. */
  properties: { id: string; t: number };
}
export interface HeatFeatureCollection {
  type: 'FeatureCollection';
  features: HeatFeature[];
  /** Citywide max of the raw view value (for a legend); 0 when the field is empty. */
  maxValue: number;
}

/** Below this baked value a pixel is transparent (keeps the field's edge soft-but-bounded). */
const MIN_VALUE = 0.03;

/**
 * Absolute [0,1] value for a view. Access scores are already in [0,1]. Pressure
 * is the accumulator relative to one POP_SIZE of readiness (a site spawns a pop
 * near accum == POP_SIZE), clamped so a fully-pressured site is the ramp's top.
 */
function absoluteValue(s: Site, ledger: LedgerState, view: Exclude<HeatView, 'off'>, cfg: InducedDemandConfig): number {
  if (view === 'accessRes') return clamp01(s.accessRes);
  if (view === 'accessCom') return clamp01(s.accessCom);
  const e = ledger.points[s.pointId];
  return clamp01(Math.max(e?.resAccum ?? 0, e?.jobAccum ?? 0, 0) / cfg.POP_SIZE);
}

/** A cell's prospective cut for the pressure view: where the next point would appear. */
export interface ProspectiveCut { location: [number, number]; t: number }

export function buildHeatFeatures(
  sites: Site[],
  ledger: LedgerState,
  view: Exclude<HeatView, 'off'>,
  cfg: InducedDemandConfig,
  /** Pressure view only: split pressure rendered at each cell's prospective cut. */
  cuts: ProspectiveCut[] = [],
): HeatFeatureCollection {
  const features: HeatFeature[] = [];
  let maxValue = 0;
  for (const s of sites) {
    const t = absoluteValue(s, ledger, view, cfg);
    if (t > maxValue) maxValue = t;
    if (t < MIN_VALUE) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.location[0], s.location[1]] },
      properties: { id: s.id, t },
    });
  }
  if (view === 'pressure') {
    cuts.forEach((c, i) => {
      const t = clamp01(c.t);
      if (t < MIN_VALUE) return;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c.location },
        properties: { id: `cut:${i}`, t },
      });
      if (t > maxValue) maxValue = t;
    });
  }
  return { type: 'FeatureCollection', features, maxValue };
}

// --- Rasterization (pure) ----------------------------------------------------

const M_PER_DEG_LAT = 111194.9;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const RAMP: [number, [number, number, number]][] = [
  [0, hexToRgb(RAMP_LOW)],
  [0.5, hexToRgb(RAMP_MID)],
  [1, hexToRgb(RAMP_HIGH)],
];

/** 3-stop linear color ramp; matches the demand overlay's palette. */
export function rampColor(t: number): [number, number, number] {
  const v = clamp01(t);
  for (let i = 1; i < RAMP.length; i++) {
    const [x1, c1] = RAMP[i];
    if (v <= x1) {
      const [x0, c0] = RAMP[i - 1];
      const f = x1 === x0 ? 0 : (v - x0) / (x1 - x0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/**
 * Baked-raster resolution: the longest grid dimension in pixels. Higher = finer
 * detail and less blockiness when zoomed in, at a roughly quadratic bake cost.
 */
const GRID_MAX = 1024;
/**
 * Gaussian reach (m). Kernels must overlap enough to stay continuous over the
 * ~150–600 m site spacing, but a tight kernel keeps dense high-value clusters as
 * distinct bright cores instead of smearing them into one flat hot blob.
 */
const KERNEL_METERS = 400;

/** Continuous access views sample cheaply per pixel — fewer pixels than the splat. */
const ACCESS_GRID_MAX = 512;
/** Ramp alpha from 0→full over [MIN_VALUE, MIN_VALUE + ALPHA_FADE]. */
const ALPHA_FADE = 0.12;

export interface RasterOptions {
  /** Longest grid dimension in pixels (the shorter side keeps aspect). */
  gridMax?: number;
  /** Gaussian reach (m): kernels merge into a continuous field at this scale. */
  kernelMeters?: number;
}

export interface FieldRaster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** [west, south, east, north] the raster covers. */
  bbox: [number, number, number, number];
  /** True when nothing renders (all-transparent) — caller hides the layer. */
  empty: boolean;
}

const EMPTY_RASTER: FieldRaster = {
  data: new Uint8ClampedArray(4), width: 1, height: 1, bbox: [0, 0, 0, 0], empty: true,
};

/**
 * Bake `features` into an RGBA field: each site contributes a Gaussian of its
 * value `t`; cells take the MAX contribution (union of kernels), then map to the
 * ramp with a soft alpha fade near the low end. Empty input → a 1×1 transparent
 * pixel with a degenerate bbox (the caller hides the layer anyway).
 */
export function rasterizeField(features: HeatFeature[], opts: RasterOptions = {}): FieldRaster {
  const gridMax = opts.gridMax ?? GRID_MAX;
  const kernelMeters = opts.kernelMeters ?? KERNEL_METERS;
  if (features.length === 0) return EMPTY_RASTER;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    if (lon < w) w = lon; if (lon > e) e = lon;
    if (lat < s) s = lat; if (lat > n) n = lat;
  }
  const midLat = (s + n) / 2;
  const mPerLon = M_PER_DEG_LAT * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const padLat = kernelMeters / M_PER_DEG_LAT;
  const padLon = kernelMeters / mPerLon;
  w -= padLon; e += padLon; s -= padLat; n += padLat;

  const spanLon = e - w, spanLat = n - s;
  const spanXm = spanLon * mPerLon, spanYm = spanLat * M_PER_DEG_LAT;
  const aspect = spanXm / spanYm;
  const width = aspect >= 1 ? gridMax : Math.max(1, Math.round(gridMax * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(gridMax / aspect)) : gridMax;

  const sigmaX = ((kernelMeters / 2) / spanXm) * width;
  const sigmaY = ((kernelMeters / 2) / spanYm) * height;
  const krX = Math.max(1, Math.ceil(3 * sigmaX));
  const krY = Math.max(1, Math.ceil(3 * sigmaY));

  const grid = new Float32Array(width * height); // max value per cell
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    const t = f.properties.t;
    const cx = ((lon - w) / spanLon) * width;
    const cy = ((n - lat) / spanLat) * height; // pixel y grows downward
    const x0 = Math.max(0, Math.floor(cx - krX)), x1 = Math.min(width - 1, Math.ceil(cx + krX));
    const y0 = Math.max(0, Math.floor(cy - krY)), y1 = Math.min(height - 1, Math.ceil(cy + krY));
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / sigmaY;
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / sigmaX;
        const v = t * Math.exp(-0.5 * (dx * dx + dy * dy));
        const idx = y * width + x;
        if (v > grid[idx]) grid[idx] = v;
      }
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  let any = false;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v < MIN_VALUE) continue; // leave transparent
    any = true;
    const [r, g, b] = rampColor(v);
    const o = i * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b;
    data[o + 3] = Math.round(255 * clamp01((v - MIN_VALUE) / ALPHA_FADE));
  }
  return { data, width, height, bbox: [w, s, e, n], empty: !any };
}

/**
 * Bake a CONTINUOUS scalar field by evaluating `valueAt` per pixel over `bbox`,
 * for the access views (spec 2026-07-18 follow-up): unlike rasterizeField, this
 * shows access EVERYWHERE it exists — including empty land near a new station,
 * which has no demand point to splat. `valueAt` returns access in [0,1]; the
 * ramp + alpha fade match the splat path. Pixels far from stations return ~0 and
 * cost almost nothing (the access index short-circuits empty grid cells).
 */
export function rasterizeAccessField(
  bbox: [number, number, number, number],
  valueAt: (lon: number, lat: number) => number,
  opts: { gridMax?: number } = {},
): FieldRaster {
  const gridMax = opts.gridMax ?? ACCESS_GRID_MAX;
  const [w, s, e, n] = bbox;
  const spanLon = e - w, spanLat = n - s;
  if (spanLon <= 0 || spanLat <= 0) return EMPTY_RASTER;
  const midLat = (s + n) / 2;
  const mPerLon = M_PER_DEG_LAT * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const aspect = (spanLon * mPerLon) / (spanLat * M_PER_DEG_LAT);
  const width = aspect >= 1 ? gridMax : Math.max(1, Math.round(gridMax * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(gridMax / aspect)) : gridMax;

  const data = new Uint8ClampedArray(width * height * 4);
  let any = false;
  for (let y = 0; y < height; y++) {
    const lat = n - ((y + 0.5) / height) * spanLat; // pixel y grows downward
    for (let x = 0; x < width; x++) {
      const lon = w + ((x + 0.5) / width) * spanLon;
      const v = clamp01(valueAt(lon, lat));
      if (v < MIN_VALUE) continue;
      any = true;
      const [r, g, b] = rampColor(v);
      const o = (y * width + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b;
      data[o + 3] = Math.round(255 * clamp01((v - MIN_VALUE) / ALPHA_FADE));
    }
  }
  return { data, width, height, bbox, empty: !any };
}

/** Faint tint every in-domain cell gets, so a 0-pressure cell reads as "cell, low" not a hole. */
const CELL_BASELINE_ALPHA = 70;

/**
 * Bake the Cells view: the FULL nearest-anchor tessellation within the transit
 * footprint. `at` returns `{ inDomain, t }` — transparent only where there is no
 * access at all (genuine open space), otherwise every cell is drawn (cold→hot by
 * split pressure `t`) with a baseline alpha so a zero-pressure cell shows as a
 * faint region rather than vanishing into a confusing hole.
 */
export function rasterizeCellField(
  bbox: [number, number, number, number],
  at: (lon: number, lat: number) => { inDomain: boolean; t: number },
  opts: { gridMax?: number } = {},
): FieldRaster {
  const gridMax = opts.gridMax ?? ACCESS_GRID_MAX;
  const [w, s, e, n] = bbox;
  const spanLon = e - w, spanLat = n - s;
  if (spanLon <= 0 || spanLat <= 0) return EMPTY_RASTER;
  const midLat = (s + n) / 2;
  const mPerLon = M_PER_DEG_LAT * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const aspect = (spanLon * mPerLon) / (spanLat * M_PER_DEG_LAT);
  const width = aspect >= 1 ? gridMax : Math.max(1, Math.round(gridMax * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(gridMax / aspect)) : gridMax;

  const data = new Uint8ClampedArray(width * height * 4);
  let any = false;
  for (let y = 0; y < height; y++) {
    const lat = n - ((y + 0.5) / height) * spanLat;
    for (let x = 0; x < width; x++) {
      const lon = w + ((x + 0.5) / width) * spanLon;
      const { inDomain, t: rawT } = at(lon, lat);
      if (!inDomain) continue; // genuine open space (no access) → transparent
      any = true;
      const t = clamp01(rawT);
      const [r, g, b] = rampColor(t);
      const o = (y * width + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b;
      data[o + 3] = Math.round(CELL_BASELINE_ALPHA + (255 - CELL_BASELINE_ALPHA) * t);
    }
  }
  return { data, width, height, bbox, empty: !any };
}

// --- Map integration (DOM/MapLibre shell) ------------------------------------

interface MapLike {
  getSource(id: string): { updateImage?: (o: { url: string; coordinates: number[][] }) => void } | undefined;
  getLayer(id: string): unknown;
  addSource(id: string, src: unknown): void;
  addLayer(layer: unknown, beforeId?: string): void;
  removeSource(id: string): void;
  removeLayer(id: string): void;
  getStyle(): { layers?: { id: string; type: string }[] } | undefined;
}

// Base-map layers the field should be drawn OVER (user asked for airport + park;
// common green/landuse aliases included so differing styles degrade gracefully).
const COVER_LAYER = /aero|airport|runway|taxiway|apron|park|garden|green|grass|wood|forest|meadow|golf|pitch|leisure|recreation|cemetery/i;

/**
 * Where to insert the field layer. It must render ABOVE base-map fills like
 * airport aprons and parks (otherwise those paint over it), but stay BELOW the
 * labels that sit over those fills so street/place names remain readable. So:
 * find the last airport/park layer, then the first label (symbol) at or after
 * it. Falls back to the first symbol overall when no such fills exist (original
 * behavior), or to the very top when no label sits above them.
 */
let loggedLayers = false;
function fieldBeforeId(map: MapLike): string | undefined {
  try {
    const layers = map.getStyle()?.layers ?? [];
    let lastCover = -1;
    for (let i = 0; i < layers.length; i++) {
      if (COVER_LAYER.test(layers[i].id)) lastCover = i;
    }
    let beforeId: string | undefined;
    for (let i = Math.max(0, lastCover + 1); i < layers.length; i++) {
      if (layers[i].type === 'symbol') { beforeId = layers[i].id; break; }
    }
    if (!loggedLayers) {
      loggedLayers = true;
      // Confirmed against the shipped style: cover layers are parks-large,
      // parks-small, airports (all fill-extrusion); the field anchors above them
      // at ocean-depth-labels. One concise breadcrumb in case a city's style
      // names these layers differently — re-log the full list if it looks wrong.
      const covers = layers.filter((l) => COVER_LAYER.test(l.id)).map((l) => l.id);
      console.log(`[InducedDemand] field inserts before "${beforeId ?? '(top)'}"; over [${covers.join(', ')}]`);
    }
    return beforeId; // undefined → field on top (nothing above the fills)
  } catch {
    return undefined;
  }
}

interface ErredMap {
  on?: (type: string, cb: (e: { error?: { name?: string; message?: string } }) => void) => void;
  __inducedHeatErrGuard?: boolean;
}

/**
 * MapLibre's ImageSource fires a map `error` event when updateImage aborts the
 * previous in-flight load (which happens on EVERY update — each new image
 * cancels its predecessor's async decode). With no `error` listener MapLibre
 * console.errors it, so the field spammed AbortErrors on every view change.
 * Register one listener that drops those aborts and re-logs everything else,
 * matching MapLibre's own default logging for genuine errors. Idempotent per map
 * (the map is recreated on save reload; we re-arm on the next update).
 */
function installMapErrorGuard(map: unknown): void {
  const m = map as ErredMap;
  if (!m.on || m.__inducedHeatErrGuard) return;
  m.__inducedHeatErrGuard = true;
  m.on('error', (ev) => {
    const err = ev?.error;
    if (err && (err.name === 'AbortError' || /abort/i.test(err.message ?? ''))) return;
    console.error(err ?? ev); // preserve MapLibre's default visibility for real errors
  });
}

/** Register hook (called on map ready). The image source is added lazily on first update. */
export function registerHeatmap(_api: ModdingAPI): void {
  // No-op: an `image` source needs its data + geographic coordinates, which only
  // exist once we have a field to bake. `updateHeatmap` adds it on first render
  // and re-adds it after a map recreation (both are idempotent).
}

export function updateHeatmap(api: ModdingAPI, raster: FieldRaster): void {
  const rawMap = api.utils.getMap();
  if (!rawMap) return;
  installMapErrorGuard(rawMap);
  // An empty field has no bounds — feeding MapLibre a zero-area image makes
  // setCoordinates compute z = log2(size/0) = Infinity ("outside of bounds").
  // Leave any prior image in place; the caller hides the layer for empty fields.
  if (raster.empty) return;
  const map = rawMap as unknown as MapLike;
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(raster.width, raster.height);
  img.data.set(raster.data);
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  const [bw, bs, be, bn] = raster.bbox;
  const coordinates = [[bw, bn], [be, bn], [be, bs], [bw, bs]];

  const existing = map.getSource(HEAT_SOURCE_ID);
  if (existing && typeof existing.updateImage === 'function') {
    try {
      existing.updateImage({ url, coordinates });
    } catch (e) {
      // updateImage aborts the previous image load; that abort surfaces here as
      // an AbortError. The new image still applies — swallow the abort, rethrow
      // anything genuinely unexpected.
      if (!(e instanceof DOMException && e.name === 'AbortError')) throw e;
    }
    return;
  }
  try {
    if (map.getLayer(HEAT_LAYER_ID)) map.removeLayer(HEAT_LAYER_ID);
    if (map.getSource(HEAT_SOURCE_ID)) map.removeSource(HEAT_SOURCE_ID);
    map.addSource(HEAT_SOURCE_ID, { type: 'image', url, coordinates });
    map.addLayer({
      id: HEAT_LAYER_ID,
      type: 'raster',
      source: HEAT_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.8, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
    }, fieldBeforeId(map));
  } catch (e) {
    console.error('[InducedDemand] heat raster add failed', e);
  }
}

export function setHeatmapVisible(api: ModdingAPI, visible: boolean): void {
  const map = api.utils.getMap();
  if (map && map.getLayer(HEAT_LAYER_ID)) {
    map.setLayoutProperty(HEAT_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
}
