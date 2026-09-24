/**
 * ============================================================================
 * File: codec.ts
 * Description: Zero-copy row encode/decode over SharedArrayBuffer/DataView.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { RelationalSchema } from './schema';

export type RowValue = boolean | number | string | Uint8Array | null | undefined;
export type Row = Record<string, RowValue>;

/** Null bitmap: 1 bit per column index (1 = NULL). Stored as u32 LE at offset 0. */
export function nullBit(index: number): number {
  return 1 << (index % 32);
}

/** Validates a row against schema (types, nullability, PK presence). */
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
