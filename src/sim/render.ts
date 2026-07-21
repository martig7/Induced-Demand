/**
 * Render a SimResult to a standalone HTML page: two SVG panels (before / after)
 * of demand points — circle area ∝ people mass, hue = job share — over the drawn
 * network, with materialized (induced) points ringed. Zero-dependency string
 * output; the harness writes it to disk and the user opens it in a browser.
 */
import type { SimResult, Snapshot, NetworkView } from './harness';

const RES_COLOR = [74, 144, 217];  // blue
const JOB_COLOR = [232, 131, 58];  // orange

interface Proj { x(lon: number): number; y(lat: number): number; w: number; h: number; }

function projectionFor(result: SimResult, size: number): Proj {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const eat = (lon: number, lat: number): void => {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  };
  for (const p of result.after.points) eat(p.lon, p.lat);
  for (const s of result.network.stations) eat(s.lon, s.lat);
  if (!Number.isFinite(minLon)) { minLon = 0; maxLon = 1; minLat = 0; maxLat = 1; }
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max(1e-9, (maxLon - minLon) * kx);
  const spanY = Math.max(1e-9, maxLat - minLat);
  const pad = 12;
  const scale = (size - 2 * pad) / Math.max(spanX, spanY);
  const w = spanX * scale + 2 * pad;
  const h = spanY * scale + 2 * pad;
  return {
    x: (lon) => pad + (lon - minLon) * kx * scale,
    y: (lat) => pad + (maxLat - lat) * scale, // flip: north up
    w, h,
  };
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${Math.round(n)}`;
}

function lerpColor(t: number): string {
  const c = RES_COLOR.map((r, i) => Math.round(r + t * (JOB_COLOR[i] - r)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function panel(title: string, snap: Snapshot, network: NetworkView, proj: Proj, rScale: number): string {
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${proj.w.toFixed(1)} ${proj.h.toFixed(1)}" width="100%" preserveAspectRatio="xMidYMid meet">`);
  // network lines under the points
  for (const line of network.lines) {
    const pts = line.coords.map(([lon, lat]) => `${proj.x(lon).toFixed(1)},${proj.y(lat).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="#888" stroke-width="1.5" stroke-opacity="0.5"/>`);
  }
  // demand points (skip empties to bound size)
  for (const p of snap.points) {
    const mass = p.residents + p.jobs;
    if (mass <= 0) continue;
    const r = rScale * Math.sqrt(mass);
    const t = mass > 0 ? p.jobs / mass : 0.5;
    const cx = proj.x(p.lon).toFixed(1), cy = proj.y(p.lat).toFixed(1);
    if (p.materialized) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="${lerpColor(t)}" fill-opacity="0.75" stroke="#5fe08a" stroke-width="0.8"/>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="${lerpColor(t)}" fill-opacity="0.55"/>`);
    }
  }
  parts.push('</svg>');
  // stats
  let res = 0, jobs = 0, mat = 0;
  for (const p of snap.points) { res += p.residents; jobs += p.jobs; if (p.materialized) mat++; }
  const stats = `<div class="stats">${fmt(res)} residents · ${fmt(jobs)} jobs · ${snap.points.length} points`
    + (mat > 0 ? ` · <span class="mat">${mat} induced</span>` : '') + `</div>`;
  return `<figure><figcaption>${title}</figcaption>${stats}<div class="plot">${parts.join('')}</div></figure>`;
}

export function renderHtml(result: SimResult): string {
  const proj = projectionFor(result, 900);
  // Scale radii so the largest post-sim point reads ~9px.
  let maxMass = 1;
  for (const p of result.after.points) maxMass = Math.max(maxMass, p.residents + p.jobs);
  const rScale = 9 / Math.sqrt(maxMass);
  const before = panel(`Before — day 0`, result.before, result.network, proj, rScale);
  const after = panel(`After — day ${result.days}`, result.after, result.network, proj, rScale);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Induced Demand — ${result.city}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #14171c; color: #e6e6e6; font: 14px system-ui, sans-serif; }
  header { padding: 12px 16px; border-bottom: 1px solid #2a2f38; }
  header h1 { margin: 0 0 4px; font-size: 16px; }
  header .sub { color: #9aa4b2; font-size: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
  figure { margin: 0; background: #1a1e25; border: 1px solid #2a2f38; border-radius: 8px; padding: 10px; min-width: 0; }
  figcaption { font-weight: 600; margin-bottom: 2px; }
  .stats { color: #9aa4b2; font-size: 12px; margin-bottom: 8px; }
  .stats .mat { color: #5fe08a; }
  .plot { overflow: auto; }
  .legend { display: flex; gap: 16px; align-items: center; color: #9aa4b2; font-size: 12px; }
  .legend .sw { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 4px; vertical-align: -2px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
</style></head><body>
<header>
  <h1>Induced Demand simulation — ${result.city}</h1>
  <div class="sub">${result.days} days · circle area ∝ people, hue = residential→job share</div>
  <div class="legend" style="margin-top:6px">
    <span><span class="sw" style="background:${lerpColor(0)}"></span>residential</span>
    <span><span class="sw" style="background:${lerpColor(1)}"></span>jobs</span>
    <span><span class="sw" style="background:#333;border:1.5px solid #5fe08a"></span>induced point</span>
    <span><span class="sw" style="background:none;border-top:2px solid #888;border-radius:0;height:0"></span>line</span>
  </div>
</header>
<div class="grid">${before}${after}</div>
</body></html>`;
}
