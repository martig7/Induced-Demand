/**
 * Time-weighted A* over the road graph.
 *
 * The game's city pipeline routes on TIME, not distance: routing on distance
 * reproduces its `drivingDistance` to a median ratio of only 0.942 (too short —
 * it misses the longer-but-faster highway legs), while routing on time with
 * fitted class speeds lands at 0.988. See the design spec for the measurements.
 *
 * Edges are undirected (the road data has no oneway flags), and speed is a
 * function of road class alone, so the heuristic `haversine / maxSpeed` is
 * admissible and A* returns exact shortest-time paths.
 */
import { edgeTwin, type RoadGraph } from './roadGraph';
import { haversine } from './geo';

export interface Speeds {
  highway: number;
  major: number;
  minor: number;
}

/** Fitted against Denver's native pops; overridden per city by model/speedFit. */
export const DEFAULT_SPEEDS: Speeds = { highway: 20.3, major: 12.7, minor: 8.4 };

export interface RouteResult {
  /** Metres along the road network. */
  distance: number;
  seconds: number;
  /** Metres travelled per road class, indexed as [highway, major, minor]. */
  classLengths: [number, number, number];
  /** Junction nodes from origin to destination inclusive. */
  nodes: number[];
  /** Edge ids in travel order — indexes into the graph's arrays and its geometry. */
  edges: number[];
}

export interface DrivingRouter {
  route(from: number, to: number): RouteResult | null;
  readonly speeds: Speeds;
}

/** Min-heap over (priority, node) pairs, kept as two parallel arrays. */
class Heap {
  private prio: number[] = [];
  private item: number[] = [];
  get size(): number { return this.item.length; }
  clear(): void { this.prio.length = 0; this.item.length = 0; }
  push(p: number, n: number): void {
    this.prio.push(p); this.item.push(n);
    let i = this.item.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }
  pop(): { p: number; n: number } {
    const p = this.prio[0], n = this.item[0];
    const lastP = this.prio.pop()!, lastN = this.item.pop()!;
    if (this.item.length) {
      this.prio[0] = lastP; this.item[0] = lastN;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.item.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.item.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return { p, n };
  }
  private swap(a: number, b: number): void {
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
    [this.item[a], this.item[b]] = [this.item[b], this.item[a]];
  }
}

export function createRouter(graph: RoadGraph, speeds: Speeds): DrivingRouter {
  // Scratch state is allocated once and reused; `stamp` marks the current query so
  // there is no O(nodes) clear between routes.
  const time = new Float64Array(graph.nodeCount);
  const cameFrom = new Int32Array(graph.nodeCount);
  const stamp = new Int32Array(graph.nodeCount);
  const heap = new Heap();
  let run = 0;

  const speedOf = [speeds.highway, speeds.major, speeds.minor];
  const maxSpeed = Math.max(...speedOf);

  function route(from: number, to: number): RouteResult | null {
    if (from < 0 || to < 0 || from >= graph.nodeCount || to >= graph.nodeCount) return null;
    if (from === to) return { distance: 0, seconds: 0, classLengths: [0, 0, 0], nodes: [from], edges: [] };

    run++;
    heap.clear();
    const goal: [number, number] = [graph.nodeLon[to], graph.nodeLat[to]];
    const h = (n: number): number =>
      haversine([graph.nodeLon[n], graph.nodeLat[n]], goal) / maxSpeed;

    time[from] = 0;
    stamp[from] = run;
    cameFrom[from] = -1;
    heap.push(h(from), from);

    while (heap.size) {
      const { p, n } = heap.pop();
      if (n === to) return unwind(to);
      if (p - h(n) > time[n] + 1e-9) continue; // stale heap entry
      for (let e = graph.head[n]; e !== -1; e = graph.nextEdge[e]) {
        const m = graph.to[e];
        const t = time[n] + graph.len[e] / speedOf[graph.cls[e]];
        if (stamp[m] !== run || t < time[m]) {
          stamp[m] = run;
          time[m] = t;
          cameFrom[m] = e;
          heap.push(t + h(m), m);
        }
      }
    }
    return null;
  }

  function unwind(goal: number): RouteResult {
    const classLengths: [number, number, number] = [0, 0, 0];
    const nodes: number[] = [goal];
    const edges: number[] = [];
    let distance = 0;
    let cur = goal;
    for (;;) {
      const e = cameFrom[cur];
      if (e === -1) break;
      classLengths[graph.cls[e]] += graph.len[e];
      distance += graph.len[e];
      edges.push(e);
      cur = graph.to[edgeTwin(e)]; // the edge's source
      nodes.push(cur);
    }
    nodes.reverse();
    edges.reverse();
    return { distance, seconds: time[goal], classLengths, nodes, edges };
  }

  return { route, speeds };
}
