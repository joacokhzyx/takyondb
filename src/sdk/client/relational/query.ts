/** A chainable query over one table. Every clause mutates and returns this. */

import { Row } from './codec';
import { aggregate, AggFn } from './aggregation';
import { Where, matchesWhere } from './filter';
import { RelationalTable } from './table';

/**
 * A chainable query over one table. Every clause method mutates this
 * object and returns it, so a builder is single-use per clause chain and
 * re-running `all()` re-reads the table rather than caching a result.
 */
export class QueryBuilder {
  private whereClause?: Where;
  private selectCols?: string[];
  private orderCol?: string;
  private orderDir: 'asc' | 'desc' = 'asc';
  private limitN?: number;
  private offsetN = 0;

  /**
   * @param table - The table to read. Held by reference, so rows written
   *   after the builder is created are visible.
   */
  constructor(private readonly table: RelationalTable) {}

  /**
   * Sets the filter, replacing any previous one. There is no `and`/`or`;
   * call this again to replace.
   *
   * @param w - An AND-ed predicate over the table's columns.
   * @returns This builder.
   */
  public where(w: Where): this {
    this.whereClause = w;
    return this;
  }

  /**
   * Restricts the output to these columns.
   *
   * @param cols - Column names. Names not present in a row are copied as
   *   `undefined` rather than dropped.
   * @returns This builder.
   */
  public select(cols: string[]): this {
    this.selectCols = cols;
    return this;
  }

  /**
   * Sorts by one column.
   *
   * The comparison is JavaScript's `<` and `>`, so mixed types order by
   * coercion rather than by any type-aware rule, and equal values leave the
   * sort stable in scan order.
   *
   * @param col - Column to sort on.
   * @param dir - `'asc'` or `'desc'`. Defaults to `'asc'`.
   * @returns This builder.
   */
  public orderBy(col: string, dir: 'asc' | 'desc' = 'asc'): this {
    this.orderCol = col;
    this.orderDir = dir;
    return this;
  }

  /**
   * Caps the number of rows returned, applied after offset.
   *
   * @param n - Maximum rows. A negative value slices from the end, which is
   *   `Array.prototype.slice` behavior rather than an error.
   * @returns This builder.
   */
  public limit(n: number): this {
    this.limitN = n;
    return this;
  }

  /**
   * Skips rows before applying the limit, applied after sorting.
   *
   * @param n - Rows to skip. A negative value is treated as 0.
   * @returns This builder.
   */
  public offset(n: number): this {
    this.offsetN = n;
    return this;
  }

  /**
   * Executes the query, applying filter, sort, offset, limit, and
   * projection in that order.
   *
   * The clauses are not pushed down: the filter runs per row over the whole
   * table. `relational/pushdown.ts` is the columnar path.
   *
   * @returns Shallow copies of the matching rows, projected if `select` was
   *   called.
   * @throws {Error} If `where` names a comparison on a non-numeric column;
   *   ordered comparisons silently match nothing rather than failing.
   */
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

  /**
   * Counts the rows the filter admits.
   *
   * Applies `where` only. `limit` and `offset` are ignored, so this is the
   * unrestricted match count and not the size of `all()`.
   *
   * @returns The number of matching rows.
   */
  public count(): number {
    return this.table.scan(this.whereClause).length;
  }

  /**
   * Aggregates the rows the filter admits.
   *
   * Applies `where` only; `limit`, `offset`, and `select` are ignored.
   *
   * @param fn - Which aggregation to compute.
   * @param column - Source column; required for everything except `count`.
   * @returns The aggregate value.
   * @throws {Error} If `fn` needs a column and none is given.
   */
  public agg(fn: AggFn, column?: string): number {
    return aggregate(this.table.scan(this.whereClause), fn, column);
  }

  /**
   * Tests one row against this query's filter.
   *
   * Useful for filtering a row set this table did not produce. Only `where`
   * is consulted.
   *
   * @param row - The row to test.
   * @returns True when the row satisfies the filter. A query with no filter
   *   matches every row.
   */
  public matches(row: Row): boolean {
    return matchesWhere(row as Record<string, unknown>, this.whereClause);
  }
}
