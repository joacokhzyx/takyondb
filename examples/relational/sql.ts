/**
 * SQL example.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { executeSelect } from '../../src/sdk/client/relational/executor';

const db = new RelationalDatabase();
const users = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
]);
users.insert({ id: 'u1', age: 28 });
console.log(executeSelect(db, 'SELECT id FROM users WHERE age >= 18 LIMIT 10'));
