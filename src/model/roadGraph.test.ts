import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadGraph, snapToNode, edgeTwin, type RoadFeatureCollection } from './roadGraph';

/** Two ways meeting at a shared middle node: A—B—C horizontally, D—B vertically. */
function crossRoads(): RoadFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { roadClass: 'major' },
        geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0], [0.02, 0]] } },
      { type: 'Feature', properties: { roadClass: 'minor' },
        geometry: { type: 'LineString', coordinates: [[0.01, -0.01], [0.01, 0]] } },
    ],
  };
}

test('buildRoadGraph contracts degree-2 chains, splitting ways only at junctions', () => {
  const g = buildRoadGraph(crossRoads());
  // Coords: (0,0) (0.01,0) (0.02,0) (0.01,-0.01) → 4 distinct nodes.
  assert.equal(g.nodeCount, 4);
  // The straight way is NOT split at its midpoint... except (0.01,0) is a junction
  // (shared with the second way), so: A-B, B-C, D-B = 3 undirected = 6 directed.
  assert.equal(g.edgeCount, 6);
});

test('buildRoadGraph merges intermediate points into one edge when nothing branches', () => {
  const g = buildRoadGraph({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { roadClass: 'minor' },
      geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0], [0.02, 0], [0.03, 0]] } }],
  });
  assert.equal(g.nodeCount, 2, 'only the two endpoints survive');
  assert.equal(g.edgeCount, 2, 'one undirected edge');
  // Its length is the full polyline, not the straight line between endpoints.
  assert.ok(g.len[0] > 3200 && g.len[0] < 3400, `got ${g.len[0]}`);
});

test('buildRoadGraph stores each undirected edge as an adjacent twin pair', () => {
  const g = buildRoadGraph(crossRoads());
  for (let e = 0; e < g.edgeCount; e++) {
    const t = edgeTwin(e);
    assert.equal(g.to[t], nodeOfEdgeSource(g, e), 'twin must point back');
    assert.equal(g.len[e], g.len[t]);
    assert.equal(g.cls[e], g.cls[t]);
  }
});
/** The source of edge e is the target of its twin — the router relies on this. */
function nodeOfEdgeSource(g: ReturnType<typeof buildRoadGraph>, e: number): number {
  return g.to[edgeTwin(e)];
}

test('buildRoadGraph records road class per edge', () => {
  const g = buildRoadGraph(crossRoads());
  const classes = new Set<number>();
  for (let e = 0; e < g.edgeCount; e++) classes.add(g.cls[e]);
  assert.deepEqual([...classes].sort(), [1, 2], 'major=1 and minor=2 present');
});

test('buildRoadGraph handles MultiLineString and unknown classes', () => {
  const g = buildRoadGraph({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { roadClass: 'nonsense' as never },
      geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [0.01, 0]], [[1, 1], [1.01, 1]]] } }],
  });
  assert.equal(g.nodeCount, 4);
  assert.equal(g.edgeCount, 4);
  assert.equal(g.cls[0], 2, 'unknown class falls back to minor');
});

test('buildRoadGraph tolerates empty and degenerate input', () => {
  const empty = buildRoadGraph({ type: 'FeatureCollection', features: [] });
  assert.equal(empty.nodeCount, 0);
  assert.equal(empty.edgeCount, 0);
  assert.equal(snapToNode(empty, [0, 0]), null);

  const dot = buildRoadGraph({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { roadClass: 'minor' },
      geometry: { type: 'LineString', coordinates: [[0, 0]] } }],
  });
  assert.equal(dot.edgeCount, 0, 'a single-coordinate way has no edges');
});

test('snapToNode finds the nearest node and reports its distance', () => {
  const g = buildRoadGraph(crossRoads());
  const s = snapToNode(g, [0.0201, 0]);
  assert.ok(s);
  assert.deepEqual([g.nodeLon[s.node], g.nodeLat[s.node]], [0.02, 0]);
  assert.ok(s.dist > 0 && s.dist < 20, `expected a few metres, got ${s.dist}`);
});

test('snapToNode searches outward past empty grid cells', () => {
  const g = buildRoadGraph(crossRoads());
  const s = snapToNode(g, [0.2, 0.2]); // far away — must still resolve
  assert.ok(s);
  assert.ok(s.dist > 1000);
});
