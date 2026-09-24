/**
 * ============================================================================
 * File: codec.test.ts
 * Description: Unit tests for row validation.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalSchema } from './schema';
import { validateRow } from './codec';

describe('validateRow', () => {
  it('accepts valid rows and rejects bad types', () => {
    const s = new RelationalSchema('t', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'age', type: 'uint32' },
    ]);
    expect(() => validateRow(s, { id: 'a', age: 1 })).not.toThrow();
    expect(() => validateRow(s, { id: 'a', age: 'x' })).toThrow();
    expect(() => validateRow(s, { age: 1 })).toThrow();
  });
});
