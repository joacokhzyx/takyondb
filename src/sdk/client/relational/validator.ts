/**
 * ============================================================================
 * File: validator.ts
 * Description: Cross-table validators (FK existence).
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { RelationalDatabase } from './database';

/** Asserts a foreign key value exists in the parent table PK. */
export function assertForeignKey(db: RelationalDatabase, parentTable: string, value: unknown): void {
  const parent = db.table(parentTable);
  if (!parent.findByPk(value)) {
    throw new Error(`FOREIGN KEY violation: '${value}' missing in '${parentTable}'`);
  }
}
