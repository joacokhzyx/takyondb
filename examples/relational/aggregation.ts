/**
 * Aggregation example.
 */
import { RelationalDatabase } from '../../src/sdk/client/relational/database';
import { QueryBuilder } from '../../src/sdk/client/relational/query';

const db = new RelationalDatabase();
const t = db.createTable('t', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'v', type: 'uint32' },
]);
t.insert({ id: 'a', v: 10 });
t.insert({ id: 'b', v: 20 });
console.log(new QueryBuilder(t).agg('avg', 'v'));
