/** Cross-table reference check. */

import { RelationalDatabase } from './database';

/**
 * Asserts a foreign key value exists in the parent table PK.
 *
 * Like `assertUnique`, this is not called by any write path; a schema has
 * no way to declare a foreign key, so the caller owns the check.
 *
 * @param db - The catalog holding the parent table.
 * @param parentTable - Name of the table the key points into.
 * @param value - The referenced primary key, rendered by `encodePk`, so
 *   `1` and `'1'` are the same parent row.
 * @throws {TableNotFoundError} If `parentTable` does not exist.
 * @throws {Error} If no parent row has that primary key.
 * @throws {Error} If `value` is not a renderable key type.
 */
export function assertForeignKey(db: RelationalDatabase, parentTable: string, value: unknown): void {
  const parent = db.table(parentTable);
  if (!parent.findByPk(value)) {
    throw new Error(`FOREIGN KEY violation: '${value}' missing in '${parentTable}'`);
  }
}
