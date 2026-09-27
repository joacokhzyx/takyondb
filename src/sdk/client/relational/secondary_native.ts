/**
 * Secondary indexes stored in the engine ART rather than in a per-process
 * map, so they inherit the lock-free index, the WAL, snapshots, and
 * cross-process visibility.
 *
 * One entry per row, keyed `idx:<table>:<col>:<value><SEP><pk>`, holding
 * the record offset. Putting the primary key in the key rather than in the
 * value is what lets two rows share an indexed value without colliding.
 * Ordering is byte lexicographic, so a numeric range scan needs the value
 * zero-padded by `padU32Hex` or `padI64Hex16` first.
 */

import { TakyonBindings } from '../proxy';

/**
 * Separator between value and pk inside secondary keys (U+001F).
 *
 * The unit separator, not a printable character, so a value containing
 * arbitrary text cannot forge the boundary. The engine forbids only NUL in
 * a key, so this is the lowest code point that cannot occur in a key's
 * own namespace prefix and still stays below every printable character.
 */
export const SECONDARY_SEP = '\x1F';

/**
 * Order-preserving NUL-free 8-hex encoding of a u32 (mirrors Zig padU32Hex).
 *
 * Zero padding to a fixed width is what makes byte order match numeric
 * order: without it `'10'` would sort before `'9'`, and a range scan would
 * return the wrong rows. Values must be stored in this form for
 * `lookupNumericRange` to find them.
 *
 * @param value - The integer to encode.
 * @returns Exactly 8 lowercase hex digits.
 * @throws {Error} If `value` is not an integer in 0..0xFFFFFFFF.
 */
export function padU32Hex(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`u32 out of range: ${value}`);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * Order-preserving 16-hex encoding of an i64-range integer (sign-bias flipped).
 *
 * XOR with the sign bit turns the two's-complement order into unsigned
 * order, so `-1` encodes above `0` and a byte-wise scan returns the values
 * in numeric order. Range is JavaScript's safe integer, not the full i64.
 *
 * @param value - The integer to encode.
 * @returns Exactly 16 lowercase hex digits.
 * @throws {Error} If `value` is not an integer within
 *   `Number.MAX_SAFE_INTEGER` of zero.
 */
export function padI64Hex16(value: number): string {
  if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`int out of safe range: ${value}`);
  }
  const biased = BigInt(value) ^ BigInt('0x8000000000000000');
  return (biased & BigInt('0xFFFFFFFFFFFFFFFF')).toString(16).padStart(16, '0');
}

/**
 * Upper sentinel appended to hi bounds so `value<SEP>*` sorts below it.
 *
 * `scan_range` treats `hi` as exclusive, so a plain `value<SEP>` would
 * exclude every row at that value. U+FFFF is the highest code point there
 * is, so `value<SEP><U+FFFF>` is at or above every real
 * `value<SEP><pk>` suffix and admits all of them, while still excluding
 * the next value up. Only a primary key that is literally U+FFFF sorts
 * equal and is dropped.
 */
const HI_SENTINEL = '\uFFFF';

/**
 * Renders an indexed value as its key fragment.
 *
 * @param value - A string, number, or boolean.
 * @returns The rendered value.
 * @throws {Error} For any other type. A `bytes` column has no indexable
 *   form here; hex-encode it before indexing.
 */
function encodeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`unsupported secondary value type: ${typeof value}`);
}

/**
 * Builds the ART key for one secondary entry.
 *
 * @param table - Table name.
 * @param column - Indexed column name.
 * @param value - The rendered indexed value.
 * @param pk - The primary key, which makes the entry unique per row.
 * @returns `idx:<table>:<column>:<value><SEP><pk>`.
 */
function entryKey(table: string, column: string, value: string, pk: string): string {
  return `idx:${table}:${column}:${value}${SECONDARY_SEP}${pk}`;
}

/**
 * Builds the prefix matching every row sharing one indexed value.
 *
 * @param table - Table name.
 * @param column - Indexed column name.
 * @param value - The rendered indexed value.
 * @returns `idx:<table>:<column>:<value><SEP>`.
 */
function valuePrefix(table: string, column: string, value: string): string {
  return `idx:${table}:${column}:${value}${SECONDARY_SEP}`;
}

/** Construction options for a `NativeSecondaryIndex`. */
export interface NativeSecondaryOptions {
  /** Enforce one row per value. Costs a scan of the value's entries on
   * every `add`. */
  readonly unique?: boolean;
}

/**
 * One secondary index over one column, held in the engine ART.
 *
 * One instance per `(table, column)`; the two are constructor state, so a
 * caller cannot address a different column through an existing index.
 */
export class NativeSecondaryIndex {
  /**
   * @param bindings - The native engine surface.
   * @param table - Table name, forming the key namespace.
   * @param column - Indexed column name.
   * @param options - Index options; see `NativeSecondaryOptions`.
   * @throws {Error} If `table` or `column` is empty.
   */
  constructor(
    private readonly bindings: TakyonBindings,
    private readonly table: string,
    private readonly column: string,
    private readonly options: NativeSecondaryOptions = {},
  ) {
    if (!table || !column) throw new Error('table and column are required');
  }

  /**
   * Adds a value->pk mapping. UNIQUE columns reject duplicates.
   *
   * The `unique` check is a prefix scan, so it is a separate round trip and
   * is only as atomic as the two calls together. Two concurrent adds of the
   * same value can both pass it.
   *
   * @param value - The indexed value.
   * @param pk - The primary key, rendered with `String`.
   * @param recordOffset - Absolute SharedArena offset of the row.
   * @throws {Error} If `recordOffset` is not a non-negative integer, or a
   *   `unique` index already holds this value.
   * @throws {RangeError} If the key is empty, over 256 bytes, or contains a
   *   NUL.
   * @throws {Error} If `insert_index` returns nonzero. As with every ART
   *   write, the entry is only durable with a daemon attached.
   */
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

  /**
   * Returns record offsets for an exact value.
   *
   * @param value - The indexed value, rendered by `encodeValue`.
   * @returns The matching record offsets, in key order. Empty when the value
   *   is not indexed.
   * @throws {Error} If the addon has no `scan_prefix`, or `value` is not a
   *   renderable type.
   */
  public lookup(value: unknown): number[] {
    const scan = this.bindings.scan_prefix;
    if (!scan) throw new Error('bridge has no scan_prefix (rebuild the addon)');
    const v = encodeValue(value);
    return Array.from(scan.call(this.bindings, valuePrefix(this.table, this.column, v), 4096));
  }

  /**
   * Returns record offsets for values in [`lo`, `hi`] (byte order).
   *
   * The bounds are compared as bytes against the key suffix, so numeric
   * values must already be in the padded encoding this index stores or the
   * comparison is against the wrong thing.
   *
   * @param lo - Inclusive lower bound, or `''` for unbounded below.
   * @param hi - Inclusive upper bound, or `''` for unbounded above.
   * @param maxResults - Cap on returned offsets, 1 to 4096. Truncation is
   *   silent.
   * @returns The matching record offsets, in key order.
   * @throws {Error} If the addon has no `scan_range`, or a bound is not a
   *   renderable type.
   * @throws {RangeError} If `maxResults` is outside 1..4096.
   */
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

  /**
   * Removes one value->pk mapping. True iff it was present.
   *
   * @param value - The indexed value.
   * @param pk - The primary key, rendered with `String`. Both are needed:
   *   the key is value and primary key together.
   * @returns True when the entry existed and was deleted, false when it did
   *   not exist.
   * @throws {Error} If `value` is not a renderable type.
   * @throws {RangeError} If the key is empty, over 256 bytes, or contains a
   *   NUL.
   * @throws {Error} If `remove_index` returns -1.
   */
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
   *
   * @param lo - Inclusive lower bound, as a number.
   * @param hi - Inclusive upper bound, as a number. An `hi` below `lo` is
   *   an error here, unlike `lookupRange`, which returns empty.
   * @param maxResults - Cap on returned offsets, 1 to 4096.
   * @returns The matching record offsets, in numeric key order.
   * @throws {Error} If the addon has no `scan_range`, or the bounds are not
   *   integers or are inverted.
   * @throws {RangeError} If `maxResults` is outside 1..4096.
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

  /**
   * Counts entries under this index prefix (cardinality).
   *
   * This is a bounded count, not a true one: past `maxResults` it reports
   * the cap and there is no way to tell a full index from a larger one.
   *
   * @param maxResults - Cap on the count, 1 to 4096.
   * @returns The number of entries counted, up to the cap.
   * @throws {Error} If the addon has no `scan_prefix`.
   * @throws {RangeError} If `maxResults` is outside 1..4096.
   */
  public cardinality(maxResults = 4096): number {
    const scan = this.bindings.scan_prefix;
    if (!scan) throw new Error('bridge has no scan_prefix (rebuild the addon)');
    return scan.call(this.bindings, `idx:${this.table}:${this.column}:`, maxResults).length;
  }
}
