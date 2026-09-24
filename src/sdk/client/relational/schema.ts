/**
 * ============================================================================
 * File: schema.ts
 * Description: Relational table schema compiled to zero-copy offsets.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { ColumnDef, validateColumn } from './column';
import { RelationalType, relationalTypeSize } from './types';

export interface CompiledColumn extends ColumnDef {
  readonly offset: number;
  readonly size: number;
}

/** Validated, offset-compiled table schema (fixed part only). */
export class RelationalSchema {
  public readonly columns: readonly CompiledColumn[];
  public readonly totalSize: number;
  public readonly primaryKey: string;
  public readonly byName: ReadonlyMap<string, CompiledColumn>;

  constructor(public readonly tableName: string, defs: ColumnDef[]) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`invalid table name '${tableName}'`);
    }
    if (defs.length === 0 || defs.length > 32) {
      throw new Error('table must have 1..32 columns');
    }
    const seen = new Set<string>();
    let pkCount = 0;
    let offset = 4; // 4B null bitmap header (up to 32 cols)
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
