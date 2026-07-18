import type { DemandData, DemandPoint } from '../types/game-state';
import type { InducedDemandConfig } from '../model/config';
import { residentialScore, commercialScore } from '../model/score';
import { INDUCED_PREFIX } from '../model/popFactory';
import type { OverlayView, OverlayMetric, OverlayFeature, OverlayFeatureCollection } from './types';

/**
 * Build a normalized GeoJSON FeatureCollection for the selected view + metric. Pure.
 *
 * Realized: the induced demand the mod added IS the `induced:` pops, so we tally
 * induced pop sizes per point (residence side = residential, job side = commercial).
 * This is baseline-independent — robust to any drift in the model's stored baselines.
 * Targeting: the model's transit-attractiveness score per point.
 */
export function buildOverlay(
  dd: DemandData,
  accessOf: (p: DemandPoint) => { res: number; com: number },
  view: OverlayView,
  metric: OverlayMetric,
  cfg: InducedDemandConfig,
): OverlayFeatureCollection {
  const indRes: Record<string, number> = {};
  const indJob: Record<string, number> = {};
  if (view === 'realized') {
    for (const pop of dd.popsMap.values()) {
      if (!pop.id.startsWith(INDUCED_PREFIX)) continue;
      indRes[pop.residenceId] = (indRes[pop.residenceId] ?? 0) + pop.size;
      indJob[pop.jobId] = (indJob[pop.jobId] ?? 0) + pop.size;
    }
  }

  const features: OverlayFeature[] = [];
  let maxValue = 0;

  for (const p of dd.points.values()) {
    let value: number;
    if (view === 'realized') {
      const r = indRes[p.id] ?? 0;
      const j = indJob[p.id] ?? 0;
      value = metric === 'residential' ? r : metric === 'commercial' ? j : r + j;
    } else {
      const a = accessOf(p);
      const sRes = residentialScore(p, a.res);
      const sJob = commercialScore(p, a.com);
      value = metric === 'residential' ? sRes : metric === 'commercial' ? sJob : sRes + sJob;
    }
    if (value > 0) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.location }, properties: { id: p.id, value, t: 0 } });
      if (value > maxValue) maxValue = value;
    }
  }

  for (const f of features) f.properties.t = maxValue > 0 ? f.properties.value / maxValue : 0;
  return { type: 'FeatureCollection', features, maxValue };
}
