/**
 * ============================================================================
 * File: executor.test.ts
 * Description: Unit tests for SELECT executor.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { executeSelect } from './executor';

describe('executeSelect', () => {
  it('runs filtered selects', () => {
    const db = new RelationalDatabase();
    const t = db.createTable('users', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'age', type: 'uint32' },
    ]);
    t.insert({ id: 'u1', age: 20 });
    t.insert({ id: 'u2', age: 30 });
    expect(executeSelect(db, 'SELECT id FROM users WHERE age >= 25')).toHaveLength(1);
    expect(executeSelect(db, 'SELECT * FROM users LIMIT 1')).toHaveLength(1);
  });
});
