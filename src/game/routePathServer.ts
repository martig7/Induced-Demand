/**
 * Serves the driving route the game already asks for.
 *
 * The pop-details view calls `getRoutePathForPop(cityCode, popId)`, which fetches
 * `map://paths/<city>/<popId>` and draws the returned `{coordinates}` as a red line —
 * falling back to a straight home→work line when the request fails. In this build the
 * `map://` handler implements only `/tiles/` and no city ships path data, so that
 * request ALWAYS fails and every pop gets the straight line. Verified against the
 * v1.4.10 bundle; see docs/superpowers/specs/2026-07-12-driving-model-design.md.
 *
 * Since we route our own pops anyway (model/router), we can answer that request. The
 * interception is deliberately narrow:
 *  - only `map://paths/<city>/induced:<n>` — native pops and every other URL are
 *    passed straight through to the real fetch, untouched;
 *  - the real endpoint is tried FIRST and its answer wins, so if the game ever ships
 *    real paths, ours silently steps aside;
 *  - any failure on our side returns 404, which is exactly what the game sees today
 *    (and the one status it does not warn about), so the worst case is current
 *    behaviour.
 */
import type { Coordinate } from '../types/core';

/** Pop ids are `induced:<seq>` (see model/inducedId); the city code has no slashes. */
const PATH_URL = /^map:\/\/paths\/([^/]+)\/(induced:\d+)$/;

export interface PathRequest {
  city: string;
  popId: string;
}

/** Route coordinates for one of our pops, or null if we cannot produce them. */
export type PathProvider = (city: string, popId: string) => Coordinate[] | null;

/** The subset of `window` we need — keeps this testable without a DOM. */
export interface FetchHost {
  fetch: typeof fetch;
}

export function parsePathRequest(url: string): PathRequest | null {
  const m = PATH_URL.exec(url);
  return m ? { city: m[1], popId: m[2] } : null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url ?? '';
}

/** A LineString needs two points; anything less is not a path worth drawing. */
const usable = (coords: Coordinate[] | null): coords is Coordinate[] => !!coords && coords.length >= 2;

interface Patched {
  __inducedDemandPathProvider?: PathProvider;
  __inducedDemandPathOriginal?: typeof fetch;
}

/**
 * Wrap `host.fetch` once, and point it at `provider`. Re-installing (a mod reload)
 * swaps the provider rather than stacking another wrapper. Returns an uninstaller.
 */
export function installRoutePathFetch(host: FetchHost, provider: PathProvider): () => void {
  const tagged = host.fetch as typeof fetch & Patched;
  if (tagged.__inducedDemandPathProvider) {
    tagged.__inducedDemandPathProvider = provider; // newest generation wins
    return () => {
      const original = tagged.__inducedDemandPathOriginal;
      if (original) host.fetch = original;
    };
  }

  const realFetch = host.fetch.bind(host) as typeof fetch;
  const patched = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = parsePathRequest(urlOf(input));
    if (!request) return realFetch(input, init);

    // Whatever the game can answer itself takes precedence.
    let real: Response | null = null;
    try {
      real = await realFetch(input, init);
      if (real.ok) return real;
    } catch { /* no /paths/ route in this build — expected */ }

    let coordinates: Coordinate[] | null = null;
    try {
      coordinates = (patched as Patched).__inducedDemandPathProvider?.(request.city, request.popId) ?? null;
    } catch { /* never let a routing bug break the page's fetch */ }

    if (!usable(coordinates)) return real ?? new Response('', { status: 404 });
    return new Response(JSON.stringify({ coordinates }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch & Patched;

  patched.__inducedDemandPathProvider = provider;
  patched.__inducedDemandPathOriginal = host.fetch;
  host.fetch = patched;
  return () => { host.fetch = patched.__inducedDemandPathOriginal!; };
}
