/** Column definitions for a relational table, before offsets are assigned. */

import { RelationalType } from './types';

/**
 * A column as declared, before `RelationalSchema` assigns it an offset.
 * The same shape is what a catalog file and `CREATE TABLE` parse into.
 */
export interface ColumnDef {
  /** Identifier. Must match `[a-zA-Z_][a-zA-Z0-9_]*` and fit the catalog's
   * 64-byte name field. */
  readonly name: string;
  /** Storage type; see `RelationalType`. */
  readonly type: RelationalType;
  /** Whether the column accepts null. A primary key cannot be nullable. */
  readonly nullable?: boolean;
  /** Marks the one primary key column. Exactly one is required per table. */
  readonly primaryKey?: boolean;
  /** Declares the value distinct. Enforced by `constraints.assertUnique`,
   * which nothing in the insert path calls automatically. */
  readonly unique?: boolean;
  /** Default applied when a row omits the column. */
  readonly defaultValue?: boolean | number | string | Uint8Array;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates a column definition in isolation.
 *
 * Checks the name syntax and length and the primary-key/nullability rule.
 * Uniqueness of names and the exactly-one-primary-key rule need the whole
 * column list, so `RelationalSchema` owns those.
 *
 * @param col - The definition to check.
 * @throws {Error} If the name is not a valid identifier, is longer than 64
 *   characters, or the column is both a primary key and nullable. Despite
 *   the name of this module the thrown type is a plain `Error`, not a
 *   `RelationalError`.
 */
export function validateColumn(col: ColumnDef): void {
  if (typeof col.name !== 'string' || !NAME_RE.test(col.name)) {
    throw new Error(`invalid column name '${col.name}'`);
  }
  if (col.name.length > 64) throw new Error('column name too long (max 64)');
  if (col.primaryKey && col.nullable) {
    throw new Error(`primary key column '${col.name}' cannot be nullable`);
  }
}
