import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLBAR_PANEL_ID, TOOLBAR_PLACEMENT } from './toolbarPanel';

test('toolbar panel constants match game top-bar placement', () => {
  assert.equal(TOOLBAR_PANEL_ID, 'induced-demand-map-mode');
  assert.equal(TOOLBAR_PLACEMENT, 'top-bar');
});
