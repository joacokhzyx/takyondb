/**
 * An in-memory relational table: a primary-key map plus secondary maps for
 * the columns declared `unique` or `primaryKey`. Rows are plain objects, so
 * a scan allocates one object per row returned.
 */

import { ColumnDef } from './column';
import { validateRow, Row } from './codec';
import { ConstraintError } from './errors';
import { RelationalSchema } from './schema';
import { encodePk } from './utils';
import { matchesWhere, Where } from './filter';

/**
 * One table's rows and its maintained secondary maps. Nothing here is
 * persisted or shared between processes; use `catalog_store` or
 * `CatalogRecordStore` for that.
 */
export class RelationalTable {
  /** The compiled schema, including the primary key column name. */
  public readonly schema: RelationalSchema;
  private rows = new Map<string, Row>();
  private secondary: Map<string, Map<string, Set<string>>> = new Map();

  /**
   * @param tableName - Table name, validated by `RelationalSchema`.
   * @param columns - 1 to 32 column definitions with exactly one primary
   *   key.
   * @throws {Error} Whatever `RelationalSchema` throws for an invalid name,
   *   column count, or primary key declaration.
   */
  constructor(tableName: string, columns: ColumnDef[]) {
    this.schema = new RelationalSchema(tableName, columns);
    for (const c of this.schema.columns) {
      if (c.unique || c.primaryKey) this.secondary.set(c.name, new Map());
    }
  }

  /** The table name. */
  public get name(): string {
    return this.schema.tableName;
  }

  /**
   * Inserts a row, enforcing PK uniqueness and NOT NULL.
   *
   * The `unique` flag only causes a secondary entry to be maintained here.
   * It is not a uniqueness check: `constraints.assertUnique` is the
   * implementation, and nothing calls it on this path.
   *
   * @param row - The row to insert. Missing keys are left missing.
   * @returns A shallow copy of the stored row, so the caller cannot reach
   *   the table's own object.
   * @throws {ConstraintError} If a row with the same primary key exists.
   * @throws {Error} From `validateRow`, for a type mismatch, a NOT NULL
   *   violation, or a missing primary key.
   */
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

  /**
   * Looks a row up by primary key value.
   *
   * @param pkValue - The key. Rendered by `encodePk`, so `1` and `'1'` are
   *   the same row.
   * @returns A shallow copy of the row, or `null` when absent.
   * @throws {Error} If `pkValue` is not a renderable key type.
   */
  public findByPk(pkValue: unknown): Row | null {
    const pk = encodePk(pkValue);
    const r = this.rows.get(pk);
    return r ? { ...r } : null;
  }

  /**
   * Scans every row, applying an optional filter.
   *
   * This is a full scan over the insertion-ordered `Map`, so results are in
   * insertion order and a filter cannot use an index. `where` is compiled
   * once per call and reused across rows; passing the same object across
   * calls reuses the compiled predicate.
   *
   * @param where - Optional AND-ed predicate. Omit for every row.
   * @returns Shallow copies of the matching rows, never the stored objects.
   */
  public scan(where?: Where): Row[] {
    const out: Row[] = [];
    for (const r of this.rows.values()) {
      if (matchesWhere(r as Record<string, unknown>, where)) out.push({ ...r });
    }
    return out;
  }

  /**
   * Merges a patch into an existing row, maintaining secondary indexes.
   *
   * The merge is all-or-nothing on validation: the patched row is validated
   * before either index map is touched, so a rejected patch leaves the
   * secondary indexes consistent with the stored row.
   *
   * @param pkValue - The key of the row to update.
   * @param patch - Fields to merge. A key set to `undefined` is written as
   *   `undefined` rather than skipped, unlike `Collection.update`.
   * @returns A shallow copy of the updated row, or `null` when the key is
   *   absent, in which case nothing was written.
   * @throws {ConstraintError} If the patch names a different primary key.
   * @throws {Error} From `validateRow` on the merged row.
   */
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

  /**
   * Deletes the row with this primary key.
   *
   * @param pkValue - The key to delete.
   * @returns True when a row was present and removed, false when absent.
   * @throws {Error} If `pkValue` is not a renderable key type.
   */
  public delete(pkValue: unknown): boolean {
    const pk = encodePk(pkValue);
    const cur = this.rows.get(pk);
    if (!cur) return false;
    this.deindexRow(pk, cur);
    return this.rows.delete(pk);
  }

  /**
   * @returns The number of rows, ignoring any filter and any index.
   */
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
