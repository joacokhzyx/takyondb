/**
 * ============================================================================
 * File: validator.test.ts
 * Description: Unit tests for FK validators.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { assertForeignKey } from './validator';

describe('assertForeignKey', () => {
  it('validates parent existence', () => {
    const db = new RelationalDatabase();
    db.createTable('users', [{ name: 'id', type: 'string', primaryKey: true }]);
    db.table('users').insert({ id: 'u1' });
    expect(() => assertForeignKey(db, 'users', 'u1')).not.toThrow();
    expect(() => assertForeignKey(db, 'users', 'missing')).toThrow();
  });
});
