/**
 * ============================================================================
 * File: database.ts
 * Description: Catalog of relational tables with DDL helpers.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { ColumnDef } from './column';
import { TableExistsError, TableNotFoundError } from './errors';
import { RelationalTable } from './table';

export class RelationalDatabase {
  private tables = new Map<string, RelationalTable>();

  /** Creates a table; throws TableExistsError on duplicate. */
  public createTable(name: string, columns: ColumnDef[]): RelationalTable {
    if (this.tables.has(name)) throw new TableExistsError(name);
    const t = new RelationalTable(name, columns);
    this.tables.set(name, t);
    return t;
  }

  /** Drops a table; throws TableNotFoundError when missing. */
  public dropTable(name: string): void {
    if (!this.tables.delete(name)) throw new TableNotFoundError(name);
  }

  /** Returns a table or throws TableNotFoundError. */
  public table(name: string): RelationalTable {
    const t = this.tables.get(name);
    if (!t) throw new TableNotFoundError(name);
    return t;
  }

  /** Lists table names in creation order. */
  public listTables(): string[] {
    return [...this.tables.keys()];
  }
}
