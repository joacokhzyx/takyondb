/**
 * ============================================================================
 * File: utils.ts
 * Description: Key encoding helpers namespacing ART keys per table/index.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

/** Encodes a PK value to its ART suffix (string form). */
export function encodePk(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  throw new Error(`unsupported PK value type: ${typeof value}`);
}

/** ART key for a primary row: `tbl:<table>:<pk>`. */
export function pkKey(table: string, pk: string): string {
  return `tbl:${table}:${pk}`;
}

/** ART key for catalog entry: `__catalog__:<table>`. */
export function catalogKey(table: string): string {
  return `__catalog__:${table}`;
}

/** ART key prefix for secondary index scans. */
export function secondaryPrefix(table: string, column: string): string {
  return `idx:${table}:${column}:`;
}

/** ART key for a secondary entry. */
export function secondaryKey(table: string, column: string, value: string): string {
  return `idx:${table}:${column}:${value}`;
}
