/** Boot-time catalog restoration. */

import { ColumnDef } from './column';
import { RelationalDatabase } from './database';

/**
 * Recreates tables from definitions (idempotent boot helper).
 *
 * A name already present is skipped, not overwritten: booting a stale
 * definition list over a migrated database leaves the migrated tables
 * alone. Use `dropTable` and `createTable` for a definition that must be
 * replaced.
 *
 * @param db - The catalog to populate.
 * @param defs - Table definitions to create.
 * @throws {Error} From `RelationalSchema` for a definition that does not
 *   validate, or `TableExistsError` if a name is created concurrently
 *   between the check and the create.
 */
export function bootCatalog(db: RelationalDatabase, defs: { name: string; columns: ColumnDef[] }[]): void {
  // listTables() allocates the whole name array per definition; the
  // definitions list is short and this runs once at boot.
  for (const d of defs) {
    if (!db.listTables().includes(d.name)) db.createTable(d.name, d.columns);
  }
}
