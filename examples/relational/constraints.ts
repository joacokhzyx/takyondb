/**
 * Constraints example.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { assertUnique } from '../../src/sdk/client/relational/constraints';

const db = new RelationalDatabase();
const t = db.createTable('t', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'email', type: 'string', unique: true },
]);
t.insert({ id: 'a', email: 'a@x' });
assertUnique(t, 'email', 'b@x');
console.log('unique ok');
