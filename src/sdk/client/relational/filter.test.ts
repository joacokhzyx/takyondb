/**
 * ============================================================================
 * File: filter.test.ts
 * Description: Unit tests for predicate matching.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { matchesWhere } from './filter';

describe('matchesWhere', () => {
  it('matches eq and ranges', () => {
    expect(matchesWhere({ age: 20 }, { age: { eq: 20 } })).toBe(true);
    expect(matchesWhere({ age: 20 }, { age: { gte: 21 } })).toBe(false);
    expect(matchesWhere({ age: 20 }, { age: { in: [20, 30] } })).toBe(true);
  });
  it('matches shorthand equality', () => {
    expect(matchesWhere({ id: 'a' }, { id: 'a' } as never)).toBe(true);
  });
});
