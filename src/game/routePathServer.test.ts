import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePathRequest, installRoutePathFetch } from './routePathServer';
import type { Coordinate } from '../types/core';

const COORDS: Coordinate[] = [[0, 0], [0.01, 0.005], [0.02, 0]];

/** A window-like host with a swappable fetch, as the game page provides. */
function host(realFetch: typeof fetch): { fetch: typeof fetch } {
  return { fetch: realFetch };
}
const notFound = (): Response => new Response('', { status: 404 });

test('parsePathRequest matches only our own pops on the game path endpoint', () => {
  assert.deepEqual(parsePathRequest('map://paths/DEN/induced:42'), { city: 'DEN', popId: 'induced:42' });
  // Native pops must be left to the game entirely.
  assert.equal(parsePathRequest('map://paths/DEN/0'), null);
  assert.equal(parsePathRequest('map://paths/DEN/AIR_DEN_T1'), null);
  // Anything else on the page is none of our business.
  assert.equal(parsePathRequest('map://tiles/12/34/56.png'), null);
  assert.equal(parsePathRequest('https://example.com/induced:42'), null);
  assert.equal(parsePathRequest('map://paths/DEN/induced:42/extra'), null);
  assert.equal(parsePathRequest(''), null);
});

test('unrelated requests are passed through untouched', async () => {
  const calls: unknown[] = [];
  const w = host(async (input) => { calls.push(input); return new Response('tile'); });
  installRoutePathFetch(w, () => COORDS);
  const res = await w.fetch('map://tiles/1/2/3.png');
  assert.equal(await res.text(), 'tile');
  assert.deepEqual(calls, ['map://tiles/1/2/3.png']);
});

test('a real path from the game always wins over ours', async () => {
  const real = { coordinates: [[9, 9]] };
  const w = host(async () => new Response(JSON.stringify(real), { status: 200 }));
  let providerCalled = false;
  installRoutePathFetch(w, () => { providerCalled = true; return COORDS; });
  const res = await w.fetch('map://paths/DEN/induced:1');
  assert.deepEqual(await res.json(), real);
  assert.equal(providerCalled, false, 'must not even ask us if the game has real data');
});

test('our route is served in the shape the game parses when the endpoint 404s', async () => {
  const w = host(async () => notFound());
  installRoutePathFetch(w, () => COORDS);
  const res = await w.fetch('map://paths/DEN/induced:7');
  assert.equal(res.ok, true);
  const body = await res.json() as { coordinates: Coordinate[] };
  assert.deepEqual(body.coordinates, COORDS); // getRoutePathForPop destructures `coordinates`
});

test('a throwing endpoint (no /paths/ route at all) still gets our route', async () => {
  const w = host(async () => { throw new TypeError('net::ERR_UNKNOWN_URL_SCHEME'); });
  installRoutePathFetch(w, () => COORDS);
  const res = await w.fetch('map://paths/DEN/induced:7');
  assert.equal(res.ok, true);
  assert.deepEqual((await res.json() as { coordinates: Coordinate[] }).coordinates, COORDS);
});

test('with nothing to offer we answer 404 so the game draws its straight line', async () => {
  for (const provider of [() => null, () => [], () => [[0, 0]] as Coordinate[]]) {
    const w = host(async () => { throw new Error('no endpoint'); });
    installRoutePathFetch(w, provider);
    const res = await w.fetch('map://paths/DEN/induced:7');
    assert.equal(res.status, 404, 'a 404 is the quiet fallback: the game only warns on other codes');
    assert.equal(res.ok, false);
  }
});

test('a throwing provider never breaks the page', async () => {
  const w = host(async () => notFound());
  installRoutePathFetch(w, () => { throw new Error('router exploded'); });
  const res = await w.fetch('map://paths/DEN/induced:7');
  assert.equal(res.status, 404);
});

test('installing twice does not stack wrappers, and uninstall restores the original', async () => {
  const original: typeof fetch = async () => notFound();
  const w = host(original);
  const uninstall = installRoutePathFetch(w, () => COORDS);
  const patched = w.fetch;
  const uninstall2 = installRoutePathFetch(w, () => [[5, 5], [6, 6]] as Coordinate[]);
  assert.equal(w.fetch, patched, 'the wrapper is installed once; only the provider is swapped');
  // The newest provider wins — a mod reload must take over cleanly.
  assert.deepEqual((await (await w.fetch('map://paths/DEN/induced:1')).json() as { coordinates: Coordinate[] }).coordinates, [[5, 5], [6, 6]]);
  uninstall2();
  uninstall();
  assert.equal(w.fetch, original);
});

test('the provider receives the city and pop id from the url', async () => {
  const seen: string[] = [];
  const w = host(async () => notFound());
  installRoutePathFetch(w, (city, popId) => { seen.push(`${city}/${popId}`); return COORDS; });
  await w.fetch('map://paths/NYC/induced:123');
  assert.deepEqual(seen, ['NYC/induced:123']);
});

test('Request and URL inputs are handled, not just strings', async () => {
  const w = host(async () => notFound());
  installRoutePathFetch(w, () => COORDS);
  const viaRequest = await w.fetch(new Request('map://paths/DEN/induced:1'));
  assert.equal(viaRequest.ok, true);
});
