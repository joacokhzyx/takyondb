/**
 * ============================================================================
 * File: utils.test.ts
 * Description: Unit tests for ART key namespacing.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { catalogKey, pkKey, secondaryKey } from './utils';

describe('relational keys', () => {
  it('namespaces pk', () => {
    expect(pkKey('users', 'u1')).toBe('tbl:users:u1');
  });
  it('namespaces catalog', () => {
    expect(catalogKey('users')).toBe('__catalog__:users');
  });
  it('namespaces secondary', () => {
    expect(secondaryKey('users', 'age', '28')).toBe('idx:users:age:28');
  });
});
