/**
 * ============================================================================
 * File: schema.test.ts
 * Description: Unit tests for relational schema compilation.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalSchema } from './schema';

describe('RelationalSchema', () => {
  it('compiles offsets with null bitmap', () => {
    const s = new RelationalSchema('users', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'age', type: 'uint32' },
    ]);
    expect(s.primaryKey).toBe('id');
    expect(s.totalSize).toBeGreaterThan(8);
    expect(s.byName.get('age')!.offset).toBeGreaterThanOrEqual(4);
  });
  it('requires exactly one pk', () => {
    expect(
      () => new RelationalSchema('t', [{ name: 'a', type: 'uint32' }]),
    ).toThrow();
  });
  it('rejects bad names', () => {
    expect(() => new RelationalSchema('1bad', [])).toThrow();
  });
});
