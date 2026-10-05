/**
 * Publishes relational primary keys into the engine ART index under the
 * `tbl:<table>:<pk>` namespace, so a relational point lookup reuses the
 * lock-free index, the WAL, and snapshot recovery instead of a parallel
 * in-memory map.
 *
 * Offsets must be real SharedArena record offsets, for example from
 * `TakyonDB.allocateRecordOffset`. The mirror never invents one: a key
 * pointing at an offset nobody allocated is a silent corrupt read.
 */

import { TakyonBindings, BackpressureError } from '../proxy';
import { RelationalTable } from './table';
import { encodePk, pkKey } from './utils';

/**
 * Reads and writes one table's primary keys in the shared ART index.
 *
 * One instance per bindings object, reusable across tables: the table name
 * is an argument to every method, not constructor state.
 */
export class ArtMirror {
  /**
   * @param bindings - The native engine surface. Held by reference, so the
   *   mirror sees the same segment as the client that created it.
   */
  constructor(private readonly bindings: TakyonBindings) {}

  /**
   * Publishes a PK -> record offset mapping. Throws on bridge errors.
   *
   * Like every ART write, this is only durable when a daemon owns the data
   * directory. Without one, the binding lives in shared memory and nothing
   * else, so it is lost on restart with no error reported. See
   * `TakyonBindings.insert_index`.
   *
   * @param table - Table name, forming the key namespace.
   * @param pkValue - The primary key, rendered by `encodePk`.
   * @param recordOffset - Absolute SharedArena record offset.
   * @throws {Error} If `recordOffset` is not a non-negative integer.
   * @throws {RangeError} If the key is empty, over 256 bytes, or contains a
   *   NUL.
   * @throws {BackpressureError} If the ring stayed full for the whole wait
   *   (`-2`): the binding is in shared memory but not in the log.
   * @throws {Error} If `insert_index` returns nonzero for another reason.
   */
  public mirrorPk(table: string, pkValue: unknown, recordOffset: number): void {
    if (!Number.isInteger(recordOffset) || recordOffset < 0) {
      throw new Error(`record offset must be a non-negative integer, got ${recordOffset}`);
    }
    const rc = this.bindings.insert_index(pkKey(table, encodePk(pkValue)), recordOffset);
    if (rc === -2) {
        // The binding did not reach the log. Typed rather than generic so a
        // caller can tell "slow down and retry" from "this key is invalid",
        // which a single Error class cannot express.
        throw new BackpressureError(
            `mirrorPk('${table}', ${String(pkValue)}): the log ring stayed full, so this index ` +
                'binding is in shared memory but not in the log.'
        );
    }
    if (rc !== 0) throw new Error(`insert_index failed for PK '${String(pkValue)}'`);
  }

  /**
   * Resolves a PK to its arena offset, or null when absent.
   *
   * @param table - Table name, forming the key namespace.
   * @param pkValue - The primary key, rendered by `encodePk`.
   * @returns The record offset, or `null` when the key is not in the index.
   *   `search_index` also answers -1 for a bad key length and for a stored
   *   offset at or above the reserved `0x7FFFFFFF`.
   * @throws {RangeError} If the key is empty, over 256 bytes, or contains a
   *   NUL.
   * @throws {Error} If `pkValue` is not a renderable key type.
   */
  public lookupPk(table: string, pkValue: unknown): number | null {
    const off = this.bindings.search_index(pkKey(table, encodePk(pkValue)));
    return off < 0 ? null : off;
  }

  /**
   * Removes a PK mapping. Returns true iff the key was present.
   *
   * The record bytes are not freed; the arena is bump-allocated.
   *
   * @param table - Table name, forming the key namespace.
   * @param pkValue - The primary key, rendered by `encodePk`.
   * @returns True when the key was present and deleted, false when it was
   *   not.
   * @throws {RangeError} If the key is empty, over 256 bytes, or contains a
   *   NUL.
   * @throws {Error} If `remove_index` returns -1.
   * @throws {Error} If `pkValue` is not a renderable key type.
   */
  public unmirrorPk(table: string, pkValue: unknown): boolean {
    const rc = this.bindings.remove_index(pkKey(table, encodePk(pkValue)));
    if (rc === 1) return true;
    if (rc === 0) return false;
    throw new Error(`remove_index failed for PK '${String(pkValue)}'`);
  }

  /**
   * Mirrors every row of a table using caller-supplied offsets.
   *
   * This is the bulk load path: it is not atomic, so a concurrent
   * `lookupPk` can see a partially mirrored table.
   *
   * @param table - The table whose rows should be published.
   * @param offsetOf - Maps a primary key, already rendered by `String`, to
   *   its record offset. It is called once per row, so it should be a
   *   lookup rather than an allocation.
   * @throws {Error} If any offset is not a non-negative integer, or any
   *   `insert_index` fails.
   */
  public syncTable(table: RelationalTable, offsetOf: (pk: string) => number): void {
    for (const row of table.scan()) {
      const pk = String((row as Record<string, unknown>)[table.schema.primaryKey]);
      this.mirrorPk(table.name, pk, offsetOf(pk));
    }
  }

  /**
   * Lists arena offsets of every PK under a table prefix using the native
   * `scan_prefix` (single roundtrip, no per-key `search_index` calls).
   * Requires a bridge built with `scan_prefix`; throws otherwise.
   *
   * @param table - Table name, forming the scanned prefix.
   * @param maxResults - Cap on returned offsets, 1 to 4096. Truncation is
   *   silent: a wider table yields a short list with no error.
   * @returns The offsets in key order, so sorted by primary key.
   * @throws {Error} If the addon has no `scan_prefix`.
   * @throws {RangeError} If `maxResults` is outside 1..4096.
   * @throws {Error} If the engine is not attached.
   */
  public scanTable(table: string, maxResults = 1024): number[] {
    const fn = this.bindings.scan_prefix;
    if (!fn) throw new Error('bridge has no scan_prefix (rebuild the addon)');
    const out = fn.call(this.bindings, `tbl:${table}:`, maxResults);
    return Array.from(out);
  }

  /**
   * Lists arena offsets of PKs whose string form lies within [`lo`, `hi`]
   * using the native `scan_range` (single roundtrip with Zig-side bound
   * checks and hi pruning). Empty bounds are unbounded.
   * Requires a bridge built with `scan_range`; throws otherwise.
   *
   * @param table - Table name, forming the scanned prefix.
   * @param lo - Inclusive lower bound on the key suffix, or `''` for
   *   unbounded below.
   * @param hi - Exclusive upper bound on the key suffix, or `''` for
   *   unbounded above. Inverted bounds return empty rather than raising.
   * @param maxResults - Cap on returned offsets, 1 to 4096.
   * @returns The offsets in key order.
   * @throws {Error} If the addon has no `scan_range`.
   * @throws {RangeError} If `maxResults` is outside 1..4096.
   * @throws {Error} If the engine is not attached.
   */
  public scanRange(table: string, lo = '', hi = '', maxResults = 1024): number[] {
    const fn = this.bindings.scan_range;
    if (!fn) throw new Error('bridge has no scan_range (rebuild the addon)');
    const out = fn.call(this.bindings, `tbl:${table}:`, lo, hi, maxResults);
    return Array.from(out);
  }
}
