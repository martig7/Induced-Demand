/**
 * Reads a city data file the same way the game does.
 *
 * `api.utils.loadCityData` is the documented route, but it is BROKEN in v1.4.10: it
 * does `await import("./helpers/loadData")`, and under the game's `file://` origin
 * that specifier resolves to a path that does not exist —
 * `net::ERR_FILE_NOT_FOUND` → "Failed to fetch dynamically imported module". So the
 * API can never return anything, on any path, for any mod.
 *
 * The game's own loader does not go through that import. It asks the main process for
 * a local data-server port and fetches `http://127.0.0.1:<port>/data/<CITY>/<file>`,
 * preferring a `.gz` sibling and inflating it with `DecompressionStream`. That server
 * is what serves the map's own roads, so replicating it reads exactly the same bytes
 * the game reads, with no new privileges — we ask the same server the same question.
 *
 * NOTE: `loadCityData` shows the user a "mod is reading city data" notice; going
 * direct skips it, so `main.ts` logs plainly what it is reading and why. If the API is
 * ever fixed, prefer it.
 */

export interface DataServerHost {
  electronAPI?: { getDataServerPort?: () => Promise<number | null> };
  fetch: typeof fetch;
}

/** The port is fixed for the page's lifetime; the game caches it the same way. */
let cachedPort: number | null = null;

async function serverPort(host: DataServerHost): Promise<number> {
  if (cachedPort) return cachedPort;
  const port = await host.electronAPI?.getDataServerPort?.();
  if (!port) throw new Error('Data server not available');
  cachedPort = port;
  return port;
}

async function inflate(buffer: ArrayBuffer): Promise<string> {
  const body = new Response(buffer).body;
  if (!body) throw new Error('No stream available');
  return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text();
}

/**
 * Fetch and parse a `/data/<CITY>/<file>` JSON document. Mirrors the game's own
 * preference order: the gzipped sibling first, then the plain file.
 */
export async function loadCityJson<T = unknown>(host: DataServerHost, path: string): Promise<T> {
  const port = await serverPort(host);
  const url = (p: string): string => `http://127.0.0.1:${port}${p}?useDownloaded=true`;
  const alreadyGz = path.endsWith('.gz');

  if (!alreadyGz) {
    // Cities ship gzipped; the plain path is the fallback, not the norm.
    try {
      const res = await host.fetch(url(`${path}.gz`));
      if (res.ok) return JSON.parse(await inflate(await res.arrayBuffer())) as T;
    } catch { /* no .gz sibling — fall through to the plain file */ }
  }

  const res = await host.fetch(url(path));
  if (!res.ok) throw new Error(`Data server fetch failed: ${res.status} for ${path}`);
  if (alreadyGz) return JSON.parse(await inflate(await res.arrayBuffer())) as T;
  return res.json() as Promise<T>;
}

/** Test seam: forget the cached port. */
export function resetDataServerPort(): void {
  cachedPort = null;
}
