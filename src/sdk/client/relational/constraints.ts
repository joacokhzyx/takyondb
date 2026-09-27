/** Standalone constraint checks. No write path calls these on its own. */

import { RelationalTable } from './table';

/**
 * Asserts a UNIQUE column has no duplicate value (excluding pk itself).
 *
 * A full scan, and it is not wired into `RelationalTable.insert` or
 * `update`, so declaring a column `unique` does not by itself prevent a
 * duplicate. Call this from the write path that owns the constraint.
 *
 * @param table - The table to check.
 * @param column - The column under the UNIQUE constraint.
 * @param value - The value that must not already exist.
 * @param excludePk - Primary key of the row being updated, whose current
 *   value does not count as a conflict with itself. Compared with `String`.
 * @throws {Error} If another row already holds `value`. The message names
 *   the column but not the offending row.
 */
export function assertUnique(table: RelationalTable, column: string, value: unknown, excludePk?: unknown): void {
  for (const r of table.scan()) {
    if (excludePk !== undefined && String((r as Record<string, unknown>)[table.schema.primaryKey]) === String(excludePk)) continue;
    if ((r as Record<string, unknown>)[column] === value) {
      throw new Error(`UNIQUE violation on '${column}'`);
    }
  }
}
