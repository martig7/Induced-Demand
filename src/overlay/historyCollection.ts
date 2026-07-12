import type { DayHistoryEntry } from '../model/history';
import type { DemandPoint } from '../types/game-state';
import type { OverlayMetric, HistoryFeature, HistoryFeatureCollection } from './types';

export const HISTORY_ADDED = '#2ecc71';
export const HISTORY_REMOVED = '#e74c3c';

/**
 * Build the green/red overlay for one history day. Pure. Counts follow the panel's
 * metric toggle: residential → home-side (`ar`/`rr`), commercial → work-side
 * (`aj`/`rj`), combined → both. `t` is normalized against the day's max count
 * across BOTH colors so green and red sizes are comparable; removed features are
 * emitted first so added (green) renders on top where they overlap.
 */
export function buildHistoryOverlay(
  entry: DayHistoryEntry,
  points: ReadonlyMap<string, DemandPoint>,
  metric: OverlayMetric,
): HistoryFeatureCollection {
  const removed: HistoryFeature[] = [];
  const added: HistoryFeature[] = [];
  let maxValue = 0;

  for (const [id, d] of Object.entries(entry.deltas)) {
    const p = points.get(id);
    if (!p) continue; // point no longer exists on the live map
    const addCount = metric === 'residential' ? d.ar : metric === 'commercial' ? d.aj : d.ar + d.aj;
    const remCount = metric === 'residential' ? d.rr : metric === 'commercial' ? d.rj : d.rr + d.rj;
    if (remCount > 0) {
      removed.push(feature(id, p, remCount, HISTORY_REMOVED));
      if (remCount > maxValue) maxValue = remCount;
    }
    if (addCount > 0) {
      added.push(feature(id, p, addCount, HISTORY_ADDED));
      if (addCount > maxValue) maxValue = addCount;
    }
  }

  const features = [...removed, ...added];
  for (const f of features) f.properties.t = maxValue > 0 ? f.properties.value / maxValue : 0;
  return { type: 'FeatureCollection', features, maxValue };
}

function feature(id: string, p: DemandPoint, value: number, color: string): HistoryFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: p.location },
    properties: { id, value, t: 0, color },
  };
}
