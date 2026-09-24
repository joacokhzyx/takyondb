/**
 * ============================================================================
 * File: types.ts
 * Description: Extended relational column types reusing zero-copy layout.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

/** Physical types supported by the relational layer (phase 1). */
export type RelationalType =
  | 'bool'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'float32'
  | 'float64'
  | 'string'
  | 'bytes'
  | 'timestamp_ms';

/** Byte size for fixed types; variable types return 8 (fat pointer). */
export function relationalTypeSize(t: RelationalType): number {
  switch (t) {
    case 'bool':
    case 'int8':
    case 'uint8':
      return 1;
    case 'int16':
    case 'uint16':
      return 2;
    case 'int32':
    case 'uint32':
    case 'float32':
      return 4;
    case 'int64':
    case 'float64':
    case 'timestamp_ms':
      return 8;
    case 'string':
    case 'bytes':
      return 8;
    default:
      throw new Error(`unknown relational type '${t}'`);
  }
}

/** True for variable-length types stored via fat pointer in string arena. */
export function isVariableType(t: RelationalType): boolean {
  return t === 'string' || t === 'bytes';
}

/** JS value type for a given relational type. */
export type RelationalValue<T extends RelationalType> = T extends 'bool'
  ? boolean
  : T extends 'string'
    ? string
    : T extends 'bytes'
      ? Uint8Array
      : number;
