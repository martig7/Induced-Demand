import type { Coordinate } from '../types/core';

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters between two [lon, lat] points. */
export function haversine(a: Coordinate, b: Coordinate): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Walking time in seconds at `walkSpeed` m/s. */
export function walkSeconds(a: Coordinate, b: Coordinate, walkSpeed: number): number {
  return haversine(a, b) / walkSpeed;
}
