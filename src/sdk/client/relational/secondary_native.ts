/**
 * ============================================================================
 * File: secondary_native.ts
 * Description: Durable secondary indexes backed by the engine ART.
 *   Each entry is a unique key `idx:<table>:<col>:<value><SEP><pk>`
 *   holding the record offset, so point and range lookups reuse the
 *   lock-free ART, WAL durability, snapshots, and cross-process
 *   visibility instead of per-process memory maps. Ordering is byte
 *   lexicographic (zero-pad numerics for range scans). SEP is U+001F;
 *   only NUL bytes are forbidden by the engine.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { TakyonBindings } from '../proxy';

/** Separator between value and pk inside secondary keys (U+001F). */
export const SECONDARY_SEP = '\x1F';

/** Order-preserving NUL-free 8-hex encoding of a u32 (mirrors Zig padU32Hex). */
export function padU32Hex(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`u32 out of range: ${value}`);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** Order-preserving 16-hex encoding of an i64-range integer (sign-bias flipped). */
export function padI64Hex16(value: number): string {
  if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`int out of safe range: ${value}`);
  }
  const biased = BigInt(value) ^ BigInt('0x8000000000000000');
  return (biased & BigInt('0xFFFFFFFFFFFFFFFF')).toString(16).padStart(16, '0');
}

/** Upper sentinel appended to hi bounds so `value<SEP>*` sorts below it. */
const HI_SENTINEL = '\uFFFF';

function encodeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`unsupported secondary value type: ${typeof value}`);
}

function entryKey(table: string, column: string, value: string, pk: string): string {
  return `idx:${table}:${column}:${value}${SECONDARY_SEP}${pk}`;
}

function valuePrefix(table: string, column: string, value: string): string {
  return `idx:${table}:${column}:${value}${SECONDARY_SEP}`;
}

export interface NativeSecondaryOptions {
  readonly unique?: boolean;
}

export class NativeSecondaryIndex {
  constructor(
    private readonly bindings: TakyonBindings,
    private readonly table: string,
    private readonly column: string,
    private readonly options: NativeSecondaryOptions = {},
  ) {
    if (!table || !column) throw new Error('table and column are required');
  }

  /** Adds a value->pk mapping. UNIQUE columns reject duplicates. */
  public add(value: unknown, pk: unknown, recordOffset: number): void {
    if (!Number.isInteger(recordOffset) || recordOffset < 0) {
      throw new Error(`record offset must be a non-negative integer, got ${recordOffset}`);
    }
    const v = encodeValue(value);
    const p = String(pk);
    if (this.options.unique && this.lookup(value).length > 0) {
      throw new Error(`UNIQUE violation on '${this.column}'`);
    }
    const rc = this.bindings.insert_index(entryKey(this.table, this.column, v, p), recordOffset);
    if (rc !== 0) throw new Error(`insert_index failed for secondary '${this.column}'`);
  }

  /** Returns record offsets for an exact value. */
  public lookup(value: unknown): number[] {
    const scan = this.bindings.scan_prefix;
    if (!scan) throw new Error('bridge has no scan_prefix (rebuild the addon)');
    const v = encodeValue(value);
    return Array.from(scan.call(this.bindings, valuePrefix(this.table, this.column, v), 4096));
  }

  /** Returns record offsets for values in [`lo`, `hi`] (byte order). */
  public lookupRange(lo: unknown, hi: unknown, maxResults = 1024): number[] {
    const scan = this.bindings.scan_range;
    if (!scan) throw new Error('bridge has no scan_range (rebuild the addon)');
    const loV = encodeValue(lo);
    const hiV = encodeValue(hi);
    // Unbounded sides must be empty strings: the engine treats len 0 as
    // unbounded, and any sentinel would wrongly filter real suffixes.
    const loBound = loV === '' ? '' : `${loV}${SECONDARY_SEP}`;
    const hiBound = hiV === '' ? '' : `${hiV}${SECONDARY_SEP}${HI_SENTINEL}`;
    const out = scan.call(
      this.bindings,
      `idx:${this.table}:${this.column}:`,
      loBound,
      hiBound,
      maxResults,
    );
    return Array.from(out);
  }

  /** Removes one value->pk mapping. True iff it was present. */
  public remove(value: unknown, pk: unknown): boolean {
    const v = encodeValue(value);
    const rc = this.bindings.remove_index(entryKey(this.table, this.column, v, String(pk)));
    if (rc === 1) return true;
    if (rc === 0) return false;
    throw new Error(`remove_index failed for secondary '${this.column}'`);
  }

  /**
   * Numeric range over u32 values stored with `padU32Hex` (no manual
   * zero-pad by callers): byte order == numeric order.
   * Entries must have been added with the padded form.
   */
  public lookupNumericRange(lo: number, hi: number, maxResults = 1024): number[] {
    const scan = this.bindings.scan_range;
    if (!scan) throw new Error('bridge has no scan_range (rebuild the addon)');
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
      throw new Error(`invalid numeric range [${lo}, ${hi}]`);
    }
    const loBound = `${padU32Hex(lo)}${SECONDARY_SEP}`;
    const hiBound = `${padU32Hex(hi)}${SECONDARY_SEP}${HI_SENTINEL}`;
    const out = scan.call(this.bindings, `idx:${this.table}:${this.column}:`, loBound, hiBound, maxResults);
    return Array.from(out);
  }

  /** Counts entries under this index prefix (cardinality). */
  public cardinality(maxResults = 4096): number {
    const scan = this.bindings.scan_prefix;
    if (!scan) throw new Error('bridge has no scan_prefix (rebuild the addon)');
    return scan.call(this.bindings, `idx:${this.table}:${this.column}:`, maxResults).length;
  }
}
