/**
 * Persist example: boot catalog idempotently.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { bootCatalog } from '../../src/sdk/client/relational/persist';

const db = new RelationalDatabase();
bootCatalog(db, [{ name: 't', columns: [{ name: 'id', type: 'string', primaryKey: true }] }]);
console.log(db.listTables());
