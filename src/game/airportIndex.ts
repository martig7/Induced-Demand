/**
 * Point-in-airport test over the per-city `runways_taxiways.geojson` (aeroway
 * apron + runway POLYGONS). Grid-buckets each polygon by its bbox cells; a query
 * tests only the polygons in its cell — airports are localized, so nearly every
 * cell is empty and the test is O(1) off-airport. Mirrors WaterIndex; used to
 * forbid materializing demand points on airports (findCut → deps.isAirport).
 */
import type { Coordinate } from '../types/core';
import { inPolygon } from './waterIndex';

type Ring = [number, number][];

export interface AirportFeatureCollection {
  features: { geometry: { type: string; coordinates: unknown } | null }[];
}

export interface AirportIndex {
  isAirport(c: Coordinate): boolean;
}

const CELL = 0.02; // ~2 km grid cells (airport polygons are large)

export function buildAirportIndex(geojson: AirportFeatureCollection): AirportIndex {
  const polys: { b: [number, number, number, number]; rings: Ring[] }[] = [];
  const addPoly = (rings: Ring[]): void => {
    if (!rings.length || !rings[0]?.length) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lon, lat] of rings[0]) {
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    polys.push({ b: [w, s, e, n], rings });
  };
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') addPoly(g.coordinates as Ring[]);
    else if (g.type === 'MultiPolygon') for (const rings of g.coordinates as Ring[][]) addPoly(rings);
  }

  const grid = new Map<string, number[]>();
  const key = (col: number, row: number): string => `${col},${row}`;
  polys.forEach((p, i) => {
    const [w, s, e, n] = p.b;
    for (let col = Math.floor(w / CELL); col <= Math.floor(e / CELL); col++) {
      for (let row = Math.floor(s / CELL); row <= Math.floor(n / CELL); row++) {
        const k = key(col, row);
        const b = grid.get(k);
        if (b) b.push(i); else grid.set(k, [i]);
      }
    }
  });

  return {
    isAirport([lon, lat]: Coordinate): boolean {
      const cand = grid.get(key(Math.floor(lon / CELL), Math.floor(lat / CELL)));
      if (!cand) return false;
      for (const i of cand) {
        const p = polys[i];
        const [w, s, e, n] = p.b;
        if (lon < w || lon > e || lat < s || lat > n) continue;
        if (inPolygon(lon, lat, p.rings)) return true;
      }
      return false;
    },
  };
}
