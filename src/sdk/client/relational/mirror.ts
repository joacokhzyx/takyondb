/**
 * ============================================================================
 * File: mirror.ts
 * Description: Mirrors relational PKs into the engine ART index.
 *   Keys use the `tbl:<table>:<pk>` namespace so relational point lookups
 *   reuse the lock-free ART, WAL durability, and snapshot recovery instead
 *   of a parallel in-memory map. Offsets must be real SharedArena record
 *   offsets (e.g. from `TakyonDB.allocateRecordOffset`); the mirror never
 *   invents them.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { TakyonBindings } from '../proxy';
import { RelationalTable } from './table';
import { encodePk, pkKey } from './utils';

export class ArtMirror {
  constructor(private readonly bindings: TakyonBindings) {}

  /** Publishes a PK -> record offset mapping. Throws on bridge errors. */
  public mirrorPk(table: string, pkValue: unknown, recordOffset: number): void {
    if (!Number.isInteger(recordOffset) || recordOffset < 0) {
      throw new Error(`record offset must be a non-negative integer, got ${recordOffset}`);
    }
    const rc = this.bindings.insert_index(pkKey(table, encodePk(pkValue)), recordOffset);
    if (rc !== 0) throw new Error(`insert_index failed for PK '${String(pkValue)}'`);
  }

  /** Resolves a PK to its arena offset, or null when absent. */
  public lookupPk(table: string, pkValue: unknown): number | null {
    const off = this.bindings.search_index(pkKey(table, encodePk(pkValue)));
    return off < 0 ? null : off;
  }

  /** Removes a PK mapping. Returns true iff the key was present. */
  public unmirrorPk(table: string, pkValue: unknown): boolean {
    const rc = this.bindings.remove_index(pkKey(table, encodePk(pkValue)));
    if (rc === 1) return true;
    if (rc === 0) return false;
    throw new Error(`remove_index failed for PK '${String(pkValue)}'`);
  }

  /** Mirrors every row of a table using caller-supplied offsets. */
  public syncTable(table: RelationalTable, offsetOf: (pk: string) => number): void {
    for (const row of table.scan()) {
      const pk = String((row as Record<string, unknown>)[table.schema.primaryKey]);
      this.mirrorPk(table.name, pk, offsetOf(pk));
    }
  }
}
