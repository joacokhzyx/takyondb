/**
 * A fixed-width catalog record codec mirroring Zig `persist.zig`, so a
 * table definition can ride the ART, the WAL, and a snapshot with no
 * sidecar file.
 *
 * The little-endian layout is a header of 8 bytes (magic u32, version u16,
 * column count u16), then a 65-byte table field (length u8 plus 64 bytes
 * of name), then 67 bytes per column (length u8, 64 bytes of name, type
 * u8, flags u8). The field widths are fixed so a record can be read at an
 * offset from the ART value alone; recovery decodes catalog keys before
 * data keys for the same reason.
 */

import { ColumnDef } from './column';
import { RelationalType } from './types';
import { TakyonBindings } from '../proxy';
import { readRegions, stringDataStart } from '../layout';

/** `"TACT"` little-endian, the first four bytes of a catalog record. */
export const CATALOG_REC_MAGIC = 0x54434154;
/** Catalog record format version. A record with another version is rejected. */
export const CATALOG_REC_VERSION = 1;
/** ART key namespace holding catalog descriptors. */
export const CATALOG_PREFIX = '__catalog__:';
/** Bytes of record header: magic, version, column count. */
export const HEADER_LEN = 8;
/** Bytes of the table-name field: length byte plus a 64-byte name. */
export const TABLE_FIELD_LEN = 65;
/**
 * Bytes per column record: a length byte, a 64-byte name, a type byte,
 * and a flags byte.
 */
export const COLUMN_REC_LEN = 67;

const TYPE_TO_BYTE: Record<RelationalType, number> = {
  bool: 0,
  int8: 1,
  int16: 2,
  int32: 3,
  int64: 4,
  uint8: 5,
  uint16: 6,
  uint32: 7,
  float32: 8,
  float64: 9,
  string: 10,
  bytes: 11,
  timestamp_ms: 12,
};

const BYTE_TO_TYPE: RelationalType[] = [
  'bool',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'float32',
  'float64',
  'string',
  'bytes',
  'timestamp_ms',
];

/**
 * Builds the ART key for a table's catalog record.
 *
 * @param table - Table name, 1 to 64 characters.
 * @returns `__catalog__:<table>`.
 * @throws {Error} If the name is empty or longer than 64 characters, the
 *   bound the record's fixed 64-byte name field imposes.
 */
export function catalogRecordKey(table: string): string {
  if (!table || table.length > 64) throw new Error('table name must be 1..64 chars');
  return `${CATALOG_PREFIX}${table}`;
}

/**
 * Encoded length for `colCount` columns.
 *
 * @param colCount - Number of columns, 1 to 32.
 * @returns The exact byte length of the encoded record, so a decoder can
 *   bounds-check before reading any field.
 */
export function catalogEncodedLen(colCount: number): number {
  return HEADER_LEN + TABLE_FIELD_LEN + colCount * COLUMN_REC_LEN;
}

/**
 * Packs a column's three boolean flags into one byte. Bit 3 and above are
 * reserved and must be zero; `decodeCatalogRecord` rejects a record that
 * sets one, so a future flag cannot be silently misread as this version's.
 */
function flagsOf(c: ColumnDef): number {
  let f = 0;
  if (c.nullable) f |= 0x01;
  if (c.primaryKey) f |= 0x02;
  if (c.unique) f |= 0x04;
  return f;
}

/**
 * Encodes a table descriptor into a fresh Uint8Array.
 *
 * Names are truncated to fit only by being rejected: an over-long name
 * throws rather than being cut, because a truncated name would decode as a
 * different, valid column.
 *
 * @param table - Table name, 1 to 64 characters.
 * @param columns - 1 to 32 column definitions.
 * @returns A buffer of exactly `catalogEncodedLen(columns.length)` bytes.
 * @throws {Error} If the table name is empty or over 64 characters, the
 *   column count is outside 1..32, or a column name is empty or over 64
 *   UTF-8 bytes.
 */
export function encodeCatalogRecord(table: string, columns: ColumnDef[]): Uint8Array {
  if (!table || table.length > 64) throw new Error('table name must be 1..64 chars');
  if (columns.length === 0 || columns.length > 32) throw new Error('column count must be 1..32');
  const out = new Uint8Array(catalogEncodedLen(columns.length));
  const view = new DataView(out.buffer);
  view.setUint32(0, CATALOG_REC_MAGIC, true);
  view.setUint16(4, CATALOG_REC_VERSION, true);
  view.setUint16(6, columns.length, true);
  const tbytes = new TextEncoder().encode(table);
  out[8] = tbytes.length;
  out.set(tbytes, 9);
  let off = HEADER_LEN + TABLE_FIELD_LEN;
  for (const c of columns) {
    const nbytes = new TextEncoder().encode(c.name);
    if (nbytes.length === 0 || nbytes.length > 64) throw new Error(`invalid column name '${c.name}'`);
    out[off] = nbytes.length;
    out.set(nbytes, off + 1);
    out[off + 65] = TYPE_TO_BYTE[c.type];
    out[off + 66] = flagsOf(c);
    off += COLUMN_REC_LEN;
  }
  return out;
}

/** One column as read back from a catalog record. */
export interface DecodedCatalogColumn {
  /** Column name, as stored. */
  readonly name: string;
  /** Storage type. */
  readonly type: RelationalType;
  /** Whether the column accepts null. */
  readonly nullable: boolean;
  /** Whether the column is the primary key. */
  readonly primaryKey: boolean;
  /** Whether the column is declared unique. */
  readonly unique: boolean;
}

/** A table descriptor as read back from a catalog record. */
export interface DecodedCatalog {
  /** Table name, as stored. */
  readonly table: string;
  /** Columns in declaration order. */
  readonly columns: DecodedCatalogColumn[];
}

/**
 * Decodes and validates a catalog payload (tamper-evident zero padding).
 *
 * The bytes between a name and the end of its fixed field must be zero.
 * That costs nothing to check and catches a record written by a different
 * version, which would otherwise decode as a shorter name in a longer
 * field and describe a table that never existed.
 *
 * @param buf - The record, exactly `catalogEncodedLen(count)` bytes.
 * @returns The table and its columns.
 * @throws {Error} If the magic, version, or column count is wrong, the
 *   buffer is too short for the count it declares, a name length is 0 or
 *   over 64, name padding is non-zero, the type byte is not a known type,
 *   or a reserved flag bit is set.
 */
export function decodeCatalogRecord(buf: Uint8Array): DecodedCatalog {
  if (buf.length < HEADER_LEN + TABLE_FIELD_LEN) throw new Error('catalog payload too short');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== CATALOG_REC_MAGIC) throw new Error('bad catalog magic');
  if (view.getUint16(4, true) !== CATALOG_REC_VERSION) throw new Error('bad catalog version');
  const count = view.getUint16(6, true);
  if (count === 0 || count > 32) throw new Error('bad catalog column count');
  if (buf.length < catalogEncodedLen(count)) throw new Error('catalog payload truncated');
  const tlen = buf[8]!;
  if (tlen === 0 || tlen > 64) throw new Error('bad catalog table name');
  const table = new TextDecoder().decode(buf.subarray(9, 9 + tlen));
  const columns: DecodedCatalogColumn[] = [];
  let off = HEADER_LEN + TABLE_FIELD_LEN;
  for (let i = 0; i < count; i++) {
    const nlen = buf[off]!;
    if (nlen === 0 || nlen > 64) throw new Error('bad catalog column name');
    for (let j = off + 1 + nlen; j < off + 65; j++) if (buf[j] !== 0) throw new Error('catalog padding corrupt');
    const tbyte = buf[off + 65]!;
    const type = BYTE_TO_TYPE[tbyte];
    if (!type) throw new Error('bad catalog column type');
    const flags = buf[off + 66]!;
    if (flags & 0xf8) throw new Error('bad catalog flags');
    columns.push({
      name: new TextDecoder().decode(buf.subarray(off + 1, off + 1 + nlen)),
      type,
      nullable: (flags & 0x01) !== 0,
      primaryKey: (flags & 0x02) !== 0,
      unique: (flags & 0x04) !== 0,
    });
    off += COLUMN_REC_LEN;
  }
  return { table, columns };
}

/**
 * Where a `CatalogRecordStore` places its payloads inside the arena.
 *
 * The defaults are read from the arena's own header, so a configured arena
 * puts its catalog bytes in its own string region. The overrides exist for
 * tests that need a small buffer; leaving them unset on a real arena is the
 * correct thing to do, because a catalog written to the wrong region is a
 * catalog that recovery will not find.
 */
export interface CatalogRecordArenaOpts {
  /** Byte offset of the string bump word. Defaults to the header's. */
  readonly bumpOffset?: number;
  /** First usable payload byte. Defaults to the header's. */
  readonly dataStart?: number;
}

/**
 * Persists table descriptors as `__catalog__:<table>` ART records whose
 * payloads live in the string arena. Payloads ride WAL + verified snapshots,
 * so DDL survives daemon restarts without the JSON sidecar: recovery reads
 * catalog keys first (two-pass: catalog before data). Re-saving a table
 * overwrites its ART entry in place (idempotent DDL).
 */
export class CatalogRecordStore {
  private readonly bumpOffset: number;
  private readonly dataStart: number;

  /**
   * @param bindings - The native engine surface.
   * @param memory - The mapped arena the payloads live in. Must be the
   *   same mapping the bindings were built against, or `notifyArena` will
   *   announce bytes the daemon never sees.
   * @param opts - Arena geometry overrides; see `CatalogRecordArenaOpts`.
   *   Present so a test can place records in a small buffer.
   * @throws {Error} If the arena geometry does not fit inside `memory`.
   */
  constructor(
    private readonly bindings: TakyonBindings,
    private readonly memory: ArrayBuffer,
    opts: CatalogRecordArenaOpts = {},
  ) {
    if (opts.bumpOffset != null && opts.dataStart != null) {
      this.bumpOffset = opts.bumpOffset as number;
      this.dataStart = opts.dataStart as number;
    } else {
      const regions = readRegions(memory);
      this.bumpOffset = opts.bumpOffset ?? regions.stringStart;
      this.dataStart = opts.dataStart ?? stringDataStart(regions);
    }
    if (this.bumpOffset + 4 > memory.byteLength || this.dataStart > memory.byteLength) {
      throw new Error('catalog arena geometry exceeds shared memory');
    }
  }

  /**
   * Encodes and publishes a table descriptor. Returns the payload offset.
   *
   * Re-saving a table overwrites its ART entry in place, so DDL is
   * idempotent by key. The bytes of the previous descriptor are abandoned
   * in the bump arena, not reclaimed.
   *
   * @param table - Table name, 1 to 64 characters.
   * @param columns - 1 to 32 column definitions.
   * @returns The arena offset the payload was written at.
   * @throws {Error} If the encoding rejects the name or the columns, the
   *   string arena is exhausted, `notifyArena` reports a full ring, or
   *   `insert_index` returns nonzero.
   */
  public save(table: string, columns: ColumnDef[]): number {
    const payload = encodeCatalogRecord(table, columns);
    // Same seed-as-check trick as the string arena in `client/proxy.ts`: a
    // zero bump would hand out offset 0, which is the ring header. A
    // catalog record written there corrupts head, tail, and capacity.
    const bump = new Uint32Array(this.memory, this.bumpOffset, 1);
    Atomics.compareExchange(bump, 0, 0, this.dataStart);
    const at = Atomics.add(bump, 0, payload.length);
    if (at + payload.length > this.memory.byteLength) {
      throw new Error('out of string arena memory for catalog record');
    }
    new Uint8Array(this.memory, at, payload.length).set(payload);
    if (this.bindings.notifyArena(at, payload.length) !== 0) {
      throw new Error('notifyArena failed for catalog record: ring full or arena not mapped');
    }
    if (this.bindings.insert_index(catalogRecordKey(table), at) !== 0) {
      throw new Error(`insert_index failed for catalog record '${table}'`);
    }
    return at;
  }

  /**
   * Loads a table descriptor. Null when absent; throws on truncation,
   * corruption, or key/content mismatch.
   *
   * The key/content check is the one that earns its keep: two tables can be
   * written under one key by a bug or a partial restore, and a descriptor
   * that describes a different table would create the wrong one silently.
   *
   * @param table - Table name whose descriptor to load.
   * @returns The decoded descriptor, or `null` when no such key is in the
   *   index.
   * @throws {RangeError} If the key is empty, over 256 bytes, or contains a
   *   NUL.
   * @throws {Error} If the stored offset is out of range, the record is
   *   truncated, the magic or version is wrong, the payload is corrupt, or
   *   the decoded table name is not the one asked for.
   */
  public load(table: string): DecodedCatalog | null {
    const off = this.bindings.search_index(catalogRecordKey(table));
    if (off < 0) return null;
    if (off + HEADER_LEN > this.memory.byteLength) {
      throw new Error(`catalog record '${table}' offset out of range`);
    }
    const view = new DataView(this.memory);
    if (view.getUint32(off, true) !== CATALOG_REC_MAGIC) throw new Error(`bad catalog magic for '${table}'`);
    if (view.getUint16(off + 4, true) !== CATALOG_REC_VERSION) {
      throw new Error(`bad catalog version for '${table}'`);
    }
    const count = view.getUint16(off + 6, true);
    const total = catalogEncodedLen(count);
    if (off + total > this.memory.byteLength) {
      throw new Error(`catalog record '${table}' truncated`);
    }
    const dec = decodeCatalogRecord(new Uint8Array(this.memory, off, total));
    if (dec.table !== table) throw new Error(`catalog key/content mismatch for '${table}'`);
    return dec;
  }
}
