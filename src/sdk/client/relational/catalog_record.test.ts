/**
 * ============================================================================
 * File: catalog_record.test.ts
 * Description: Round-trip and tamper tests for the fixed catalog codec.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { TakyonBindings } from '../proxy';
import {
  CatalogRecordStore,
  catalogRecordKey,
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
    expect(catalogRecordKey('users')).toBe('__catalog__:users');
    expect(() => catalogRecordKey('')).toThrow();
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

const ARENA_WORDS = 512;
const BUMP_OFF = 0;
const DATA_START = 4;

function mockArenaBindings(index: Map<string, number>): TakyonBindings {
  const buffer = new ArrayBuffer(ARENA_WORDS * 4);
  return {
    initSharedMemory: () => buffer,
    pushDelta: () => 0,
    notifyArena: () => 0,
    verifyTestValue: () => 0,
    insert_index: (key: string, off: number) => {
      index.set(key, off);
      return 0;
    },
    search_index: (key: string) => index.get(key) ?? -1,
    remove_index: (key: string) => (index.delete(key) ? 1 : 0),
    trigger_checkpoint: () => 0,
    start_vacuum: () => 0,
  };
}

describe('CatalogRecordStore', () => {
  it('saves and loads through the ART index', () => {
    const memory = new ArrayBuffer(ARENA_WORDS * 4);
    const store = new CatalogRecordStore(mockArenaBindings(new Map()), memory, {
      bumpOffset: BUMP_OFF,
      dataStart: DATA_START,
    });
    const cols = [
      { name: 'id', type: 'uint32' as const, primaryKey: true },
      { name: 'age', type: 'uint32' as const, nullable: true },
    ];
    const at = store.save('users', cols);
    expect(at).toBe(DATA_START);
    const dec = store.load('users');
    expect(dec?.table).toBe('users');
    expect(dec?.columns).toHaveLength(2);
    expect(store.load('missing')).toBeNull();
    // Re-save overwrites in place (idempotent DDL).
    const at2 = store.save('users', cols);
    expect(at2).toBeGreaterThan(at);
    expect(store.load('users')?.columns).toHaveLength(2);
  });

  it('rejects corrupt payloads on load', () => {
    const memory = new ArrayBuffer(ARENA_WORDS * 4);
    const index = new Map<string, number>();
    const store = new CatalogRecordStore(mockArenaBindings(index), memory, {
      bumpOffset: BUMP_OFF,
      dataStart: DATA_START,
    });
    store.save('t', [{ name: 'id', type: 'uint32' as const, primaryKey: true }]);
    const off = index.get(catalogRecordKey('t'))!;
    new DataView(memory).setUint8(off + 8, 0xff); // smash table-name length
    expect(() => store.load('t')).toThrow();
  });
});
