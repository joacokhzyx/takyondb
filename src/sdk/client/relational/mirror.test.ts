/**
 * ============================================================================
 * File: mirror.test.ts
 * Description: Unit tests for ART PK mirroring with a mocked bridge.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { TakyonBindings } from '../proxy';
import { RelationalDatabase } from './database';
import { ArtMirror } from './mirror';

function mockBindings(store: Map<string, number>): TakyonBindings {
  const buffer = new ArrayBuffer(1024);
  return {
    initSharedMemory: () => buffer,
    pushDelta: () => 0,
    notifyArena: () => 0,
    verifyTestValue: () => 0,
    insert_index: (key: string, value_offset: number) => {
      store.set(key, value_offset);
      return 0;
    },
    search_index: (key: string) => store.get(key) ?? -1,
    remove_index: (key: string) => (store.delete(key) ? 1 : 0),
    trigger_checkpoint: () => 0,
    start_vacuum: () => 0,
  };
}

describe('ArtMirror', () => {
  it('mirrors, looks up and removes PKs in ART namespace', () => {
    const store = new Map<string, number>();
    const mirror = new ArtMirror(mockBindings(store));
    mirror.mirrorPk('users', 'u1', 4096);
    expect(store.get('tbl:users:u1')).toBe(4096);
    expect(mirror.lookupPk('users', 'u1')).toBe(4096);
    expect(mirror.lookupPk('users', 'missing')).toBeNull();
    expect(mirror.unmirrorPk('users', 'u1')).toBe(true);
    expect(mirror.unmirrorPk('users', 'u1')).toBe(false);
  });
  it('syncs whole tables', () => {
    const store = new Map<string, number>();
    const mirror = new ArtMirror(mockBindings(store));
    const db = new RelationalDatabase();
    const t = db.createTable('t', [{ name: 'id', type: 'string', primaryKey: true }]);
    t.insert({ id: 'a' });
    t.insert({ id: 'b' });
    mirror.syncTable(t, (pk) => (pk === 'a' ? 100 : 200));
    expect(mirror.lookupPk('t', 'a')).toBe(100);
    expect(mirror.lookupPk('t', 'b')).toBe(200);
  });
  it('rejects bad offsets and bridge errors', () => {
    const store = new Map<string, number>();
    const mirror = new ArtMirror(mockBindings(store));
    expect(() => mirror.mirrorPk('t', 'a', -1)).toThrow();
    const failing = mockBindings(store);
    failing.insert_index = () => -1;
    expect(() => new ArtMirror(failing).mirrorPk('t', 'a', 8)).toThrow();
  });
});
