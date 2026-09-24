/**
 * ============================================================================
 * File: integration.test.ts
 * Description: End-to-end relational flow (table + query + join + tx).
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { QueryBuilder } from './query';
import { hashJoin } from './join';
import { Transaction } from './transaction';
import { executeSelect } from './executor';

describe('relational integration', () => {
  it('runs full flow', () => {
    const db = new RelationalDatabase();
    const users = db.createTable('users', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'age', type: 'uint32' },
    ]);
    const orders = db.createTable('orders', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'user_id', type: 'string' },
    ]);
    new Transaction(db).insert('users', { id: 'u1', age: 28 }).insert('orders', { id: 'o1', user_id: 'u1' }).commit();
    expect(new QueryBuilder(users).count()).toBe(1);
    expect(hashJoin(orders, users, 'user_id', 'id')).toHaveLength(1);
    expect(executeSelect(db, 'SELECT id FROM users WHERE age >= 18')).toHaveLength(1);
  });
});
