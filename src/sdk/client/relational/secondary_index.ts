/**
 * ============================================================================
 * File: secondary_index.ts
 * Description: In-memory secondary index helpers for non-unique columns.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { RelationalTable } from './table';
import { Where } from './filter';

/** Lookup PKs by secondary column value using a full scan (phase 1). */
export function lookupByColumn(table: RelationalTable, column: string, value: unknown): string[] {
  return table
    .scan({ [column]: { eq: value as string } } as Where)
    .map((r) => String((r as Record<string, unknown>)[table.schema.primaryKey]));
}
