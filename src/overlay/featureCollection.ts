import type { DemandData, Station } from '../types/game-state';
import type { InducedDemandConfig } from '../model/config';
import type { LedgerState } from '../model/ledger';
import { access, type AccessStation } from '../model/access';
import { residentialScore, commercialScore } from '../model/score';
import type { OverlayView, OverlayMetric, OverlayFeature, OverlayFeatureCollection } from './types';

/** Build a normalized GeoJSON FeatureCollection for the selected view + metric. Pure. */
export function buildOverlay(
  dd: DemandData,
  ledger: LedgerState,
  stations: Station[],
  view: OverlayView,
  metric: OverlayMetric,
  cfg: InducedDemandConfig,
): OverlayFeatureCollection {
  const accessStations: AccessStation[] = stations.map((s) => ({ coords: s.coords, lineIds: s.routeIds ?? [] }));
  const features: OverlayFeature[] = [];
  let maxValue = 0;

  for (const p of dd.points.values()) {
    let value: number;
    if (view === 'realized') {
      const e = ledger.points[p.id];
      const baseRes = e ? e.baselineResidents : p.residents;
      const baseJob = e ? e.baselineJobs : p.jobs;
      const indRes = Math.max(0, p.residents - baseRes);
      const indJob = Math.max(0, p.jobs - baseJob);
      value = metric === 'residential' ? indRes : metric === 'commercial' ? indJob : indRes + indJob;
    } else {
      const a = access(p.location, accessStations, cfg);
      const sRes = residentialScore(p, a);
      const sJob = commercialScore(p, a);
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
