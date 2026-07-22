/**
 * Fine "blocked" raster: water + airport polygons scan-filled ONCE into a
 * bit-per-cell mask over a bbox, so split placement can ask "is anything blocked
 * within R metres of this point?" as an O(cells-in-disc) bitset scan instead of
 * point-in-polygon tests at a few sample points. A discrete point almost never
 * lands exactly inside a polygon, and an 8-point ring straddles thin rivers — a
 * fine raster covers the whole neighbourhood at a real resolution (cellM).
 *
 * Built from the same raw polygons the game loads (ocean_depth_index.json rings
 * + runways_taxiways.geojson), so the mod and the offline harness agree.
 */
import type { Coordinate } from '../types/core';
import type { OceanDepthFile } from './waterIndex';
import type { AirportFeatureCollection } from './airportIndex';

export type Ring = [number, number][];

const M_PER_DEG_LAT = 111194.9;

export interface BlockedRaster {
  /** True if any blocked cell lies within `radiusM` of `c` (disc scan; radius 0 = the cell at `c`). */
  blockedWithin(c: Coordinate, radiusM: number): boolean;
  /** Fraction of cells set (diagnostic). */
  readonly coverage: number;
}

/** Scan-fill `polys` (each a ring list, even-odd) into a bit-per-cell mask over `bbox`. */
export function buildBlockedRaster(polys: Ring[][], bbox: [number, number, number, number], cellM: number): BlockedRaster {
  const [W, S, E, N] = bbox;
  const midLat = (S + N) / 2;
  const mPerLon = M_PER_DEG_LAT * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const dLon = cellM / mPerLon; // degrees lon per cell
  const dLat = cellM / M_PER_DEG_LAT; // degrees lat per cell
  const cols = Math.max(1, Math.ceil((E - W) / dLon));
  const rows = Math.max(1, Math.ceil((N - S) / dLat));
  const bits = new Uint8Array(Math.ceil((cols * rows) / 8));
  let set = 0;
  const setCell = (col: number, row: number): void => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    const i = row * cols + col;
    const b = i >> 3, m = 1 << (i & 7);
    if (!(bits[b] & m)) { bits[b] |= m; set++; }
  };

  for (const rings of polys) {
    if (!rings.length || !rings[0]?.length) continue;
    let s = Infinity, n = -Infinity;
    for (const ring of rings) for (const [, lat] of ring) { if (lat < s) s = lat; if (lat > n) n = lat; }
    const r0 = Math.max(0, Math.floor((s - S) / dLat));
    const r1 = Math.min(rows - 1, Math.ceil((n - S) / dLat));
    for (let row = r0; row <= r1; row++) {
      const latC = S + (row + 0.5) * dLat; // cell-centre lat = the scanline
      const xs: number[] = [];
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
          if ((yi > latC) !== (yj > latC)) xs.push(xi + ((xj - xi) * (latC - yi)) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const cA = Math.round((xs[k] - W) / dLon - 0.5);
        const cB = Math.round((xs[k + 1] - W) / dLon - 0.5);
        for (let col = Math.max(0, cA); col <= Math.min(cols - 1, cB); col++) setCell(col, row);
      }
    }
  }

  const getCell = (col: number, row: number): boolean => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
    const i = row * cols + col;
    return (bits[i >> 3] & (1 << (i & 7))) !== 0;
  };
  return {
    coverage: set / (cols * rows),
    blockedWithin([lon, lat]: Coordinate, radiusM: number): boolean {
      const col0 = Math.floor((lon - W) / dLon), row0 = Math.floor((lat - S) / dLat);
      const rc = Math.max(0, Math.round(radiusM / cellM));
      for (let dr = -rc; dr <= rc; dr++) {
        for (let dc = -rc; dc <= rc; dc++) {
          if (dc * dc + dr * dr > rc * rc) continue; // disc, not square
          if (getCell(col0 + dc, row0 + dr)) return true;
        }
      }
      return false;
    },
  };
}

/**
 * Build a blocked raster from the raw game/dump masks: water polygons
 * (ocean_depth_index rings) + airport polygons (runways_taxiways features),
 * scan-filled together over the water bbox (or the airport extent when there's
 * no water). Returns null when neither mask is present.
 */
export function buildBlockedRasterFromFiles(
  water: OceanDepthFile | null | undefined,
  airport: AirportFeatureCollection | null | undefined,
  cellM: number,
): BlockedRaster | null {
  const polys: Ring[][] = [];
  if (water) for (const d of water.depths) polys.push(d.p);
  if (airport) {
    for (const f of airport.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'Polygon') polys.push(g.coordinates as Ring[]);
      else if (g.type === 'MultiPolygon') for (const rings of g.coordinates as Ring[][]) polys.push(rings);
    }
  }
  if (!polys.length) return null;
  let bbox = water?.bbox ?? null;
  if (!bbox) { // no water file → bound to the airport polygons
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const rings of polys) for (const [lon, lat] of rings[0] ?? []) {
      if (lon < w) w = lon; if (lon > e) e = lon; if (lat < s) s = lat; if (lat > n) n = lat;
    }
    if (!Number.isFinite(w)) return null;
    bbox = [w, s, e, n];
  }
  return buildBlockedRaster(polys, bbox, cellM);
}
