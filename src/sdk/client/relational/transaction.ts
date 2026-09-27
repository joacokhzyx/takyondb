/**
 * A batch of writes applied together. The batch is validated up front and
 * then applied in order; it is not a storage-engine transaction and nothing
 * is rolled back if an apply step fails.
 */

import { Row } from './codec';
import { RelationalDatabase } from './database';

/** One buffered operation. */
export type TxOp =
  | { readonly kind: 'insert'; readonly table: string; readonly row: Row }
  | { readonly kind: 'update'; readonly table: string; readonly pk: unknown; readonly patch: Partial<Row> }
  | { readonly kind: 'delete'; readonly table: string; readonly pk: unknown };

/** Buffers ops, validates, then applies atomically (no partial apply). */
export class Transaction {
  private ops: TxOp[] = [];

  /**
   * @param db - The catalog the buffered operations are applied against.
   */
  constructor(private readonly db: RelationalDatabase) {}

  /**
   * Buffers a row insert.
   *
   * @param table - Target table name.
   * @param row - The row to insert.
   * @returns This transaction, for chaining.
   */
  public insert(table: string, row: Row): this {
    this.ops.push({ kind: 'insert', table, row });
    return this;
  }

  /**
   * Buffers a row update.
   *
   * @param table - Target table name.
   * @param pk - Primary key of the row to update.
   * @param patch - Fields to merge.
   * @returns This transaction, for chaining.
   */
  public update(table: string, pk: unknown, patch: Partial<Row>): this {
    this.ops.push({ kind: 'update', table, pk, patch });
    return this;
  }

  /**
   * Buffers a row delete.
   *
   * @param table - Target table name.
   * @param pk - Primary key of the row to delete.
   * @returns This transaction, for chaining.
   */
  public delete(table: string, pk: unknown): this {
    this.ops.push({ kind: 'delete', table, pk });
    return this;
  }

  /**
   * Validates all ops first; applies only when every op is legal.
   *
   * The pre-pass checks duplicate primary keys among the inserts and
   * against the table as it stands. It does not clone and dry-run, so an
   * update or delete that fails during the apply loop leaves the earlier
   * operations in place. The buffer is cleared either way, so a failed
   * commit cannot be retried.
   *
   * @throws {Error} If two inserts share a primary key, an insert collides
   *   with an existing row, or a named table does not exist.
   * @throws {Error} From the underlying `insert`, `update`, or `delete` if
   *   validation fails during the apply loop.
   */
  public commit(): void {
    // Not a dry run: only insert PK conflicts are pre-checked, against
    // the table as it stands and against earlier inserts in this batch.
    // An update or delete that fails during the apply loop is not undone.
    const seen = new Map<string, Set<string>>();
    for (const op of this.ops) {
      const t = this.db.table(op.table);
      if (op.kind === 'insert') {
        const pk = String((op.row as Record<string, unknown>)[t.schema.primaryKey]);
        let s = seen.get(op.table);
        if (!s) {
          s = new Set();
          seen.set(op.table, s);
        }
        if (s.has(pk) || t.findByPk(pk)) {
          throw new Error(`duplicate primary key '${pk}' in transaction`);
        }
        s.add(pk);
      }
    }
    for (const op of this.ops) {
      const t = this.db.table(op.table);
      if (op.kind === 'insert') t.insert(op.row);
      else if (op.kind === 'update') t.update(op.pk, op.patch as Partial<Row>);
      else t.delete(op.pk);
    }
    this.ops = [];
  }

  /**
   * Discards every buffered operation. No database state was touched by
   * buffering, so there is nothing else to undo.
   */
  public rollback(): void {
    this.ops = [];
  }
}
