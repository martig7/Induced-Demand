/**
 * Routable road graph built from the game's own `/data/<CITY>/roads.geojson`.
 *
 * The file is a flat list of ways with `roadClass` ∈ {highway, major, minor} and no
 * oneway/speed data (verified against the shipped cities — see
 * docs/superpowers/specs/2026-07-12-driving-model-design.md), so edges are undirected
 * and speed comes from the class (fitted in model/speedFit).
 *
 * Ways are split ONLY at junction nodes — coordinates shared by two or more ways —
 * which contracts every degree-2 chain into a single edge carrying the true polyline
 * length. On Denver that is the difference between 557k nodes and 125k: the single
 * biggest win in the whole router, and it costs one pass over the coordinates.
 */
import type { Coordinate } from '../types/core';
import { haversine } from './geo';
import type { RouteResult } from './router';

export const ROAD_CLASSES = ['highway', 'major', 'minor'] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

const CLASS_ID: Record<string, number> = { highway: 0, major: 1, minor: 2 };
const MINOR = 2;

export interface RoadFeature {
  type: 'Feature';
  properties: { roadClass?: RoadClass; structure?: string; name?: string };
  geometry:
    | { type: 'LineString'; coordinates: Coordinate[] }
    | { type: 'MultiLineString'; coordinates: Coordinate[][] };
}

export interface RoadFeatureCollection {
  type: 'FeatureCollection';
  features: RoadFeature[];
}

/**
 * Adjacency in flat arrays (an edge list threaded through `head`/`nextEdge`), which
 * keeps the whole graph in a handful of typed arrays instead of ~475k objects.
 * Undirected edges are stored as ADJACENT TWIN PAIRS: edge `e` and `e ^ 1` are the
 * two directions of the same road, so the source of `e` is `to[e ^ 1]`. The router
 * relies on this to walk a path backwards without storing a parent node.
 */
/**
 * The polyline each undirected edge follows, kept flat and indexed by `edge >> 1`
 * (twins share one entry; the odd direction reads it reversed). Only populated when
 * `keepGeometry` is set — it costs ~11 MB on a real city and is needed only for
 * drawing a route, not for routing one.
 */
export interface EdgeGeometry {
  lon: Float64Array;
  lat: Float64Array;
  /** Index into lon/lat of the first shape point of undirected edge k. */
  start: Int32Array;
  /** Number of shape points of undirected edge k (endpoints included). */
  count: Int32Array;
}

export interface RoadGraph {
  nodeLon: Float64Array;
  nodeLat: Float64Array;
  nodeCount: number;
  /** First outgoing edge of a node, or -1. */
  head: Int32Array;
  /** Next outgoing edge from the same node, or -1. */
  nextEdge: Int32Array;
  to: Int32Array;
  len: Float64Array;
  cls: Uint8Array;
  edgeCount: number;
  /** Node ids bucketed by GRID_DEG cell, for snapping. */
  grid: Map<string, number[]>;
  /** Way shapes, or null when the graph was built without `keepGeometry`. */
  geom: EdgeGeometry | null;
}

export interface BuildOptions {
  /** Retain each way's shape so routes can be drawn (see EdgeGeometry). */
  keepGeometry?: boolean;
}

/** The opposite direction of an undirected edge. */
export const edgeTwin = (edge: number): number => edge ^ 1;

const GRID_DEG = 0.005;
const cellKey = (lon: number, lat: number): string =>
  `${Math.floor(lon / GRID_DEG)},${Math.floor(lat / GRID_DEG)}`;
/** Quantized so coordinates that should coincide actually do. */
const coordKey = (c: Coordinate): string => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

function linesOf(f: RoadFeature): Coordinate[][] {
  if (f.geometry.type === 'LineString') return [f.geometry.coordinates];
  if (f.geometry.type === 'MultiLineString') return f.geometry.coordinates;
  return [];
}

export function buildRoadGraph(geojson: RoadFeatureCollection, opts: BuildOptions = {}): RoadGraph {
  const features = geojson.features ?? [];
  const keepGeometry = opts.keepGeometry ?? false;

  // Pass 1: count coordinate uses so we can tell junctions from through-points.
  const uses = new Map<string, number>();
  for (const f of features) {
    for (const line of linesOf(f)) {
      for (const c of line) {
        const k = coordKey(c);
        uses.set(k, (uses.get(k) ?? 0) + 1);
      }
    }
  }

  const nodeId = new Map<string, number>();
  const lons: number[] = [];
  const lats: number[] = [];
  const getNode = (c: Coordinate): number => {
    const k = coordKey(c);
    let id = nodeId.get(k);
    if (id === undefined) {
      id = lons.length;
      nodeId.set(k, id);
      lons.push(c[0]);
      lats.push(c[1]);
    }
    return id;
  };

  const geomLon: number[] = [];
  const geomLat: number[] = [];
  const geomStart: number[] = [];
  const geomCount: number[] = [];
  /** Record the shape of the undirected edge about to be linked. */
  const recordGeometry = (line: Coordinate[], from: number, toIdx: number): void => {
    geomStart.push(geomLon.length);
    geomCount.push(toIdx - from + 1);
    for (let i = from; i <= toIdx; i++) { geomLon.push(line[i][0]); geomLat.push(line[i][1]); }
  };

  const to: number[] = [];
  const len: number[] = [];
  const cls: number[] = [];
  const nextEdge: number[] = [];
  const headByNode: number[] = [];
  const link = (from: number, node: number, meters: number, roadClass: number): void => {
    to.push(node);
    len.push(meters);
    cls.push(roadClass);
    nextEdge.push(headByNode[from] ?? -1);
    headByNode[from] = to.length - 1;
  };

  // Pass 2: walk each way, cutting at junctions and at the way's own endpoints.
  for (const f of features) {
    const roadClass = CLASS_ID[f.properties?.roadClass ?? ''] ?? MINOR;
    for (const line of linesOf(f)) {
      if (line.length < 2) continue;
      let anchor = getNode(line[0]);
      let anchorIdx = 0;
      let meters = 0;
      for (let i = 1; i < line.length; i++) {
        meters += haversine(line[i - 1], line[i]);
        const isJunction = (uses.get(coordKey(line[i])) ?? 0) > 1 || i === line.length - 1;
        if (!isJunction) continue;
        const node = getNode(line[i]);
        if (node !== anchor && meters > 0) {
          if (keepGeometry) recordGeometry(line, anchorIdx, i);
          link(anchor, node, meters, roadClass); // e
          link(node, anchor, meters, roadClass); // e ^ 1
        }
        anchor = node;
        anchorIdx = i;
        meters = 0;
      }
    }
  }

  const nodeCount = lons.length;
  const head = new Int32Array(nodeCount).fill(-1);
  for (let n = 0; n < nodeCount; n++) if (headByNode[n] !== undefined) head[n] = headByNode[n];

  const grid = new Map<string, number[]>();
  for (let n = 0; n < nodeCount; n++) {
    const k = cellKey(lons[n], lats[n]);
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, (bucket = []));
    bucket.push(n);
  }

  return {
    nodeLon: Float64Array.from(lons),
    nodeLat: Float64Array.from(lats),
    nodeCount,
    head,
    nextEdge: Int32Array.from(nextEdge),
    to: Int32Array.from(to),
    len: Float64Array.from(len),
    cls: Uint8Array.from(cls),
    edgeCount: to.length,
    grid,
    geom: keepGeometry
      ? {
        lon: Float64Array.from(geomLon),
        lat: Float64Array.from(geomLat),
        start: Int32Array.from(geomStart),
        count: Int32Array.from(geomCount),
      }
      : null,
  };
}

/**
 * The coordinates a route actually follows. With geometry the full road shape is
 * returned; without it, only the junctions the route passed through — a coarse
 * polyline that cuts corners, fine for a sanity check but not for drawing.
 */
export function pathCoordinates(graph: RoadGraph, route: RouteResult): Coordinate[] {
  const nodeCoord = (n: number): Coordinate => [graph.nodeLon[n], graph.nodeLat[n]];
  if (!graph.geom) return route.nodes.map(nodeCoord);

  const out: Coordinate[] = [];
  const push = (c: Coordinate): void => {
    const last = out[out.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) return; // shared junction
    out.push(c);
  };
  for (const edge of route.edges) {
    const k = edge >> 1;
    const start = graph.geom.start[k];
    const count = graph.geom.count[k];
    if (edge & 1) {
      for (let i = count - 1; i >= 0; i--) push([graph.geom.lon[start + i], graph.geom.lat[start + i]]);
    } else {
      for (let i = 0; i < count; i++) push([graph.geom.lon[start + i], graph.geom.lat[start + i]]);
    }
  }
  return out.length ? out : route.nodes.map(nodeCoord);
}

/** Nearest graph node to a coordinate, searching outward ring by ring. */
export function snapToNode(
  graph: RoadGraph,
  coord: Coordinate,
  maxRings = 40,
): { node: number; dist: number } | null {
  if (graph.nodeCount === 0) return null;
  const cx = Math.floor(coord[0] / GRID_DEG);
  const cy = Math.floor(coord[1] / GRID_DEG);
  for (let ring = 0; ring < maxRings; ring++) {
    let best = -1;
    let bestDist = Infinity;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        // Only the ring's perimeter is new; inner cells were covered already.
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        for (const n of graph.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = haversine(coord, [graph.nodeLon[n], graph.nodeLat[n]]);
          if (d < bestDist) { bestDist = d; best = n; }
        }
      }
    }
    if (best >= 0) return { node: best, dist: bestDist };
  }
  // Nothing within the ring budget (a point far outside the road network). Rare, so
  // pay for an exact linear scan rather than growing the rings quadratically.
  let best = -1;
  let bestDist = Infinity;
  for (let n = 0; n < graph.nodeCount; n++) {
    const d = haversine(coord, [graph.nodeLon[n], graph.nodeLat[n]]);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best >= 0 ? { node: best, dist: bestDist } : null;
}
