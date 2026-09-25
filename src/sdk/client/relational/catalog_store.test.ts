/**
 * ============================================================================
 * File: catalog_store.test.ts
 * Description: Unit tests for durable catalog save/restore round-trips.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import {
  CATALOG_MAGIC,
  CATALOG_VERSION,
  loadCatalogDefs,
  restoreCatalog,
  saveCatalog,
} from './catalog_store';

function dbWithTables() {
  const db = new RelationalDatabase();
  db.createTable('users', [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'age', type: 'uint32', nullable: true },
    { name: 'email', type: 'string', unique: true },
    { name: 'tag', type: 'bytes', defaultValue: new Uint8Array([1, 2, 3]) },
  ]);
  return db;
}

describe('catalog_store', () => {
  it('round-trips definitions incl. bytes defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takyon-cat-'));
    const file = join(dir, 'sub', 'catalog.json');
    const db = dbWithTables();
    saveCatalog(db, file);
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    expect(raw.magic).toBe(CATALOG_MAGIC);
    expect(raw.version).toBe(CATALOG_VERSION);

    const fresh = new RelationalDatabase();
    restoreCatalog(fresh, file);
    expect(fresh.listTables()).toEqual(['users']);
    const cols = fresh.table('users').schema.byName;
    expect(cols.get('email')!.unique).toBe(true);
    expect(cols.get('age')!.nullable).toBe(true);
    expect(Array.from(cols.get('tag')!.defaultValue as Uint8Array)).toEqual([1, 2, 3]);
    // Idempotent: restoring twice does not duplicate or throw.
    restoreCatalog(fresh, file);
    expect(fresh.listTables()).toEqual(['users']);
  });
  it('rejects bad magic, version, and JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takyon-cat-'));
    const badMagic = join(dir, 'm.json');
    writeFileSync(badMagic, JSON.stringify({ magic: 'nope', version: 1, tables: [] }));
    expect(() => loadCatalogDefs(badMagic)).toThrow();
    const badVer = join(dir, 'v.json');
    writeFileSync(badVer, JSON.stringify({ magic: CATALOG_MAGIC, version: 999, tables: [] }));
    expect(() => loadCatalogDefs(badVer)).toThrow();
    const badJson = join(dir, 'j.json');
    writeFileSync(badJson, '{oops');
    expect(() => loadCatalogDefs(badJson)).toThrow();
    expect(() => loadCatalogDefs(join(dir, 'missing.json'))).toThrow();
  });
  it('revalidates schemas on restore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takyon-cat-'));
    const file = join(dir, 'evil.json');
    writeFileSync(
      file,
      JSON.stringify({ magic: CATALOG_MAGIC, version: CATALOG_VERSION, tables: [{ name: 't', columns: [] }] }),
    );
    expect(() => restoreCatalog(new RelationalDatabase(), file)).toThrow();
  });
});
