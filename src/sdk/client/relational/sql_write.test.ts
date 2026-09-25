/**
 * ============================================================================
 * File: sql_write.test.ts
 * Description: Unit tests for DML/DDL parsing and execution.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { RelationalDatabase } from './database';
import { executeJoin, executeQuery, executeSelect, executeSql } from './executor';
import {
  classifyStatement,
  parseCreateTable,
  parseDelete,
  parseInsert,
  parseJoin,
  parseLiteral,
  parseSelect,
  parseUpdate,
} from './sql';

describe('write statement parsing', () => {
  it('classifies statements', () => {
    expect(classifyStatement('SELECT 1')).toBe('select');
    expect(classifyStatement('insert into t values (1)')).toBe('insert');
    expect(classifyStatement('UPDATE t SET a=1 WHERE id=2')).toBe('update');
    expect(classifyStatement('delete from t where id=1')).toBe('delete');
    expect(classifyStatement('CREATE TABLE t (id STRING PRIMARY KEY)')).toBe('create');
    expect(() => classifyStatement('DROP TABLE t')).toThrow();
  });
  it('parses literals incl. escapes, booleans, null', () => {
    expect(parseLiteral("'O''Brien'")).toBe("O'Brien");
    expect(parseLiteral('42')).toBe(42);
    expect(parseLiteral('-3.5')).toBe(-3.5);
    expect(parseLiteral('TRUE')).toBe(true);
    expect(parseLiteral('null')).toBeNull();
    expect(() => parseLiteral('nul l')).toThrow();
  });
  it('parses INSERT with count check', () => {
    const p = parseInsert("INSERT INTO users (id, age) VALUES ('u1', 28)");
    expect(p).toMatchObject({ table: 'users', columns: ['id', 'age'], values: ['u1', 28] });
    expect(() => parseInsert('INSERT INTO t (a, b) VALUES (1)')).toThrow();
  });
  it('requires WHERE on UPDATE/DELETE', () => {
    expect(() => parseUpdate('UPDATE t SET a = 1')).toThrow();
    expect(() => parseDelete('DELETE FROM t')).toThrow();
    expect(parseUpdate("UPDATE t SET a = 1, b = 'x' WHERE id = 2")).toMatchObject({ table: 't' });
  });
  it('parses CREATE TABLE with constraints', () => {
    const p = parseCreateTable('CREATE TABLE users (id STRING PRIMARY KEY, age UINT32 NOT NULL, email STRING UNIQUE)');
    expect(p.table).toBe('users');
    expect(p.columns.find((c) => c.name === 'id')).toMatchObject({ primaryKey: true, unique: true });
    expect(p.columns.find((c) => c.name === 'age')).toMatchObject({ nullable: false });
    expect(() => parseCreateTable('CREATE TABLE t (a XML)')).toThrow();
  });
  it('parses JOIN with table check', () => {
    const p = parseJoin('SELECT * FROM orders JOIN users ON orders.user_id = users.id WHERE age > 20 LIMIT 5');
    expect(p).toMatchObject({ left: 'orders', right: 'users', leftKey: 'user_id', rightKey: 'id', limit: 5 });
    expect(() => parseJoin('SELECT * FROM a JOIN b ON x.id = y.id')).toThrow();
  });
  it('parses ORDER BY', () => {
    expect(parseSelect('SELECT id FROM t ORDER BY age DESC')).toMatchObject({ orderCol: 'age', orderDir: 'desc' });
    expect(parseSelect('SELECT id FROM t ORDER BY age')).toMatchObject({ orderDir: 'asc' });
  });
});

describe('write statement execution', () => {
  it('runs the documented CRUD flow', () => {
    const db = new RelationalDatabase();
    expect(executeSql(db, 'CREATE TABLE users (id STRING PRIMARY KEY, age UINT32, balance FLOAT64)')).toMatchObject({
      kind: 'create',
    });
    expect(executeSql(db, "INSERT INTO users (id, age) VALUES ('u1', 28)")).toMatchObject({ kind: 'insert' });
    expect(executeSelect(db, 'SELECT id, age FROM users WHERE age >= 18')).toHaveLength(1);
    const upd = executeSql(db, 'UPDATE users SET balance = 99.5 WHERE id = \'u1\'');
    expect(upd).toMatchObject({ kind: 'update', updated: 1 });
    expect(db.table('users').findByPk('u1')).toMatchObject({ balance: 99.5 });
    expect(executeSelect(db, 'SELECT COUNT(*) FROM users WHERE age < 30')).toEqual([{ count: 1 }]);
    const del = executeSql(db, "DELETE FROM users WHERE id = 'u1'");
    expect(del).toMatchObject({ kind: 'delete', deleted: 1 });
    expect(db.table('users').count()).toBe(0);
  });
  it('orders and limits', () => {
    const db = new RelationalDatabase();
    db.createTable('t', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'v', type: 'uint32' },
    ]);
    db.table('t').insert({ id: 'a', v: 3 });
    db.table('t').insert({ id: 'b', v: 1 });
    expect(executeSelect(db, 'SELECT id FROM t ORDER BY v DESC LIMIT 1')).toEqual([{ id: 'a' }]);
  });
  it('joins tables', () => {
    const db = new RelationalDatabase();
    db.createTable('users', [{ name: 'id', type: 'string', primaryKey: true }]);
    db.createTable('orders', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'user_id', type: 'string' },
    ]);
    db.table('users').insert({ id: 'u1' });
    db.table('orders').insert({ id: 'o1', user_id: 'u1' });
    const rows = executeJoin(db, 'SELECT * FROM orders JOIN users ON orders.user_id = users.id');
    expect(rows).toHaveLength(1);
    expect(executeQuery(db, 'SELECT * FROM orders JOIN users ON orders.user_id = users.id')).toHaveLength(1);
  });
});
