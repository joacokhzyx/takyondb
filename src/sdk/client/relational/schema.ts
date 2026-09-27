/** Compiles a column list into the byte offsets a table row occupies. */

import { ColumnDef, validateColumn } from './column';
import { RelationalType, relationalTypeSize } from './types';

/** A column with its assigned position in the row. */
export interface CompiledColumn extends ColumnDef {
  /** Byte offset from the start of the record, after the null bitmap. */
  readonly offset: number;
  /** Byte width. */
  readonly size: number;
}

/**
 * A validated, offset-compiled table schema.
 *
 * The offsets are computed for the fixed-width part of a row only. Nothing
 * in this module encodes a row, so the null bitmap it reserves is written
 * by whatever caller serializes the record.
 */
export class RelationalSchema {
  /** Columns in declaration order, which is also their offset order. */
  public readonly columns: readonly CompiledColumn[];
  /** Row size in bytes, including the 4-byte null bitmap header. */
  public readonly totalSize: number;
  /** Name of the single primary key column. */
  public readonly primaryKey: string;
  /** Columns by name, for lookups that skip the array scan. */
  public readonly byName: ReadonlyMap<string, CompiledColumn>;

  /**
   * @param tableName - Table name; must match `[a-zA-Z_][a-zA-Z0-9_]*`.
   * @param defs - Column definitions, 1 to 32 of them. The 32-column
   *   ceiling is what the 4-byte null bitmap addresses.
   * @throws {Error} If the name is not a valid identifier, the column count
   *   is outside 1..32, a column is invalid or duplicated, or the number of
   *   `primaryKey` columns is not exactly one.
   */
  constructor(public readonly tableName: string, defs: ColumnDef[]) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`invalid table name '${tableName}'`);
    }
    if (defs.length === 0 || defs.length > 32) {
      throw new Error('table must have 1..32 columns');
    }
    const seen = new Set<string>();
    let pkCount = 0;
    // 4B null bitmap header, one bit per column, caps the table at 32 cols.
    let offset = 4;
    const compiled: CompiledColumn[] = [];
    for (const d of defs) {
      validateColumn(d);
      if (seen.has(d.name)) throw new Error(`duplicate column '${d.name}'`);
      seen.add(d.name);
      if (d.primaryKey) pkCount++;
      const size = relationalTypeSize(d.type as RelationalType);
      compiled.push({ ...d, offset, size });
      offset += size;
    }
    if (pkCount !== 1) throw new Error('table must declare exactly one primaryKey column');
    this.columns = compiled;
    this.totalSize = offset;
    this.primaryKey = compiled.find((c) => c.primaryKey)!.name;
    this.byName = new Map(compiled.map((c) => [c.name, c]));
  }
}
