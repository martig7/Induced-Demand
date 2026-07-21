/**
 * Offline induced-demand simulation over a game dump (see the in-mod "Dump JSON"
 * button). Runs the real engine headlessly and writes a before/after map.
 *
 *   npm run simulate -- <dump.json> [days] [out.html]
 *   tsx scripts/simulate.ts my-city.json 90
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDump, type DumpFile } from '../src/sim/dump';
import { runSimulation } from '../src/sim/harness';
import { renderHtml } from '../src/sim/render';

const args = process.argv.slice(2);
const dumpPath = args[0];
if (!dumpPath) {
  console.error('usage: tsx scripts/simulate.ts <dump.json> [days] [out.html]');
  process.exit(1);
}
const days = Number.isFinite(Number(args[1])) ? Number(args[1]) : 60;
const outPath = args[2] ?? `${dumpPath.replace(/\.json$/i, '')}-sim-${days}d.html`;

const dump = JSON.parse(readFileSync(resolve(dumpPath), 'utf8')) as DumpFile;
const parsed = parseDump(dump);
console.log(
  `Loaded ${parsed.dd.points.size} points, ${parsed.stations.length} stations, `
  + `${parsed.routes.length} routes (${parsed.city || 'unknown'}). Simulating ${days} days...`,
);

let totalAdded = 0, totalRemoved = 0, totalNew = 0;
const result = runSimulation(parsed, days, undefined, (day, added, removed, newPoints) => {
  totalAdded += added; totalRemoved += removed; totalNew += newPoints;
  if ((day + 1) % 10 === 0 || day === days - 1) {
    console.log(`  day ${day + 1}: +${added} -${removed} pops, ${newPoints} new pts`);
  }
});

writeFileSync(resolve(outPath), renderHtml(result));
console.log(`Done: +${totalAdded} / -${totalRemoved} pops, ${totalNew} new points over ${days} days.`);
console.log(`Wrote ${resolve(outPath)}`);
