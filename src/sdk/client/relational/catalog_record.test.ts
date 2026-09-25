/**
 * ============================================================================
 * File: catalog_record.test.ts
 * Description: Round-trip and tamper tests for the fixed catalog codec.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  catalogKey,
  decodeCatalogRecord,
  encodeCatalogRecord,
} from './catalog_record';

describe('catalog_record codec', () => {
  it('round-trips a table definition', () => {
    const buf = encodeCatalogRecord('users', [
      { name: 'id', type: 'uint32', primaryKey: true, unique: true },
      { name: 'age', type: 'uint32', nullable: true },
    ]);
    const dec = decodeCatalogRecord(buf);
    expect(dec.table).toBe('users');
    expect(dec.columns).toHaveLength(2);
    expect(dec.columns[0]).toMatchObject({ name: 'id', type: 'uint32', primaryKey: true, unique: true });
    expect(dec.columns[1]).toMatchObject({ name: 'age', nullable: true });
  });

  it('builds namespaced keys', () => {
    expect(catalogKey('users')).toBe('__catalog__:users');
    expect(() => catalogKey('')).toThrow();
  });

  it('rejects tampered payloads', () => {
    const buf = encodeCatalogRecord('t', [{ name: 'id', type: 'uint32', primaryKey: true }]);
    const badMagic = Uint8Array.from(buf);
    badMagic[0] ^= 0xff;
    expect(() => decodeCatalogRecord(badMagic)).toThrow();
    const badPad = Uint8Array.from(buf);
    badPad[8 + 65 + 3] = 0xaa;
    expect(() => decodeCatalogRecord(badPad)).toThrow();
  });
});
