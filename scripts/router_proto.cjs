const fs = require('fs'), zlib = require('zlib');
const CITY = process.argv[2] || 'DEN';
const t = (l) => { const n = process.hrtime.bigint(); return () => { console.log(`${l}: ${(Number(process.hrtime.bigint() - n) / 1e6).toFixed(0)} ms`); }; };
const R = 6371000, rad = (x) => x * Math.PI / 180;
const hav = (a, b) => { const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat/2)**2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s)); };

let done = t('parse roads');
const geo = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${process.env.APPDATA}/metro-maker4/cities/data/${CITY}/roads.geojson.gz`)));
done();

// ---- build graph: split ways at shared nodes ----
done = t('build graph');
const key = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const useCount = new Map();
for (const f of geo.features) for (const c of f.geometry.coordinates) useCount.set(key(c), (useCount.get(key(c)) || 0) + 1);
const nodeId = new Map(); const nodeXY = [];
const getNode = (c) => { const k = key(c); let id = nodeId.get(k);
  if (id === undefined) { id = nodeXY.length; nodeId.set(k, id); nodeXY.push(c); } return id; };
const CLASS = { highway: 0, major: 1, minor: 2 };
const head = []; const nextEdge = []; const to = []; const wlen = []; const wclass = [];
const addEdge = (a, b, len, cls) => {
  to.push(b); wlen.push(len); wclass.push(cls); nextEdge.push(head[a] ?? -1); head[a] = to.length - 1;
};
for (const f of geo.features) {
  const cls = CLASS[f.properties.roadClass] ?? 2;
  const cs = f.geometry.coordinates;
  let anchor = getNode(cs[0]), acc = 0;
  for (let i = 1; i < cs.length; i++) {
    acc += hav(cs[i - 1], cs[i]);
    const isJunction = useCount.get(key(cs[i])) > 1 || i === cs.length - 1;
    if (isJunction) { const n = getNode(cs[i]);
      if (n !== anchor && acc > 0) { addEdge(anchor, n, acc, cls); addEdge(n, anchor, acc, cls); }
      anchor = n; acc = 0; }
  }
}
done();
console.log(`nodes: ${nodeXY.length}  directed edges: ${to.length}`);

// ---- spatial grid for snapping ----
const CELL = 0.005;
const grid = new Map();
const gk = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
for (let i = 0; i < nodeXY.length; i++) { const k = gk(nodeXY[i][0], nodeXY[i][1]);
  let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); }
const snap = (c) => { for (let ring = 0; ring < 8; ring++) { let best = -1, bd = Infinity;
    const cx = Math.floor(c[0] / CELL), cy = Math.floor(c[1] / CELL);
    for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
      if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
      for (const i of grid.get(`${cx + dx},${cy + dy}`) || []) { const d = hav(c, nodeXY[i]); if (d < bd) { bd = d; best = i; } }
    }
    if (best >= 0) return { node: best, dist: bd };
  } return null; };

// ---- A* on TIME with per-class speeds; returns per-class path lengths ----
const dist = new Float64Array(nodeXY.length);
const prevE = new Int32Array(nodeXY.length);
const stamp = new Int32Array(nodeXY.length); let run = 0;
function astarTime(s, g, V, VMAX) {
  run++; const h = (n) => hav(nodeXY[n], nodeXY[g]) / VMAX;
  const heap = [[h(s), s]]; dist[s] = 0; stamp[s] = run; prevE[s] = -1;
  let pops = 0;
  const push = (it) => { heap.push(it); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top; };
  while (heap.length) {
    const [f, n] = pop(); pops++;
    if (n === g) { // unwind per-class lengths
      const L = [0, 0, 0]; let cur = n;
      while (prevE[cur] !== -1) { const e = prevE[cur]; L[wclass[e]] += wlen[e]; cur = to[e ^ 1]; }
      return { time: dist[n], L, pops };
    }
    if (f - h(n) > dist[n] + 1e-9) continue;
    for (let e = head[n] ?? -1; e !== -1; e = nextEdge[e]) {
      const m = to[e], nd = dist[n] + wlen[e] / V[wclass[e]];
      if (stamp[m] !== run || nd < dist[m]) { stamp[m] = run; dist[m] = nd; prevE[m] = e; push([nd + h(m), m]); }
    }
  }
  return null;
}

const dd = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${process.env.APPDATA}/metro-maker4/cities/data/${CITY}/demand_data.json.gz`)));
const loc = new Map(dd.points.map((p) => [p.id, p.location]));
const N = +(process.argv[3] || 300);
const sample = dd.pops.filter((p) => loc.get(p.residenceId) && loc.get(p.jobId)).slice(0, N);
const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];

function evaluate(V, label) {
  const VMAX = Math.max(...V);
  const rows = []; let fails = 0, pops = 0;
  const t0 = process.hrtime.bigint();
  for (const p of sample) {
    const a = snap(loc.get(p.residenceId)), b = snap(loc.get(p.jobId));
    if (!a || !b) { fails++; continue; }
    const r = astarTime(a.node, b.node, V, VMAX);
    if (!r) { fails++; continue; }
    pops += r.pops;
    rows.push({ L: r.L, len: r.L[0] + r.L[1] + r.L[2], time: r.time, real: p.drivingDistance, secs: p.drivingSeconds,
      straight: hav(loc.get(p.residenceId), loc.get(p.jobId)) });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const dr = rows.map((r) => r.len / r.real), tr = rows.map((r) => r.time / r.secs);
  console.log(`\n[${label}] V=[hw ${V[0]}, maj ${V[1]}, min ${V[2]}] ${(ms/rows.length).toFixed(1)} ms/query, ${(pops/rows.length).toFixed(0)} pops, ${fails} fails`);
  console.log(`  routed/real DISTANCE  p10 ${q(dr,.1).toFixed(3)}  median ${q(dr,.5).toFixed(3)}  p90 ${q(dr,.9).toFixed(3)}`);
  console.log(`  routed/real TIME      p10 ${q(tr,.1).toFixed(3)}  median ${q(tr,.5).toFixed(3)}  p90 ${q(tr,.9).toFixed(3)}`);
  console.log(`  detour routed ${q(rows.map(r=>r.len/r.straight),.5).toFixed(3)} vs real ${q(rows.map(r=>r.real/r.straight),.5).toFixed(3)}`);
  return rows;
}

// Fit inverse speeds by least squares:  secs ~= Lh*x0 + Lm*x1 + Ln*x2
function fitInverseSpeeds(rows) {
  const A = [[0,0,0],[0,0,0],[0,0,0]], bv = [0,0,0];
  for (const r of rows) { for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += r.L[i]*r.L[j]; bv[i] += r.L[i]*r.secs; } }
  // solve 3x3 (Gaussian elimination)
  const M = A.map((row, i) => [...row, bv[i]]);
  for (let i = 0; i < 3; i++) {
    let piv = i; for (let k = i+1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let k = i+1; k < 3; k++) { const f = M[k][i]/M[i][i]; for (let j = i; j < 4; j++) M[k][j] -= f*M[i][j]; }
  }
  const x = [0,0,0];
  for (let i = 2; i >= 0; i--) { let sum = M[i][3]; for (let j = i+1; j < 3; j++) sum -= M[i][j]*x[j]; x[i] = sum/M[i][i]; }
  return x.map((inv) => 1/inv);
}

let V = [28, 15, 8];              // initial guess: highway / major / minor m/s
let rows = evaluate(V, 'initial guess');
for (let iter = 1; iter <= 2; iter++) {
  V = fitInverseSpeeds(rows).map((v) => Math.max(2, Math.min(45, v)));
  rows = evaluate(V.map((v) => +v.toFixed(2)), `fitted pass ${iter}`);
}
