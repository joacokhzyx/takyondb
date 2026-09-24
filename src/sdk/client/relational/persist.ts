/**
 * ============================================================================
 * File: persist.ts
 * Description: Catalog persistence helpers (recreate tables on boot).
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { ColumnDef } from './column';
import { RelationalDatabase } from './database';

/** Recreates tables from definitions (idempotent boot helper). */
export function bootCatalog(db: RelationalDatabase, defs: { name: string; columns: ColumnDef[] }[]): void {
  for (const d of defs) {
    if (!db.listTables().includes(d.name)) db.createTable(d.name, d.columns);
  }
}
