/**
 * Catalog persistence as a versioned JSON sidecar file, so table
 * definitions survive a restart even when no engine is mapped.
 *
 * This is the file-based counterpart to `catalog_record.ts`, which stores
 * the same definitions inside the engine and rides its WAL. Co-locate this
 * file with the daemon's data directory and back it up together with
 * `data.takyon` and `data.takyon.snap`; on its own it describes structure
 * without rows.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ColumnDef } from './column';
import { RelationalDatabase } from './database';
import { bootCatalog } from './persist';

/** First key of a catalog document, checked before anything is trusted. */
export const CATALOG_MAGIC = 'takyon-catalog';
/** Document format version. A file with another version is rejected. */
export const CATALOG_VERSION = 1;

/** One table's definition as stored in a catalog file. */
export interface CatalogTableDef {
  /** Table name. */
  readonly name: string;
  /** Column definitions in declaration order. */
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

/**
 * Renders a `bytes` default as JSON. A `Uint8Array` has no JSON form, so
 * it becomes a tagged object; without the tag a round trip would silently
 * turn bytes into the string `"[object Uint8Array]"`.
 */
function encodeDefault(v: ColumnDef['defaultValue']): StoredColumn['defaultValue'] {
  if (v instanceof Uint8Array) {
    return { __bytes_hex: Buffer.from(v).toString('hex') };
  }
  return v;
}

/** Reverses `encodeDefault`, restoring a tagged `bytes` default. */
function decodeDefault(v: StoredColumn['defaultValue']): ColumnDef['defaultValue'] {
  if (v !== null && typeof v === 'object' && '__bytes_hex' in v) {
    return new Uint8Array(Buffer.from(v.__bytes_hex, 'hex'));
  }
  return v;
}

/**
 * Serializes every table definition of a database.
 *
 * Only the schema is captured, never rows: the `false`-valued flags are
 * dropped so a file written from a compact schema is byte-identical to one
 * written from the same schema spelled with explicit falses.
 *
 * @param db - The catalog to read.
 * @returns One definition per table, in `listTables` order.
 */
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

/**
 * Writes the catalog file (creating parent dirs). Overwrites atomically.
 *
 * The write goes to `<filePath>.tmp` and is then renamed, so a crash mid
 * write leaves the previous catalog intact rather than a truncated one.
 * The rename is not fsync-ed: a power loss can still lose the directory
 * entry.
 *
 * @param db - The catalog to serialize.
 * @param filePath - Destination path. Parent directories are created.
 * @throws {Error} If a directory cannot be created or the file cannot be
 *   written or renamed.
 */
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

/**
 * Reads and validates a catalog file (schema revalidated on restore).
 *
 * Validation here covers the envelope only: magic, version, and shape. Each
 * table's columns are revalidated by `RelationalSchema` when
 * `restoreCatalog` recreates the table, so a hand-edited file with a bad
 * column fails at restore rather than at load.
 *
 * @param filePath - The catalog file to read.
 * @returns One definition per table, in file order.
 * @throws {Error} If the file is unreadable, is not JSON, has the wrong
 *   magic or version, has no table array, or holds a malformed table entry.
 */
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

/**
 * Restores missing tables from a catalog file (idempotent).
 *
 * Only absent tables are created. A table already in the database is left
 * exactly as it is, so restoring over a migrated database does not undo the
 * migration, and does not report a conflict.
 *
 * @param db - The catalog to populate.
 * @param filePath - The catalog file to read.
 * @throws {Error} Whatever `loadCatalogDefs` throws, plus anything
 *   `RelationalSchema` throws for a stored definition that no longer
 *   validates.
 */
export function restoreCatalog(db: RelationalDatabase, filePath: string): void {
  bootCatalog(
    db,
    loadCatalogDefs(filePath).map((t) => ({ name: t.name, columns: t.columns })),
  );
}
