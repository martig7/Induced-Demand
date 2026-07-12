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

/** History-day feature: adds are green, removes red; the layer reads `color` directly. */
export interface HistoryFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: Coordinate };
  properties: { id: string; value: number; t: number; color: string };
}

export interface HistoryFeatureCollection {
  type: 'FeatureCollection';
  features: HistoryFeature[];
  /** Max count across all features of the day (both colors) — legend + normalization. */
  maxValue: number;
}
