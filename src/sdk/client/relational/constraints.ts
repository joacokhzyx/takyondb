/**
 * ============================================================================
 * File: constraints.ts
 * Description: Constraint checks for UNIQUE, FK, and NOT NULL.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { RelationalTable } from './table';

/** Asserts a UNIQUE column has no duplicate value (excluding pk itself). */
export function assertUnique(table: RelationalTable, column: string, value: unknown, excludePk?: unknown): void {
  for (const r of table.scan()) {
    if (excludePk !== undefined && String((r as Record<string, unknown>)[table.schema.primaryKey]) === String(excludePk)) continue;
    if ((r as Record<string, unknown>)[column] === value) {
      throw new Error(`UNIQUE violation on '${column}'`);
    }
  }
}
