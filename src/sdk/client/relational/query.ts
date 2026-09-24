/**
 * ============================================================================
 * File: query.ts
 * Description: Fluent query builder with filter, projection, sort, limit.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { Row } from './codec';
import { aggregate, AggFn } from './aggregation';
import { Where, matchesWhere } from './filter';
import { RelationalTable } from './table';

export class QueryBuilder {
  private whereClause?: Where;
  private selectCols?: string[];
  private orderCol?: string;
  private orderDir: 'asc' | 'desc' = 'asc';
  private limitN?: number;
  private offsetN = 0;

  constructor(private readonly table: RelationalTable) {}

  public where(w: Where): this {
    this.whereClause = w;
    return this;
  }

  public select(cols: string[]): this {
    this.selectCols = cols;
    return this;
  }

  public orderBy(col: string, dir: 'asc' | 'desc' = 'asc'): this {
    this.orderCol = col;
    this.orderDir = dir;
    return this;
  }

  public limit(n: number): this {
    this.limitN = n;
    return this;
  }

  public offset(n: number): this {
    this.offsetN = n;
    return this;
  }

  /** Executes the scan, applying filter, sort, offset, limit, projection. */
  public all(): Row[] {
    let rows = this.table.scan(this.whereClause);
    if (this.orderCol) {
      const col = this.orderCol;
      const dir = this.orderDir;
      rows = [...rows].sort((a, b) => {
        const av = a[col] as number | string;
        const bv = b[col] as number | string;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    if (this.offsetN) rows = rows.slice(this.offsetN);
    if (this.limitN !== undefined) rows = rows.slice(0, this.limitN);
    if (this.selectCols) {
      rows = rows.map((r) => {
        const o: Row = {};
        for (const c of this.selectCols!) o[c] = r[c];
        return o;
      });
    }
    return rows;
  }

  public count(): number {
    return this.table.scan(this.whereClause).length;
  }

  public agg(fn: AggFn, column?: string): number {
    return aggregate(this.table.scan(this.whereClause), fn, column);
  }

  public matches(row: Row): boolean {
    return matchesWhere(row as Record<string, unknown>, this.whereClause);
  }
}
