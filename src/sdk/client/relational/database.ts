/** The table catalog: name to `RelationalTable`, in creation order. */

import { ColumnDef } from './column';
import { TableExistsError, TableNotFoundError } from './errors';
import { RelationalTable } from './table';

/**
 * The set of tables, in creation order. The catalog holds structure only:
 * no rows are shared between processes and nothing survives a restart
 * until one of the persistence modules is used.
 */
export class RelationalDatabase {
  private tables = new Map<string, RelationalTable>();

  /**
   * Creates an empty database. There is no persistence until
   * `catalog_store.saveCatalog` or a `CatalogRecordStore` is used.
   */

  /**
   * Creates a table and adds it to the catalog.
   *
   * @param name - Table name, validated by `RelationalSchema`.
   * @param columns - 1 to 32 definitions with exactly one primary key.
   * @returns The new table.
   * @throws {TableExistsError} If the name is already in the catalog. There
   *   is no `createTableIfAbsent`; `persist.bootCatalog` is the idempotent
   *   form.
   * @throws {Error} From `RelationalSchema` for an invalid definition.
   */
  public createTable(name: string, columns: ColumnDef[]): RelationalTable {
    if (this.tables.has(name)) throw new TableExistsError(name);
    const t = new RelationalTable(name, columns);
    this.tables.set(name, t);
    return t;
  }

  /**
   * Removes a table and all of its rows.
   *
   * @param name - Table name.
   * @throws {TableNotFoundError} If no such table exists. Dropping an absent
   *   table is an error, not a no-op.
   */
  public dropTable(name: string): void {
    if (!this.tables.delete(name)) throw new TableNotFoundError(name);
  }

  /**
   * Looks a table up by name.
   *
   * @param name - Table name.
   * @returns The table.
   * @throws {TableNotFoundError} If no such table exists.
   */
  public table(name: string): RelationalTable {
    const t = this.tables.get(name);
    if (!t) throw new TableNotFoundError(name);
    return t;
  }

  /**
   * @returns Every table name, in creation order.
   */
  public listTables(): string[] {
    return [...this.tables.keys()];
  }
}
