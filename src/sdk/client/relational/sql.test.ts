/**
 * ============================================================================
 * File: sql.test.ts
 * Description: Unit tests for SELECT parser.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { parseSelect } from './sql';

describe('parseSelect', () => {
  it('parses star without where', () => {
    expect(parseSelect('SELECT * FROM users')).toMatchObject({ table: 'users' });
  });
  it('parses where and limit', () => {
    const p = parseSelect("SELECT id FROM users WHERE age >= 18 LIMIT 10");
    expect(p.whereCol).toBe('age');
    expect(p.limit).toBe(10);
  });
  it('rejects unsupported', () => {
    expect(() => parseSelect('DELETE EVERYTHING')).toThrow();
  });
});
