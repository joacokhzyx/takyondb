/**
 * Row value types and the validator every write path calls before touching
 * a table. No encoding lives here: the rows are plain objects.
 */

import { RelationalSchema } from './schema';

/** Anything a single cell may hold. */
export type RowValue = boolean | number | string | Uint8Array | null | undefined;

/** A row keyed by column name. Unknown keys are carried but not validated. */
export type Row = Record<string, RowValue>;

/**
 * Returns the null-bitmap mask for a column index.
 *
 * The bitmap is a u32 at record offset 0, so the mask wraps every 32
 * columns. `RelationalSchema` caps a table at 32 columns, which is what
 * keeps the wrap from ever being reached.
 *
 * @param index - Zero-based column position.
 * @returns The single-bit mask, `1` meaning NULL.
 */
export function nullBit(index: number): number {
  return 1 << (index % 32);
}

/**
 * Validates a row against its schema.
 *
 * A column is skipped entirely when the row omits it, because a missing key
 * and an explicit null are not distinguishable here and the defaults and
 * nullable flags cover both. The primary key is the exception: it is
 * checked for presence, so a row can never reach a table without one.
 *
 * @param schema - The target table's compiled schema.
 * @param row - The row to check.
 * @throws {Error} If a present value has the wrong JavaScript type for its
 *   column, a non-nullable column is explicitly null, or the primary key is
 *   missing, null, or the empty string.
 */
export function validateRow(schema: RelationalSchema, row: Row): void {
  for (let i = 0; i < schema.columns.length; i++) {
    const col = schema.columns[i];
    const v = row[col.name];
    if (v === null || v === undefined) {
      if (!col.nullable && !col.defaultValue && col.primaryKey) {
        throw new Error(`column '${col.name}' cannot be null`);
      }
      if (!col.nullable && v !== undefined) {
        throw new Error(`column '${col.name}' is NOT NULL`);
      }
      continue;
    }
    switch (col.type) {
      case 'bool':
        if (typeof v !== 'boolean') throw new Error(`column '${col.name}' must be boolean`);
        break;
      case 'string':
        if (typeof v !== 'string') throw new Error(`column '${col.name}' must be string`);
        break;
      case 'bytes':
        if (!(v instanceof Uint8Array)) throw new Error(`column '${col.name}' must be Uint8Array`);
        break;
      default:
        if (typeof v !== 'number' || !Number.isFinite(v as number)) {
          throw new Error(`column '${col.name}' must be a finite number`);
        }
    }
  }
  const pk = row[schema.primaryKey];
  if (pk === null || pk === undefined || pk === '') {
    throw new Error('primary key value is required');
  }
}
