/**
 * Join example: orders JOIN users.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { hashJoin } from '../../src/sdk/client/relational/join';

const db = new RelationalDatabase();
const users = db.createTable('users', [{ name: 'id', type: 'string', primaryKey: true }]);
const orders = db.createTable('orders', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'user_id', type: 'string' },
]);
users.insert({ id: 'u1' });
orders.insert({ id: 'o1', user_id: 'u1' });
console.log(hashJoin(orders, users, 'user_id', 'id'));
