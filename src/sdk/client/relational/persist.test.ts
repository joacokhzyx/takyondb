import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { bootCatalog } from './persist';

describe('bootCatalog', () => {
  it('is idempotent', () => {
    const db = new RelationalDatabase();
    const defs = [{ name: 't', columns: [{ name: 'id', type: 'string', primaryKey: true } as const] }];
    bootCatalog(db, defs);
    bootCatalog(db, defs);
    expect(db.listTables()).toEqual(['t']);
  });
});
