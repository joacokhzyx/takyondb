/**
 * Transactions example: atomic batch insert.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { Transaction } from '../../src/sdk/client/relational/transaction';

const db = new RelationalDatabase();
db.createTable('t', [{ name: 'id', type: 'string', primaryKey: true }]);
new Transaction(db).insert('t', { id: 'a' }).insert('t', { id: 'b' }).commit();
console.log(db.table('t').count());
