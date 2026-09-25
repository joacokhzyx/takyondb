/**
 * Catalog durability example: save DDL, restore it into a fresh database.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { restoreCatalog, saveCatalog } from '../../src/sdk/client/relational/catalog_store';

const db = new RelationalDatabase();
db.createTable('users', [{ name: 'id', type: 'string', primaryKey: true }]);
saveCatalog(db, '/tmp/takyondb-example/catalog.json');

const rebooted = new RelationalDatabase();
restoreCatalog(rebooted, '/tmp/takyondb-example/catalog.json');
console.log(rebooted.listTables());
