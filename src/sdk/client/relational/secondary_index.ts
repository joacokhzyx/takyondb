/** In-memory secondary lookup over a `RelationalTable`, via a full scan. */

import { RelationalTable } from './table';
import { Where } from './filter';

/**
 * Lookup PKs by secondary column value using a full scan.
 *
 * This ignores the `secondary` maps `RelationalTable` maintains and
 * re-scans the table, so it is O(rows) per call. It exists for the columns
 * declared neither `unique` nor `primaryKey`, which get no map; the
 * maintained maps are for the columns that do.
 *
 * @param table - The table to search.
 * @param column - Column to match.
 * @param value - Value to match, compared with `===` by the compiled
 *   predicate. A value of the wrong JavaScript type matches nothing.
 * @returns The matching primary keys, rendered with `String`, in insertion
 *   order. Empty when nothing matches.
 */
export function lookupByColumn(table: RelationalTable, column: string, value: unknown): string[] {
  return table
    .scan({ [column]: { eq: value as string } } as Where)
    .map((r) => String((r as Record<string, unknown>)[table.schema.primaryKey]));
}
