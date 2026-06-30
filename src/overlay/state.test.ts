import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayStore } from './state';

test('store merges patches and notifies subscribers', () => {
  const store = createOverlayStore({ enabled: false, view: 'realized', metric: 'combined' });
  let n = 0;
  const unsub = store.subscribe(() => { n++; });

  store.set({ enabled: true });
  assert.equal(store.get().enabled, true);
  assert.equal(n, 1);

  store.set({ view: 'targeting' });
  assert.equal(store.get().view, 'targeting');
  assert.equal(store.get().enabled, true);
  assert.equal(n, 2);

  unsub();
  store.set({ metric: 'residential' });
  assert.equal(n, 2);
  assert.equal(store.get().metric, 'residential');
});
