import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rampColor, rasterizeAccessField, rasterizeAccessFieldChunked, contrastStretch } from './heatmap';

test('rampColor: endpoints and midpoint match the palette', () => {
  assert.deepEqual(rampColor(0), [237, 248, 251]);   // RAMP_LOW #edf8fb
  assert.deepEqual(rampColor(1), [129, 15, 124]);    // RAMP_HIGH #810f7c
  assert.deepEqual(rampColor(0.5), [140, 150, 198]); // RAMP_MID #8c96c6
  assert.deepEqual(rampColor(-5), rampColor(0));     // clamped
  assert.deepEqual(rampColor(5), rampColor(1));
});

test('contrastStretch: normalizes to the field max then gamma-lifts', () => {
  assert.equal(contrastStretch(0.3, 0), 0);        // empty field → 0
  assert.equal(contrastStretch(0, 0.5), 0);        // no access → 0
  assert.equal(contrastStretch(0.4, 0.4), 1);      // the field max maps to the ramp top
  // gamma < 1 lifts a mid value above its linear normalized position.
  assert.ok(contrastStretch(0.25, 0.5) > 0.5, 'half-max reads hotter than 50%');
  // monotonic in raw.
  assert.ok(contrastStretch(0.3, 0.6) > contrastStretch(0.2, 0.6));
});

test('rasterizeAccessField contrast: a low-peak field still reaches the hot ramp end', () => {
  const valueAt = (lon: number) => lon * 0.4; // access peaks at ~0.4, never near 1
  const east = (r: ReturnType<typeof rasterizeAccessField>) => {
    const x = r.width - 1, y = Math.floor(r.height / 2);
    const o = (y * r.width + x) * 4;
    return [r.data[o], r.data[o + 1], r.data[o + 2]];
  };
  const raw = rasterizeAccessField([0, 0, 1, 1], valueAt, { gridMax: 20 });
  const stretched = rasterizeAccessField([0, 0, 1, 1], valueAt, { gridMax: 20, contrast: true });
  // Raw: the 0.4 peak sits low on the ramp → pale. Stretched: it normalizes to
  // the field max → the ramp top (deep purple #810f7c) exactly.
  assert.deepEqual(east(stretched), [129, 15, 124]);
  assert.notDeepEqual(east(raw), [129, 15, 124]);
});

test('rasterizeAccessField: paints the continuous field where access is positive', () => {
  // High access only in the eastern half of the bbox → west transparent, east hot.
  const r = rasterizeAccessField([0, 0, 1, 1], (lon) => (lon > 0.5 ? 0.9 : 0), { gridMax: 20 });
  assert.equal(r.empty, false);
  const px = (fx: number, fy: number) => {
    const x = Math.floor(fx * r.width), y = Math.floor(fy * r.height);
    return r.data[(y * r.width + x) * 4 + 3]; // alpha
  };
  assert.ok(px(0.8, 0.5) > 200, 'east is opaque (high access)');
  assert.equal(px(0.2, 0.5), 0, 'west is transparent (no access)');
  assert.deepEqual(r.bbox, [0, 0, 1, 1]); // domain is honored exactly (no kernel padding)
});

test('rasterizeAccessField: all-zero field is empty; degenerate bbox is empty', () => {
  assert.equal(rasterizeAccessField([0, 0, 1, 1], () => 0, { gridMax: 8 }).empty, true);
  assert.equal(rasterizeAccessField([0, 0, 0, 0], () => 0.9, { gridMax: 8 }).empty, true);
});

test('rasterizeAccessFieldChunked: byte-identical to the sync raw path, any slice cadence', async () => {
  const valueAt = (lon: number, lat: number) => (lon > 0.3 && lat < 0.7 ? 0.2 + lon * 0.5 : 0);
  const hatchAt = (lon: number) => lon > 0.6;
  const sync = rasterizeAccessField([0, 0, 1, 1], valueAt, { gridMax: 30, hatchAt });
  // Injected monotonic clock: sliceMs=0 yields after every row, a huge budget never yields.
  const clock = () => { let t = 0; return () => (t += 1); };
  for (const sliceMs of [0, 1e9]) {
    let yields = 0;
    const chunked = await rasterizeAccessFieldChunked([0, 0, 1, 1], valueAt, {
      gridMax: 30, hatchAt, sliceMs, now: clock(), yieldFn: () => { yields++; return Promise.resolve(); },
    });
    assert.deepEqual(Array.from(chunked.data), Array.from(sync.data), `sliceMs=${sliceMs} pixels`);
    assert.equal(chunked.empty, sync.empty);
    if (sliceMs === 0) assert.ok(yields > 0, 'a zero budget yields between rows');
    if (sliceMs === 1e9) assert.equal(yields, 0, 'a huge budget never yields');
  }
});

test('rasterizeAccessField: hatchAt punches transparent diagonal stripes into a solid fill', () => {
  const solid = rasterizeAccessField([0, 0, 1, 1], () => 0.9, { gridMax: 20 });
  const hatched = rasterizeAccessField([0, 0, 1, 1], () => 0.9, { gridMax: 20, hatchAt: () => true });
  const opaque = (r: ReturnType<typeof rasterizeAccessField>) => {
    let count = 0;
    for (let i = 3; i < r.data.length; i += 4) if (r.data[i] > 0) count++;
    return count;
  };
  assert.equal(opaque(solid), solid.width * solid.height, 'solid fills every pixel');
  const h = opaque(hatched);
  assert.ok(h > 0 && h < opaque(solid), `hatch drops ~half the pixels (got ${h})`);
  assert.equal(hatched.empty, false);
});
