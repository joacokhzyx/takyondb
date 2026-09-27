/**
 * The ART key namespace. Every kind of engine key is a prefixed string, so
 * a table, its catalog record, and its secondary indexes can share one
 * index without colliding.
 */

/**
 * Renders a primary key value as the string used in an ART key suffix.
 *
 * Keys are byte strings, so every key type needs one rendering. That makes
 * the rendering part of the key's identity: `1` and `'1'` are the same key.
 *
 * @param value - A string, number, boolean, or `Uint8Array` key.
 * @returns The key suffix. `Uint8Array` becomes lowercase hex.
 * @throws {Error} For any other type, including null and undefined. A
 *   nullable primary key is not representable.
 */
export function encodePk(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  throw new Error(`unsupported PK value type: ${typeof value}`);
}

/**
 * Builds the ART key holding a table row's record offset.
 *
 * @param table - Table name.
 * @param pk - The key suffix from `encodePk`.
 * @returns `tbl:<table>:<pk>`.
 */
export function pkKey(table: string, pk: string): string {
  return `tbl:${table}:${pk}`;
}

/**
 * Builds the ART key holding a table's catalog descriptor.
 *
 * Prefixed with `__catalog__` rather than `tbl` so a scan for a table named
 * `__catalog__` cannot pick up descriptors. `catalog_record.ts` builds the
 * same key through `catalogRecordKey`; use that one for descriptor payloads.
 *
 * @param table - Table name.
 * @returns `__catalog__:<table>`.
 */
export function catalogKey(table: string): string {
  return `__catalog__:${table}`;
}

/**
 * Builds the prefix covering every entry of one secondary index, for a
 * prefix scan over the whole index.
 *
 * @param table - Table name.
 * @param column - Indexed column name.
 * @returns `idx:<table>:<column>:`.
 */
export function secondaryPrefix(table: string, column: string): string {
  return `idx:${table}:${column}:`;
}

/**
 * Builds the ART key for one secondary entry.
 *
 * Unlike `secondary_native.ts` `entryKey`, this omits the primary key, so
 * two rows sharing a value collide on one key. It suits an index that
 * stores a value only; use the native index for anything keyed by row.
 *
 * @param table - Table name.
 * @param column - Indexed column name.
 * @param value - The indexed value, already encoded.
 * @returns `idx:<table>:<column>:<value>`.
 */
export function secondaryKey(table: string, column: string, value: string): string {
  return `idx:${table}:${column}:${value}`;
}
