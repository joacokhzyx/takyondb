/**
 * ============================================================================
 * File: catalog_store.ts
 * Description: Durable catalog persistence (table definitions as versioned
 *   JSON). Rows live in the engine; the catalog file lets DDL survive
 *   restarts: save after migrations, restore (idempotent) on boot.
 *   Co-locate with the daemon --data-dir and back it up together with
 *   data.takyon + data.takyon.snap (see docs/relational/backup.md).
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ColumnDef } from './column';
import { RelationalDatabase } from './database';
import { bootCatalog } from './persist';

export const CATALOG_MAGIC = 'takyon-catalog';
export const CATALOG_VERSION = 1;

export interface CatalogTableDef {
  readonly name: string;
  readonly columns: ColumnDef[];
}

interface StoredColumn {
  readonly name: string;
  readonly type: ColumnDef['type'];
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly defaultValue?: boolean | number | string | { readonly __bytes_hex: string };
}

function encodeDefault(v: ColumnDef['defaultValue']): StoredColumn['defaultValue'] {
  if (v instanceof Uint8Array) {
    return { __bytes_hex: Buffer.from(v).toString('hex') };
  }
  return v;
}

function decodeDefault(v: StoredColumn['defaultValue']): ColumnDef['defaultValue'] {
  if (v !== null && typeof v === 'object' && '__bytes_hex' in v) {
    return new Uint8Array(Buffer.from(v.__bytes_hex, 'hex'));
  }
  return v;
}

/** Serializes every table definition of a database. */
export function snapshotCatalog(db: RelationalDatabase): CatalogTableDef[] {
  return db.listTables().map((name) => {
    const schema = db.table(name).schema;
    return {
      name: schema.tableName,
      columns: schema.columns.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.nullable === true ? { nullable: true as const } : {}),
        ...(c.primaryKey === true ? { primaryKey: true as const } : {}),
        ...(c.unique === true ? { unique: true as const } : {}),
        ...(c.defaultValue !== undefined ? { defaultValue: encodeDefault(c.defaultValue) as ColumnDef['defaultValue'] } : {}),
      })),
    };
  });
}

/** Writes the catalog file (creating parent dirs). Overwrites atomically. */
export function saveCatalog(db: RelationalDatabase, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const doc = {
    magic: CATALOG_MAGIC,
    version: CATALOG_VERSION,
    tables: snapshotCatalog(db),
  };
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

/** Reads and validates a catalog file (schema revalidated on restore). */
export function loadCatalogDefs(filePath: string): CatalogTableDef[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`catalog file not readable: ${filePath}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error(`catalog file is not valid JSON: ${filePath}`);
  }
  if (typeof doc !== 'object' || doc === null) throw new Error('catalog file has no document');
  const { magic, version, tables } = doc as { magic?: unknown; version?: unknown; tables?: unknown };
  if (magic !== CATALOG_MAGIC) throw new Error(`bad catalog magic in ${filePath}`);
  if (version !== CATALOG_VERSION) throw new Error(`unsupported catalog version in ${filePath}`);
  if (!Array.isArray(tables)) throw new Error(`catalog tables missing in ${filePath}`);
  return (tables as { name: unknown; columns: unknown }[]).map((t) => {
    if (typeof t.name !== 'string' || !Array.isArray(t.columns)) {
      throw new Error(`malformed catalog table in ${filePath}`);
    }
    const cols = t.columns as StoredColumn[];
    return {
      name: t.name,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.nullable !== undefined ? { nullable: c.nullable } : {}),
        ...(c.primaryKey !== undefined ? { primaryKey: c.primaryKey } : {}),
        ...(c.unique !== undefined ? { unique: c.unique } : {}),
        ...(c.defaultValue !== undefined ? { defaultValue: decodeDefault(c.defaultValue) } : {}),
      })),
    };
  });
}

/** Restores missing tables from a catalog file (idempotent). */
export function restoreCatalog(db: RelationalDatabase, filePath: string): void {
  bootCatalog(
    db,
    loadCatalogDefs(filePath).map((t) => ({ name: t.name, columns: t.columns })),
  );
}
