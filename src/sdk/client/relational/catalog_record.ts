/**
 * ============================================================================
 * File: catalog_record.ts
 * Description: Fixed `__catalog__` record codec mirroring Zig `persist.zig`.
 *   Layout LE: header 8B (magic u32 0x54434154 + version u16 1 + count u16)
 *   + table 65B (len u8 + name[64]) + per-column 67B (len u8 + name[64] +
 *   type u8 + flags u8). Keys are `__catalog__:<table>` (see `catalogRecordKey()`).
 *   Records ride ART + WAL + snapshots; recovery decodes catalog keys first.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { ColumnDef } from './column';
import { RelationalType } from './types';
import { TakyonBindings } from '../proxy';
import { STRING_BUMP_OFFSET, STRING_DATA_START } from '../layout';

export const CATALOG_REC_MAGIC = 0x54434154;
export const CATALOG_REC_VERSION = 1;
export const CATALOG_PREFIX = '__catalog__:';
export const HEADER_LEN = 8;
export const TABLE_FIELD_LEN = 65;
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

/** Builds the ART key for a table's catalog record. */
export function catalogRecordKey(table: string): string {
  if (!table || table.length > 64) throw new Error('table name must be 1..64 chars');
  return `${CATALOG_PREFIX}${table}`;
}

/** Encoded length for `colCount` columns. */
export function catalogEncodedLen(colCount: number): number {
  return HEADER_LEN + TABLE_FIELD_LEN + colCount * COLUMN_REC_LEN;
}

function flagsOf(c: ColumnDef): number {
  let f = 0;
  if (c.nullable) f |= 0x01;
  if (c.primaryKey) f |= 0x02;
  if (c.unique) f |= 0x04;
  return f;
}

/** Encodes a table descriptor into a fresh Uint8Array. */
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

export interface DecodedCatalogColumn {
  readonly name: string;
  readonly type: RelationalType;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
}

export interface DecodedCatalog {
  readonly table: string;
  readonly columns: DecodedCatalogColumn[];
}

/** Decodes and validates a catalog payload (tamper-evident zero padding). */
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

export interface CatalogRecordArenaOpts {
  readonly bumpOffset?: number;
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

  constructor(
    private readonly bindings: TakyonBindings,
    private readonly memory: ArrayBuffer,
    opts: CatalogRecordArenaOpts = {},
  ) {
    this.bumpOffset = opts.bumpOffset ?? STRING_BUMP_OFFSET;
    this.dataStart = opts.dataStart ?? STRING_DATA_START;
    if (this.bumpOffset + 4 > memory.byteLength || this.dataStart > memory.byteLength) {
      throw new Error('catalog arena geometry exceeds shared memory');
    }
  }

  /** Encodes and publishes a table descriptor. Returns the payload offset. */
  public save(table: string, columns: ColumnDef[]): number {
    const payload = encodeCatalogRecord(table, columns);
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
