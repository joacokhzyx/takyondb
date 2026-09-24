/**
 * ============================================================================
 * File: types.test.ts
 * Description: Unit tests for relational physical types.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { isVariableType, relationalTypeSize } from './types';

describe('relational types', () => {
  it('sizes fixed types', () => {
    expect(relationalTypeSize('bool')).toBe(1);
    expect(relationalTypeSize('int32')).toBe(4);
    expect(relationalTypeSize('float64')).toBe(8);
  });
  it('variable types use fat pointer', () => {
    expect(relationalTypeSize('string')).toBe(8);
    expect(isVariableType('string')).toBe(true);
    expect(isVariableType('uint32')).toBe(false);
  });
  it('rejects unknown', () => {
    expect(() => relationalTypeSize('xml' as never)).toThrow();
  });
});
