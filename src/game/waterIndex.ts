/**
 * O(1) point-in-water test over the game's per-city `ocean_depth_index.json`
 * (spec §facts 3 — despite the name it covers lakes and rivers; verified on ATL).
 * Structure: a lon/lat grid (`cs` degrees per cell over `bbox`) where `cells`
 * lists only water-touching cells with the indices of the polygons they touch.
 * Test = cell lookup → even-odd point-in-polygon over that cell's few polygons.
 */
import type { Coordinate } from '../types/core';

export interface OceanDepthFile {
  cs: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** [cols, rows] */
  grid: [number, number];
  /** Each entry: [col, row, ...polygonIndices] */
  cells: number[][];
  depths: {
    b: [number, number, number, number];
    d: number;
    /** Rings of [lon, lat]; first ring outer, later rings holes (even-odd). */
    p: [number, number][][];
  }[];
}

export interface WaterIndex {
  isWater(c: Coordinate): boolean;
}

/** Even-odd rule across all rings of one polygon. */
export function inPolygon(lon: number, lat: number, rings: [number, number][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export function buildWaterIndex(file: OceanDepthFile): WaterIndex {
  const cellPolys = new Map<number, number[]>();
  const [cols] = file.grid;
  for (const entry of file.cells) {
    const [col, row, ...polys] = entry;
    cellPolys.set(row * cols + col, polys);
  }
  const [west, south, east, north] = file.bbox;
  return {
    isWater([lon, lat]: Coordinate): boolean {
      if (lon < west || lon > east || lat < south || lat > north) return false;
      const col = Math.floor((lon - west) / file.cs);
      const row = Math.floor((lat - south) / file.cs);
      const polys = cellPolys.get(row * cols + col);
      if (!polys) return false;
      for (const pi of polys) {
        const d = file.depths[pi];
        if (!d) continue;
        const [bw, bs, be, bn] = d.b;
        if (lon < bw || lon > be || lat < bs || lat > bn) continue;
        if (inPolygon(lon, lat, d.p)) return true;
      }
      return false;
    },
  };
}
