/**
 * Secondary index example.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { lookupByColumn } from '../../src/sdk/client/relational/secondary_index';

const db = new RelationalDatabase();
const t = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
]);
t.insert({ id: 'u1', age: 28 });
console.log(lookupByColumn(t, 'age', 28));
