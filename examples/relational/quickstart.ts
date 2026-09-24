/**
 * TakyonDB relational quickstart (in-memory + zero-copy friendly).
 * Run with: npx ts-node --transpile-only examples_quickstart.ts
 */
import { RelationalDatabase } from '../src/sdk/client/relational/database';
import { QueryBuilder } from '../src/sdk/client/relational/query';
import { executeSelect } from '../src/sdk/client/relational/executor';

const db = new RelationalDatabase();
const users = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
  { name: 'balance', type: 'float64', nullable: true },
]);

users.insert({ id: 'u1', age: 28, balance: 1500.5 });
users.insert({ id: 'u2', age: 17 });

console.log(new QueryBuilder(users).where({ age: { gte: 18 } }).all());
console.log(executeSelect(db, 'SELECT id FROM users WHERE age >= 18 LIMIT 10'));
