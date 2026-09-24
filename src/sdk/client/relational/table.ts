/**
 * ============================================================================
 * File: table.ts
 * Description: Relational table with PK map and secondary index maintenance.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { ColumnDef } from './column';
import { validateRow, Row } from './codec';
import { ConstraintError } from './errors';
import { RelationalSchema } from './schema';
import { encodePk } from './utils';
import { matchesWhere, Where } from './filter';

export class RelationalTable {
  public readonly schema: RelationalSchema;
  private rows = new Map<string, Row>();
  private secondary: Map<string, Map<string, Set<string>>> = new Map();

  constructor(tableName: string, columns: ColumnDef[]) {
    this.schema = new RelationalSchema(tableName, columns);
    for (const c of this.schema.columns) {
      if (c.unique || c.primaryKey) this.secondary.set(c.name, new Map());
    }
  }

  public get name(): string {
    return this.schema.tableName;
  }

  /** Inserts a row, enforcing PK uniqueness and NOT NULL. */
  public insert(row: Row): Row {
    validateRow(this.schema, row);
    const pkRaw = row[this.schema.primaryKey] as unknown;
    const pk = encodePk(pkRaw);
    if (this.rows.has(pk)) throw new ConstraintError(`duplicate primary key '${pk}'`);
    const stored: Row = { ...row };
    this.rows.set(pk, stored);
    this.indexRow(pk, stored);
    return { ...stored };
  }

  /** Point lookup by PK value. Returns a copy or null. */
  public findByPk(pkValue: unknown): Row | null {
    const pk = encodePk(pkValue);
    const r = this.rows.get(pk);
    return r ? { ...r } : null;
  }

  /** Full scan with optional filter (zero-copy friendly: no serdes). */
  public scan(where?: Where): Row[] {
    const out: Row[] = [];
    for (const r of this.rows.values()) {
      if (matchesWhere(r as Record<string, unknown>, where)) out.push({ ...r });
    }
    return out;
  }

  /** Updates fields in place, maintaining secondary indexes. */
  public update(pkValue: unknown, patch: Partial<Row>): Row | null {
    const pk = encodePk(pkValue);
    const cur = this.rows.get(pk);
    if (!cur) return null;
    if (patch[this.schema.primaryKey] !== undefined && encodePk(patch[this.schema.primaryKey]) !== pk) {
      throw new ConstraintError('primary key is immutable');
    }
    const next = { ...cur, ...patch };
    validateRow(this.schema, next);
    this.deindexRow(pk, cur);
    this.rows.set(pk, next);
    this.indexRow(pk, next);
    return { ...next };
  }

  /** Deletes by PK, returning true iff present. */
  public delete(pkValue: unknown): boolean {
    const pk = encodePk(pkValue);
    const cur = this.rows.get(pk);
    if (!cur) return false;
    this.deindexRow(pk, cur);
    return this.rows.delete(pk);
  }

  public count(): number {
    return this.rows.size;
  }

  private indexRow(pk: string, row: Row): void {
    for (const [col, map] of this.secondary) {
      const v = String(row[col]);
      let set = map.get(v);
      if (!set) {
        set = new Set();
        map.set(v, set);
      }
      set.add(pk);
    }
  }

  private deindexRow(pk: string, row: Row): void {
    for (const [col, map] of this.secondary) {
      const v = String(row[col]);
      const set = map.get(v);
      if (set) {
        set.delete(pk);
        if (set.size === 0) map.delete(v);
      }
    }
  }
}
