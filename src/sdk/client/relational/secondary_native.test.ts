/**
 * ============================================================================
 * File: secondary_native.test.ts
 * Description: Unit tests for durable ART-backed secondary indexes.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { TakyonBindings } from '../proxy';
import { NativeSecondaryIndex, SECONDARY_SEP, padI64Hex16, padU32Hex } from './secondary_native';

function mockBindings(store: Map<string, number>): TakyonBindings {
  const buffer = new ArrayBuffer(1024);
  const startsWith = (prefix: string) => {
    const out: number[] = [];
    for (const [k, v] of store) if (k.startsWith(prefix)) out.push(v);
    return new Uint32Array(out);
  };
  return {
    initSharedMemory: () => buffer,
    pushDelta: () => 0,
    notifyArena: () => 0,
    verifyTestValue: () => 0,
    insert_index: (key: string, value_offset: number) => {
      if (store.has(key)) return 0;
      store.set(key, value_offset);
      return 0;
    },
    search_index: (key: string) => store.get(key) ?? -1,
    remove_index: (key: string) => (store.delete(key) ? 1 : 0),
    scan_prefix: (prefix: string) => startsWith(prefix),
    scan_range: (prefix: string, lo = '', hi = '') => {
      const out: number[] = [];
      for (const [k, v] of store) {
        if (!k.startsWith(prefix)) continue;
        const s = k.slice(prefix.length);
        if (lo !== '' && s < lo) continue;
        if (hi !== '' && s > hi) continue;
        out.push(v);
      }
      return new Uint32Array(out);
    },
    trigger_checkpoint: () => 0,
    start_vacuum: () => 0,
  };
}

describe('NativeSecondaryIndex', () => {
  it('uses unit-separator namespaced keys', () => {
    expect(SECONDARY_SEP).toBe('\x1F');
  });
  it('adds, looks up and removes entries', () => {
    const store = new Map<string, number>();
    const idx = new NativeSecondaryIndex(mockBindings(store), 'users', 'age');
    idx.add(28, 'u1', 100);
    idx.add(28, 'u2', 200);
    idx.add(30, 'u3', 300);
    expect(idx.lookup(28).sort((a, b) => a - b)).toEqual([100, 200]);
    expect(idx.lookup(30)).toEqual([300]);
    expect(idx.lookup(99)).toEqual([]);
    expect(idx.remove(28, 'u1')).toBe(true);
    expect(idx.lookup(28)).toEqual([200]);
    expect(idx.remove(28, 'u1')).toBe(false);
  });
  it('enforces UNIQUE', () => {
    const store = new Map<string, number>();
    const idx = new NativeSecondaryIndex(mockBindings(store), 'users', 'email', { unique: true });
    idx.add('a@x', 'u1', 100);
    expect(() => idx.add('a@x', 'u2', 200)).toThrow();
    expect(() => idx.add('b@x', 'u2', 200)).not.toThrow();
  });
  it('ranges over values in byte order', () => {
    const store = new Map<string, number>();
    const idx = new NativeSecondaryIndex(mockBindings(store), 't', 'age');
    idx.add('020', 'a', 1);
    idx.add('028', 'b', 2);
    idx.add('030', 'c', 3);
    expect(idx.lookupRange('020', '028').sort((a, b) => a - b)).toEqual([1, 2]);
    expect(idx.lookupRange('', '')).toHaveLength(3);
  });
  it('throws without bridge scan support', () => {
    const plain = mockBindings(new Map<string, number>());
    delete plain.scan_prefix;
    delete plain.scan_range;
    const idx = new NativeSecondaryIndex(plain, 't', 'c');
    expect(() => idx.lookup(1)).toThrow();
    expect(() => idx.lookupRange(1, 2)).toThrow();
  });
  it('pads u32 hex order-preserving without NUL', () => {
    expect(padU32Hex(0)).toBe('00000000');
    expect(padU32Hex(0xffffffff)).toBe('ffffffff');
    expect(padU32Hex(2) < padU32Hex(10)).toBe(true);
    expect(() => padU32Hex(-1)).toThrow();
  });
  it('pads i64 hex with negatives first', () => {
    expect(padI64Hex16(-5) < padI64Hex16(0)).toBe(true);
    expect(padI64Hex16(0) < padI64Hex16(5)).toBe(true);
  });
  it('ranges numerically without caller zero-pad', () => {
    const store = new Map<string, number>();
    const bindings = mockBindings(store);
    const idx = new NativeSecondaryIndex(bindings, 't', 'age');
    // Padded entries (new write path).
    bindings.insert_index(`idx:t:age:${padU32Hex(2)}\x1Fa`, 1);
    bindings.insert_index(`idx:t:age:${padU32Hex(28)}\x1Fb`, 2);
    bindings.insert_index(`idx:t:age:${padU32Hex(30)}\x1Fc`, 3);
    expect(idx.lookupNumericRange(2, 28).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(idx.cardinality()).toBe(3);
    expect(() => idx.lookupNumericRange(9, 2)).toThrow();
  });
});
