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
