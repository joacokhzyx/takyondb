/**
 * ============================================================================
 * File: query.test.ts
 * Description: Unit tests for fluent queries with filter and projection.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { QueryBuilder } from './query';

describe('QueryBuilder', () => {
  it('filters, sorts, limits and projects', () => {
    const db = new RelationalDatabase();
    const users = db.createTable('users', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'age', type: 'uint32' },
    ]);
    users.insert({ id: 'u1', age: 20 });
    users.insert({ id: 'u2', age: 30 });
    users.insert({ id: 'u3', age: 25 });
    const rows = new QueryBuilder(users)
      .where({ age: { gte: 21 } })
      .orderBy('age', 'desc')
      .limit(2)
      .select(['id'])
      .all();
    expect(rows.map((r) => r.id)).toEqual(['u2', 'u3']);
  });
  it('aggregates count and avg', () => {
    const db = new RelationalDatabase();
    const t = db.createTable('t', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'v', type: 'uint32' },
    ]);
    t.insert({ id: 'a', v: 10 });
    t.insert({ id: 'b', v: 20 });
    const q = new QueryBuilder(t);
    expect(q.count()).toBe(2);
    expect(q.agg('avg', 'v')).toBe(15);
  });
});
