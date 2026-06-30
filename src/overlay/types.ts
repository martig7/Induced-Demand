import type { Coordinate } from '../types/core';

export type OverlayView = 'realized' | 'targeting';
export type OverlayMetric = 'residential' | 'commercial' | 'combined';

export interface OverlayFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: Coordinate };
  properties: { id: string; value: number; t: number };
}

export interface OverlayFeatureCollection {
  type: 'FeatureCollection';
  features: OverlayFeature[];
  /** Max raw value across included features (0 if none) — used for the legend and normalization. */
  maxValue: number;
}
