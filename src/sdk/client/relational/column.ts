/**
 * ============================================================================
 * File: column.ts
 * Description: Column definition with validation for relational tables.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { RelationalType } from './types';

export interface ColumnDef {
  readonly name: string;
  readonly type: RelationalType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly defaultValue?: boolean | number | string | Uint8Array;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Validates a column definition, throwing RelationalError on misuse. */
export function validateColumn(col: ColumnDef): void {
  if (typeof col.name !== 'string' || !NAME_RE.test(col.name)) {
    throw new Error(`invalid column name '${col.name}'`);
  }
  if (col.name.length > 64) throw new Error('column name too long (max 64)');
  if (col.primaryKey && col.nullable) {
    throw new Error(`primary key column '${col.name}' cannot be nullable`);
  }
}
