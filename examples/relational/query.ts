/**
 * Query example: filter + sort + limit + projection.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { QueryBuilder } from '../../src/sdk/client/relational/query';

const db = new RelationalDatabase();
const users = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
]);
users.insert({ id: 'u1', age: 20 });
users.insert({ id: 'u2', age: 30 });
console.log(new QueryBuilder(users).where({ age: { gte: 21 } }).orderBy('age', 'desc').limit(1).all());
