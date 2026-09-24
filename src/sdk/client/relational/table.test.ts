/**
 * ============================================================================
 * File: table.test.ts
 * Description: Unit tests for relational table CRUD and constraints.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalTable } from './table';

function usersTable() {
  return new RelationalTable('users', [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'age', type: 'uint32' },
  ]);
}

describe('RelationalTable', () => {
  it('inserts and finds by pk', () => {
    const t = usersTable();
    t.insert({ id: 'u1', age: 28 });
    expect(t.findByPk('u1')).toMatchObject({ id: 'u1', age: 28 });
  });
  it('rejects duplicate pk', () => {
    const t = usersTable();
    t.insert({ id: 'u1', age: 1 });
    expect(() => t.insert({ id: 'u1', age: 2 })).toThrow();
  });
  it('updates and deletes', () => {
    const t = usersTable();
    t.insert({ id: 'u1', age: 1 });
    expect(t.update('u1', { age: 2 })).toMatchObject({ age: 2 });
    expect(t.delete('u1')).toBe(true);
    expect(t.findByPk('u1')).toBeNull();
  });
});
