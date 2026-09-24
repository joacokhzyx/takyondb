/**
 * ============================================================================
 * File: transaction.test.ts
 * Description: Unit tests for batch transactions.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { Transaction } from './transaction';

describe('Transaction', () => {
  it('commits batches atomically', () => {
    const db = new RelationalDatabase();
    db.createTable('t', [{ name: 'id', type: 'string', primaryKey: true }]);
    new Transaction(db).insert('t', { id: 'a' }).insert('t', { id: 'b' }).commit();
    expect(db.table('t').count()).toBe(2);
  });
  it('rejects duplicate pk without partial apply', () => {
    const db = new RelationalDatabase();
    db.createTable('t', [{ name: 'id', type: 'string', primaryKey: true }]);
    db.table('t').insert({ id: 'a' });
    expect(() => new Transaction(db).insert('t', { id: 'b' }).insert('t', { id: 'a' }).commit()).toThrow();
    expect(db.table('t').findByPk('b')).toBeNull();
  });
});
