/**
 * Self-heal for orphaned pop movements. Saves keep `popMovementsMap` while stripping
 * induced pops, and mod builds before the tombstone scheme hard-deleted retired pops —
 * so a loaded save can carry movements whose pop id resolves to nothing. The game
 * loop then logs "[GameLoop] Tick error: ... Pop not found for pop movement <id>"
 * EVERY tick, forever. The console is the only place the id surfaces to mods:
 * main.ts wraps console.error, parses the id out, and repairs it with a
 * demand-neutral tombstone stub so the movement resolves and the error stops.
 */
import type { DemandData } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import { INDUCED_PREFIX, ensureTombstoneStub } from './popFactory';
import { recordTombstone, type LedgerState } from './ledger';

const DANGLING_RE = new RegExp(`Pop not found for pop movement (${INDUCED_PREFIX}\\d+)`);

/** Extract the dangling induced pop id from console.error args, if present. */
export function parseDanglingInducedMovementId(args: readonly unknown[]): string | null {
  for (const arg of args) {
    const text = arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : '';
    const m = DANGLING_RE.exec(text);
    if (m) return m[1];
  }
  return null;
}

/**
 * Stub + tombstone a dangling id so the orphaned movement resolves. Demand is never
 * touched. Returns false when the pop already exists (nothing to repair).
 */
export function repairDanglingMovement(
  dd: DemandData,
  ledger: LedgerState,
  id: string,
  cfg: InducedDemandConfig,
): boolean {
  const rec = ledger.tombstones?.[id] ?? ledger.pops[id];
  if (!ensureTombstoneStub(dd, id, rec, cfg)) return false;
  recordTombstone(ledger, id, rec ?? { residenceId: '', jobId: '' });
  return true;
}
