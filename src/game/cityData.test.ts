import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadCityJson, resetDataServerPort, type DataServerHost } from './cityData';

test.beforeEach(() => { resetDataServerPort(); });

const PAYLOAD = { type: 'FeatureCollection', features: [{ id: 1 }] };

/** A window-like host backed by a fake data server. */
function host(
  files: Record<string, { body: Uint8Array | string; status?: number }>,
  port: number | null = 5123,
): DataServerHost & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    electronAPI: { getDataServerPort: async () => port },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const file = files[url];
      if (!file) return new Response('', { status: 404 });
      return new Response(file.body as BodyInit, { status: file.status ?? 200 });
    }) as typeof fetch,
  };
}
const gz = (o: unknown): Uint8Array => new Uint8Array(gzipSync(Buffer.from(JSON.stringify(o))));

test('loadCityJson prefers the gzipped file, exactly as the game does', async () => {
  const h = host({
    'http://127.0.0.1:5123/data/DEN/roads.geojson.gz?useDownloaded=true': { body: gz(PAYLOAD) },
  });
  assert.deepEqual(await loadCityJson(h, '/data/DEN/roads.geojson'), PAYLOAD);
  assert.deepEqual(h.urls, ['http://127.0.0.1:5123/data/DEN/roads.geojson.gz?useDownloaded=true']);
});

test('loadCityJson falls back to the plain file when there is no .gz', async () => {
  const h = host({
    'http://127.0.0.1:5123/data/DEN/roads.geojson?useDownloaded=true': { body: JSON.stringify(PAYLOAD) },
  });
  assert.deepEqual(await loadCityJson(h, '/data/DEN/roads.geojson'), PAYLOAD);
  assert.equal(h.urls.length, 2, 'tries .gz first, then plain');
});

test('loadCityJson decompresses a path that is already .gz', async () => {
  const h = host({
    'http://127.0.0.1:5123/data/DEN/demand_data.json.gz?useDownloaded=true': { body: gz(PAYLOAD) },
  });
  assert.deepEqual(await loadCityJson(h, '/data/DEN/demand_data.json.gz'), PAYLOAD);
  assert.deepEqual(h.urls, ['http://127.0.0.1:5123/data/DEN/demand_data.json.gz?useDownloaded=true']);
});

test('loadCityJson throws when the file is missing entirely', async () => {
  await assert.rejects(() => loadCityJson(host({}), '/data/ZZZ/roads.geojson'), /404|failed/i);
});

test('loadCityJson throws when the data server is unavailable', async () => {
  await assert.rejects(() => loadCityJson(host({}, null), '/data/DEN/roads.geojson'), /data server/i);
  const noApi = { fetch: (async () => new Response('')) as typeof fetch };
  await assert.rejects(() => loadCityJson(noApi, '/data/DEN/roads.geojson'), /data server/i);
});

test('loadCityJson asks for the port once and reuses it', async () => {
  let calls = 0;
  const h = host({
    'http://127.0.0.1:5123/data/DEN/a.json.gz?useDownloaded=true': { body: gz(PAYLOAD) },
    'http://127.0.0.1:5123/data/DEN/b.json.gz?useDownloaded=true': { body: gz(PAYLOAD) },
  });
  h.electronAPI!.getDataServerPort = async () => { calls++; return 5123; };
  await loadCityJson(h, '/data/DEN/a.json');
  await loadCityJson(h, '/data/DEN/b.json');
  assert.equal(calls, 1, 'the port is fixed for the session');
});

test('loadCityJson surfaces corrupt archives rather than returning junk', async () => {
  const h = host({
    'http://127.0.0.1:5123/data/DEN/roads.geojson.gz?useDownloaded=true': { body: new Uint8Array([1, 2, 3]) },
  });
  await assert.rejects(() => loadCityJson(h, '/data/DEN/roads.geojson'));
});
