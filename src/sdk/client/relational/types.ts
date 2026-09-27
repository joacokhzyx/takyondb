/**
 * The relational column type set and the JavaScript value each one maps to.
 * Widths here must agree with `catalog_record.ts` `TYPE_TO_BYTE`, which is
 * what the on-disk catalog stores.
 */

/** Column types the catalog codec and the columnar kernels agree on. */
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

/**
 * Returns the byte width a column of this type occupies in a record.
 *
 * Variable-length types occupy 8: a u32 offset plus a u32 length, with the
 * bytes themselves in the string arena.
 *
 * @param t - The column type.
 * @returns The field width in bytes.
 * @throws {Error} If `t` is not a `RelationalType`, which can only happen
 *   from an untyped JavaScript caller.
 */
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

/**
 * Reports whether a type stores its payload outside the record.
 *
 * @param t - The column type.
 * @returns True for `string` and `bytes`, false for every fixed-width type.
 */
export function isVariableType(t: RelationalType): boolean {
  return t === 'string' || t === 'bytes';
}

/**
 * The JavaScript value a decoded cell of this type holds. Widening from the
 * storage type is the caller's problem: an `int8` column yields a `number`
 * that is not narrowed back to its declared range.
 */
export type RelationalValue<T extends RelationalType> = T extends 'bool'
  ? boolean
  : T extends 'string'
    ? string
    : T extends 'bytes'
      ? Uint8Array
      : number;
