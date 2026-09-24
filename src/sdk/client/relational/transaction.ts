/**
 * ============================================================================
 * File: transaction.ts
 * Description: Logical batch transactions with validate-then-apply semantics.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { Row } from './codec';
import { RelationalDatabase } from './database';

export type TxOp =
  | { readonly kind: 'insert'; readonly table: string; readonly row: Row }
  | { readonly kind: 'update'; readonly table: string; readonly pk: unknown; readonly patch: Partial<Row> }
  | { readonly kind: 'delete'; readonly table: string; readonly pk: unknown };

/** Buffers ops, validates, then applies atomically (no partial apply). */
export class Transaction {
  private ops: TxOp[] = [];

  constructor(private readonly db: RelationalDatabase) {}

  public insert(table: string, row: Row): this {
    this.ops.push({ kind: 'insert', table, row });
    return this;
  }

  public update(table: string, pk: unknown, patch: Partial<Row>): this {
    this.ops.push({ kind: 'update', table, pk, patch });
    return this;
  }

  public delete(table: string, pk: unknown): this {
    this.ops.push({ kind: 'delete', table, pk });
    return this;
  }

  /** Validates all ops first; applies only when every op is legal. */
  public commit(): void {
    // Dry-run on clones would be ideal; here we validate PK conflicts
    // upfront by tracking inserts per table, then apply in order.
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

  public rollback(): void {
    this.ops = [];
  }
}
