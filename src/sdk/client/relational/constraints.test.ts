/**
 * ============================================================================
 * File: constraints.test.ts
 * Description: Unit tests for UNIQUE checks.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { assertUnique } from './constraints';

describe('assertUnique', () => {
  it('rejects duplicates', () => {
    const db = new RelationalDatabase();
    const t = db.createTable('t', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'email', type: 'string', unique: true },
    ]);
    t.insert({ id: 'a', email: 'a@x' });
    expect(() => assertUnique(t, 'email', 'a@x')).toThrow();
    expect(() => assertUnique(t, 'email', 'b@x')).not.toThrow();
  });
});
