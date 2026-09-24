/**
 * ============================================================================
 * File: join.test.ts
 * Description: Unit tests for hash joins.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { hashJoin } from './join';

describe('hashJoin', () => {
  it('joins orders to users', () => {
    const db = new RelationalDatabase();
    const users = db.createTable('users', [{ name: 'id', type: 'string', primaryKey: true }]);
    const orders = db.createTable('orders', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'user_id', type: 'string' },
    ]);
    users.insert({ id: 'u1' });
    orders.insert({ id: 'o1', user_id: 'u1' });
    orders.insert({ id: 'o2', user_id: 'missing' });
    const rows = hashJoin(orders, users, 'user_id', 'id');
    expect(rows).toHaveLength(1);
    expect(rows[0].left.id).toBe('o1');
  });
});
