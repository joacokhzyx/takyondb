/**
 * ============================================================================
 * File: database.test.ts
 * Description: Unit tests for relational catalog DDL.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';

describe('RelationalDatabase', () => {
  it('creates, lists and drops tables', () => {
    const db = new RelationalDatabase();
    db.createTable('users', [{ name: 'id', type: 'string', primaryKey: true }]);
    expect(db.listTables()).toEqual(['users']);
    expect(() => db.createTable('users', [{ name: 'id', type: 'string', primaryKey: true }])).toThrow();
    db.dropTable('users');
    expect(db.listTables()).toEqual([]);
  });
  it('throws for missing tables', () => {
    const db = new RelationalDatabase();
    expect(() => db.table('nope')).toThrow();
    expect(() => db.dropTable('nope')).toThrow();
  });
});
