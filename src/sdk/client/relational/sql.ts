/**
 * A regex-per-statement SQL subset parser: SELECT, INSERT, UPDATE, DELETE,
 * CREATE TABLE, and a two-table JOIN. Each entry point is a pure function
 * from text to a `Parsed*` record; `executor.ts` runs them.
 */

import { QueryError } from './errors';
import { ColumnDef } from './column';
import { RelationalType } from './types';

/** The five statement forms the parser accepts. */
export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'create';

/**
 * Classifies the leading keyword (case-insensitive).
 *
 * Classification is by first word only, so `SELECT` and a JOIN are the same
 * kind here; `executor.executeSql` separates them by looking for `JOIN`.
 *
 * @param sql - The statement text.
 * @returns Which parser the statement should go to.
 * @throws {QueryError} If the first word is not one of the five keywords.
 */
export function classifyStatement(sql: string): StatementKind {
  // First word only. A JOIN is classified as a select here and separated
  // from a plain select by `executor.executeSql`, so the two paths share a
  // classification instead of adding a sixth kind.
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

/** The parts of a SELECT this subset can express. */
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

/**
 * Parses `SELECT <cols> FROM <tbl> [WHERE <col> <op> <val>]`.
 * `ORDER BY <col> [ASC|DESC]` and `LIMIT <n>` are optional and must
 * appear in that order.
 *
 * The clause order is fixed by the pattern: a WHERE before an ORDER BY, and
 * an ORDER BY before a LIMIT. Reordering them does not parse.
 *
 * @param sql - The statement text, with an optional trailing semicolon.
 * @returns The parsed clauses. Absent clauses are `undefined`, except
 *   `orderDir`, which defaults to `'asc'` whenever `orderCol` is present.
 * @throws {QueryError} If the text does not match, for any reason including
 *   an unsupported clause order or a missing FROM.
 */
export function parseSelect(sql: string): ParsedSelect {
  const m = sql
    .trim()
    .match(
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?\s*;?$/i,
    );
  if (!m) throw new QueryError(`unsupported SELECT: ${sql}`);
  // The projection is a string list, not column names: no identifier check
  // here, so an unknown column surfaces as `undefined` in the projected row
  // rather than as a parse error.
  const colsRaw = m[1].trim();
  const columns = colsRaw === '*' ? ('*' as const) : colsRaw.split(',').map((s) => s.trim());
  // A quoted literal stays a string; anything the numeric branch accepts
  // goes through `Number`, so the caller sees a number, not the text.
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
    // No ORDER BY at all leaves orderDir undefined, so a caller can tell
    // "unsorted" from "sorted ascending".
    orderDir: m[7] ? (m[7].toLowerCase() as 'asc' | 'desc') : m[6] ? 'asc' : undefined,
    limit: m[8] ? Number(m[8]) : undefined,
  };
}

/**
 * Reports whether a projection is the `COUNT(*)` aggregation.
 *
 * The aggregate is recognized textually, so `COUNT(*)` must be the only
 * projected item and is matched case-insensitively without allowing
 * whitespace between the parens.
 *
 * @param columns - The parsed projection list.
 * @returns True for exactly `['COUNT(*)']`, false for `'*'` and for any
 *   other list.
 */
export function isCountStar(columns: string[] | '*'): boolean {
  return Array.isArray(columns) && columns.length === 1 && columns[0].toUpperCase() === 'COUNT(*)';
}

/** A literal value in a SQL statement. */
export type SqlValue = string | number | boolean | null;

/**
 * Splits a comma list respecting single quotes (`''` = escaped quote).
 *
 * Doubled quotes are preserved rather than collapsed, so the caller decides
 * whether to unescape: `parseLiteral` unescapes, the column and type name
 * paths do not.
 *
 * @param raw - The text between the enclosing parentheses.
 * @returns The non-empty, trimmed items.
 * @throws {QueryError} If a quoted string is never closed.
 */
function splitList(raw: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    // A doubled quote inside a string is a literal quote and does not close
    // it; the pair is copied through so `parseLiteral` can unescape it.
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

/**
 * Parses one literal: `'str'` (''-escaped), number, TRUE/FALSE/NULL.
 *
 * @param raw - The literal text, which is trimmed first.
 * @returns The value. `NULL` becomes `null`, so a null literal is
 *   indistinguishable from an absent one in the result.
 * @throws {QueryError} If the text is not one of the four literal forms.
 */
export function parseLiteral(raw: string): SqlValue {
  // Order matters: a quoted string is checked first so that the text `NULL`
  // inside quotes stays the four characters, not the null value.
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

/** The parts of an INSERT this subset can express. */
export type ParsedInsert = {
  readonly table: string;
  readonly columns: string[];
  readonly values: SqlValue[];
};

/**
 * Parses `INSERT INTO <tbl> (<cols>) VALUES (<vals>)`.
 *
 * One row per statement; there is no multi-row `VALUES` and no
 * `INSERT ... SELECT`.
 *
 * @param sql - The statement text, with an optional trailing semicolon.
 * @returns The table, the target columns in order, and the values in the
 *   same order.
 * @throws {QueryError} If the text does not match, if a value is not a
 *   valid literal, or if the column and value counts differ.
 */
export function parseInsert(sql: string): ParsedInsert {
  const m = sql.trim().match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)\s*;?$/i);
  if (!m) throw new QueryError(`unsupported INSERT: ${sql}`);
  // Count equality is the only correspondence check: the Nth value is
  // assigned to the Nth column, so a `VALUES` list in a different order
  // than the column list writes the wrong fields silently.
  const columns = splitList(m[2]).map((s) => s.trim());
  const values = splitList(m[3]).map(parseLiteral);
  if (columns.length === 0 || columns.length !== values.length) {
    throw new QueryError(`column/value count mismatch in: ${sql}`);
  }
  return { table: m[1], columns, values };
}

/** The parts of an UPDATE this subset can express. */
export type ParsedUpdate = {
  readonly table: string;
  readonly sets: { readonly column: string; readonly value: SqlValue }[];
  readonly whereCol: string;
  readonly whereOp: string;
  readonly whereVal: string | number;
};

/**
 * Parses `UPDATE <tbl> SET <col> = <val>[, ...] WHERE <col> <op>
 * <val>`. The WHERE clause is required.
 *
 * The SET list is split on every `=` in the item, so an item with two or
 * more is rejected rather than silently assigning to the wrong column.
 *
 * @param sql - The statement text, with an optional trailing semicolon.
 * @returns The assignments in order, plus the single WHERE condition.
 * @throws {QueryError} If the text does not match, if a SET item does not
 *   split into exactly a name and a value, if the SET list is empty, or if
 *   a value is not a valid literal.
 */
export function parseUpdate(sql: string): ParsedUpdate {
  const m = sql.trim().match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?)\s*;?$/i);
  if (!m) throw new QueryError(`unsupported UPDATE (WHERE is required): ${sql}`);
  // Split on every `=`, not the first: a value containing `=` cannot be
  // written, and an item that splits into more than two parts is rejected
  // here rather than assigning a truncated name.
  const sets = splitList(m[2]).map((assign) => {
    const parts = assign.split('=');
    if (parts.length !== 2) throw new QueryError(`bad SET assignment: ${assign}`);
    return { column: parts[0].trim(), value: parseLiteral(parts[1]) };
  });
  if (sets.length === 0) throw new QueryError(`empty SET in: ${sql}`);
  const wv = m[5].startsWith("'") ? m[5].slice(1, -1).replace(/''/g, "'") : Number(m[5]);
  return { table: m[1], sets, whereCol: m[3], whereOp: m[4], whereVal: wv };
}

/** The parts of a DELETE this subset can express. */
export type ParsedDelete = {
  readonly table: string;
  readonly whereCol: string;
  readonly whereOp: string;
  readonly whereVal: string | number;
};

/**
 * Parses `DELETE FROM <tbl> WHERE <col> <op> <val>`. WHERE is required.
 *
 * An unconditional `DELETE FROM t` is rejected on purpose: there is no TRUNCATE
 * and no guard on a whole-table delete.
 *
 * @param sql - The statement text, with an optional trailing semicolon.
 * @returns The table and the single WHERE condition.
 * @throws {QueryError} If the text does not match, which includes every
 *   form without a WHERE clause.
 */
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

/** The parts of a CREATE TABLE this subset can express. */
export type ParsedCreate = {
  readonly table: string;
  readonly columns: ColumnDef[];
};

/**
 * Parses `CREATE TABLE <tbl> (<col> <TYPE> [PRIMARY KEY] [NOT NULL]
 * [UNIQUE], ...)`. The three flags may appear in any order.
 *
 * There is no ALTER, no DROP, and no constraint beyond these three flags.
 * The flags are read out of the trailing text by pattern, so their order
 * does not matter and an unrecognized word is ignored rather than
 * rejected.
 *
 * @param sql - The statement text, with an optional trailing semicolon.
 * @returns The table name and its columns. A column is `nullable` unless it
 *   is the primary key or declares `NOT NULL`, and `unique` is forced true
 *   for the primary key.
 * @throws {QueryError} If the text does not match, if a column definition
 *   has fewer than two parts, if the type name is not recognized, or if no
 *   columns were given.
 */
export function parseCreateTable(sql: string): ParsedCreate {
  const m = sql.trim().match(/^CREATE\s+TABLE\s+(\w+)\s*\(([^)]+)\)\s*;?$/i);
  if (!m) throw new QueryError(`unsupported CREATE TABLE: ${sql}`);
  const columns = splitList(m[2]).map((def): ColumnDef => {
    const parts = def.trim().split(/\s+/);
    if (parts.length < 2) throw new QueryError(`bad column def: ${def}`);
    const type = COLUMN_TYPES[parts[1].toUpperCase()];
    if (!type) throw new QueryError(`unknown column type in: ${def}`);
    // Trailing words are scanned by pattern, not parsed, so flag order is
    // free and an unknown word is ignored. A primary key is always unique
    // and never nullable, so both are forced rather than read.
    const rest = parts.slice(2).join(' ').toUpperCase();
    const primaryKey = /\bPRIMARY\s+KEY\b/.test(rest);
    const unique = /\bUNIQUE\b/.test(rest) || primaryKey;
    const nullable = !primaryKey && !/\bNOT\s+NULL\b/.test(rest);
    return { name: parts[0], type, nullable, primaryKey, unique };
  });
  if (columns.length === 0) throw new QueryError(`no columns in: ${sql}`);
  return { table: m[1], columns };
}

/** The parts of a two-table JOIN this subset can express. */
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

/**
 * Parses `SELECT <cols|*> FROM <a> JOIN <b> ON <a>.<x> = <b>.<y>`.
 * `WHERE ...` and `LIMIT <n>` are optional and must appear in that
 * order.
 *
 * Exactly two tables, inner join only, and the ON clause must name each
 * side explicitly as `<table>.<column>`.
 *
 * @param sql - The statement text, with an optional trailing semicolon.
 * @returns The projection, both tables and join columns, and the optional
 *   WHERE and LIMIT.
 * @throws {QueryError} If the text does not match, or if an ON qualifier
 *   does not name the table it is attached to.
 */
export function parseJoin(sql: string): ParsedJoin {
  const m = sql
    .trim()
    .match(
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)\s+JOIN\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)(?:\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?))?(?:\s+LIMIT\s+(\d+))?\s*;?$/i,
    );
  if (!m) throw new QueryError(`unsupported JOIN: ${sql}`);
  const colsRaw = m[1].trim();
  const columns = colsRaw === '*' ? ('*' as const) : colsRaw.split(',').map((s) => s.trim());
  // Check the ON qualifiers against the FROM names. The grammar could bind
  // them positionally, but then `b.y = a.x` would silently join the wrong
  // way round, so the text is checked instead.
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
