/**
 * ============================================================================
 * File: sql.ts
 * Description: Minimal SQL subset parser compiling to query builder calls.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { QueryError } from './errors';
import { ColumnDef } from './column';
import { RelationalType } from './types';

export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'create';

/** Classifies the leading keyword (case-insensitive). */
export function classifyStatement(sql: string): StatementKind {
  const head = sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
  switch (head) {
    case 'SELECT':
      return 'select';
    case 'INSERT':
      return 'insert';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
      return 'delete';
    case 'CREATE':
      return 'create';
    default:
      throw new QueryError(`unsupported statement: ${sql.slice(0, 32)}`);
  }
}

export type ParsedSelect = {
  readonly table: string;
  readonly columns: string[] | '*';
  readonly whereCol?: string;
  readonly whereOp?: string;
  readonly whereVal?: string | number;
  readonly orderCol?: string;
  readonly orderDir?: 'asc' | 'desc';
  readonly limit?: number;
};

/** Parses `SELECT <cols> FROM <tbl> [WHERE <col> <op> <val>] [ORDER BY <col> [ASC|DESC]] [LIMIT <n>]`. */
export function parseSelect(sql: string): ParsedSelect {
  const m = sql
    .trim()
    .match(
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?\s*;?$/i,
    );
  if (!m) throw new QueryError(`unsupported SELECT: ${sql}`);
  const colsRaw = m[1].trim();
  const columns = colsRaw === '*' ? ('*' as const) : colsRaw.split(',').map((s) => s.trim());
  let whereVal: string | number | undefined;
  if (m[5] !== undefined) {
    const raw = m[5];
    whereVal = raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
  }
  return {
    table: m[2],
    columns,
    whereCol: m[3],
    whereOp: m[4] ? m[4] : undefined,
    whereVal,
    orderCol: m[6],
    orderDir: m[7] ? (m[7].toLowerCase() as 'asc' | 'desc') : m[6] ? 'asc' : undefined,
    limit: m[8] ? Number(m[8]) : undefined,
  };
}

/** True for `SELECT COUNT(*) FROM ...` aggregation queries. */
export function isCountStar(columns: string[] | '*'): boolean {
  return Array.isArray(columns) && columns.length === 1 && columns[0].toUpperCase() === 'COUNT(*)';
}

export type SqlValue = string | number | boolean | null;

/** Splits a comma list respecting single quotes (`''` = escaped quote). */
function splitList(raw: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'") {
      if (inStr && raw[i + 1] === "'") {
        cur += "''";
        i++;
      } else {
        inStr = !inStr;
        cur += ch;
      }
    } else if (ch === ',' && !inStr) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (inStr) throw new QueryError(`unterminated string in: ${raw}`);
  parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

/** Parses one literal: `'str'` (''-escaped), number, TRUE/FALSE/NULL. */
export function parseLiteral(raw: string): SqlValue {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  const up = t.toUpperCase();
  if (up === 'NULL') return null;
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  throw new QueryError(`bad literal: ${raw}`);
}

export type ParsedInsert = {
  readonly table: string;
  readonly columns: string[];
  readonly values: SqlValue[];
};

/** Parses `INSERT INTO <tbl> (<cols>) VALUES (<vals>)`. */
export function parseInsert(sql: string): ParsedInsert {
  const m = sql.trim().match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)\s*;?$/i);
  if (!m) throw new QueryError(`unsupported INSERT: ${sql}`);
  const columns = splitList(m[2]).map((s) => s.trim());
  const values = splitList(m[3]).map(parseLiteral);
  if (columns.length === 0 || columns.length !== values.length) {
    throw new QueryError(`column/value count mismatch in: ${sql}`);
  }
  return { table: m[1], columns, values };
}

export type ParsedUpdate = {
  readonly table: string;
  readonly sets: { readonly column: string; readonly value: SqlValue }[];
  readonly whereCol: string;
  readonly whereOp: string;
  readonly whereVal: string | number;
};

/** Parses `UPDATE <tbl> SET <col> = <val>[, ...] WHERE <col> <op> <val>`. WHERE is required. */
export function parseUpdate(sql: string): ParsedUpdate {
  const m = sql.trim().match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?)\s*;?$/i);
  if (!m) throw new QueryError(`unsupported UPDATE (WHERE is required): ${sql}`);
  const sets = splitList(m[2]).map((assign) => {
    const parts = assign.split('=');
    if (parts.length !== 2) throw new QueryError(`bad SET assignment: ${assign}`);
    return { column: parts[0].trim(), value: parseLiteral(parts[1]) };
  });
  if (sets.length === 0) throw new QueryError(`empty SET in: ${sql}`);
  const wv = m[5].startsWith("'") ? m[5].slice(1, -1).replace(/''/g, "'") : Number(m[5]);
  return { table: m[1], sets, whereCol: m[3], whereOp: m[4], whereVal: wv };
}

export type ParsedDelete = {
  readonly table: string;
  readonly whereCol: string;
  readonly whereOp: string;
  readonly whereVal: string | number;
};

/** Parses `DELETE FROM <tbl> WHERE <col> <op> <val>`. WHERE is required. */
export function parseDelete(sql: string): ParsedDelete {
  const m = sql.trim().match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?)\s*;?$/i);
  if (!m) throw new QueryError(`unsupported DELETE (WHERE is required): ${sql}`);
  const wv = m[4].startsWith("'") ? m[4].slice(1, -1).replace(/''/g, "'") : Number(m[4]);
  return { table: m[1], whereCol: m[2], whereOp: m[3], whereVal: wv };
}

const COLUMN_TYPES: Record<string, RelationalType> = {
  BOOL: 'bool',
  INT8: 'int8',
  INT16: 'int16',
  INT32: 'int32',
  INT64: 'int64',
  UINT8: 'uint8',
  UINT16: 'uint16',
  UINT32: 'uint32',
  FLOAT32: 'float32',
  FLOAT64: 'float64',
  STRING: 'string',
  BYTES: 'bytes',
  TIMESTAMP_MS: 'timestamp_ms',
};

export type ParsedCreate = {
  readonly table: string;
  readonly columns: ColumnDef[];
};

/** Parses `CREATE TABLE <tbl> (<col> <TYPE> [PRIMARY KEY] [NOT NULL] [UNIQUE], ...)`. */
export function parseCreateTable(sql: string): ParsedCreate {
  const m = sql.trim().match(/^CREATE\s+TABLE\s+(\w+)\s*\(([^)]+)\)\s*;?$/i);
  if (!m) throw new QueryError(`unsupported CREATE TABLE: ${sql}`);
  const columns = splitList(m[2]).map((def): ColumnDef => {
    const parts = def.trim().split(/\s+/);
    if (parts.length < 2) throw new QueryError(`bad column def: ${def}`);
    const type = COLUMN_TYPES[parts[1].toUpperCase()];
    if (!type) throw new QueryError(`unknown column type in: ${def}`);
    const rest = parts.slice(2).join(' ').toUpperCase();
    const primaryKey = /\bPRIMARY\s+KEY\b/.test(rest);
    const unique = /\bUNIQUE\b/.test(rest) || primaryKey;
    const nullable = !primaryKey && !/\bNOT\s+NULL\b/.test(rest);
    return { name: parts[0], type, nullable, primaryKey, unique };
  });
  if (columns.length === 0) throw new QueryError(`no columns in: ${sql}`);
  return { table: m[1], columns };
}

export type ParsedJoin = {
  readonly columns: string[] | '*';
  readonly left: string;
  readonly right: string;
  readonly leftKey: string;
  readonly rightKey: string;
  readonly whereCol?: string;
  readonly whereOp?: string;
  readonly whereVal?: string | number;
  readonly limit?: number;
};

/** Parses `SELECT <cols|*> FROM <a> JOIN <b> ON <a>.<x> = <b>.<y> [WHERE ...] [LIMIT <n>]`. */
export function parseJoin(sql: string): ParsedJoin {
  const m = sql
    .trim()
    .match(
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)\s+JOIN\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)(?:\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?))?(?:\s+LIMIT\s+(\d+))?\s*;?$/i,
    );
  if (!m) throw new QueryError(`unsupported JOIN: ${sql}`);
  const colsRaw = m[1].trim();
  const columns = colsRaw === '*' ? ('*' as const) : colsRaw.split(',').map((s) => s.trim());
  if (m[4].toLowerCase() !== m[2].toLowerCase() || m[6].toLowerCase() !== m[3].toLowerCase()) {
    throw new QueryError(`JOIN tables mismatch in: ${sql}`);
  }
  let whereVal: string | number | undefined;
  if (m[10] !== undefined) {
    whereVal = m[10].startsWith("'") ? m[10].slice(1, -1) : Number(m[10]);
  }
  return {
    columns,
    left: m[2],
    right: m[3],
    leftKey: m[5],
    rightKey: m[7],
    whereCol: m[8],
    whereOp: m[9] ? m[9] : undefined,
    whereVal,
    limit: m[11] ? Number(m[11]) : undefined,
  };
}
