/**
 * Runs parsed SQL against a `RelationalDatabase`. Nothing is pushed down to
 * the engine here: a filter is applied per row, and aggregation is the
 * single-pass `aggregation.aggregate`.
 */

import { Row } from './codec';
import { RelationalDatabase } from './database';
import { QueryBuilder } from './query';
import { hashJoin } from './join';
import { matchesWhere, Where } from './filter';
import {
  classifyStatement,
  isCountStar,
  parseCreateTable,
  parseDelete,
  parseInsert,
  parseJoin,
  parseSelect,
  parseUpdate,
} from './sql';

/**
 * Builds a single-condition WHERE from parsed parts (shared by statements).
 *
 * This is the one place the SQL operator glyphs become predicate keys, so
 * an operator the parser accepts but this does not map would drop the
 * condition and turn a filtered statement into a full-table one.
 *
 * @param col - Column name, or undefined for an absent WHERE.
 * @param op - Operator glyph, or undefined for an absent WHERE.
 * @param val - The value to compare against.
 * @returns The clause, or `undefined` when there is no WHERE or the
 *   operator is not one of the six mapped here.
 */
function singleWhere(col: string | undefined, op: string | undefined, val: string | number | undefined): Where | undefined {
  if (!col || !op) return undefined;
  const v = val as string | number;
  switch (op) {
    case '=':
      return { [col]: { eq: v } };
    case '!=':
      return { [col]: { ne: v } };
    case '>':
      return { [col]: { gt: v } };
    case '>=':
      return { [col]: { gte: v } };
    case '<':
      return { [col]: { lt: v } };
    case '<=':
      return { [col]: { lte: v } };
    default:
      return undefined;
  }
}

/**
 * Executes a SELECT subset string, returning decoded rows.
 *
 * @param db - The catalog to read.
 * @param sql - A SELECT statement this parser accepts.
 * @returns The result rows. `COUNT(*)` returns the single-row
 *   `[{ count: n }]` shape rather than a projection of the table.
 * @throws {QueryError} If the statement does not parse.
 * @throws {TableNotFoundError} If the named table does not exist.
 */
export function executeSelect(db: RelationalDatabase, sql: string): Row[] {
  const plan = parseSelect(sql);
  const table = db.table(plan.table);
  const q = new QueryBuilder(table);
  const where = singleWhere(plan.whereCol, plan.whereOp, plan.whereVal);
  if (where) q.where(where);
  if (isCountStar(plan.columns)) {
    return [{ count: q.count() } as Row];
  }
  if (plan.columns !== '*') q.select(plan.columns as string[]);
  if (plan.orderCol) q.orderBy(plan.orderCol, plan.orderDir ?? 'asc');
  if (plan.limit !== undefined) q.limit(plan.limit);
  return q.all();
}

/**
 * Executes a JOIN subset string. Merged rows: right wins on collisions.
 *
 * The merge is a shallow spread, so a column name present in both tables
 * takes the right table's value and the left one is unreachable. The WHERE
 * and the projection therefore see the merged row, not the left row.
 *
 * @param db - The catalog to read.
 * @param sql - A two-table JOIN statement this parser accepts.
 * @returns The merged, filtered, projected rows.
 * @throws {QueryError} If the statement does not parse.
 * @throws {TableNotFoundError} If either named table does not exist.
 */
export function executeJoin(db: RelationalDatabase, sql: string): Row[] {
  const plan = parseJoin(sql);
  const left = db.table(plan.left);
  const right = db.table(plan.right);
  let rows: Row[] = hashJoin(left, right, plan.leftKey, plan.rightKey).map(({ left: l, right: r }) => ({
    ...l,
    ...r,
  }));
  const where = singleWhere(plan.whereCol, plan.whereOp, plan.whereVal);
  if (where) rows = rows.filter((r) => matchesWhere(r as Record<string, unknown>, where));
  if (plan.columns !== '*') {
    const cols = plan.columns as string[];
    rows = rows.map((r) => {
      const o: Row = {};
      for (const c of cols) o[c] = r[c];
      return o;
    });
  }
  if (plan.limit !== undefined) rows = rows.slice(0, plan.limit);
  return rows;
}

/** What one statement did, tagged by statement kind. */
export type SqlResult =
  | { readonly kind: 'select'; readonly rows: Row[] }
  | { readonly kind: 'join'; readonly rows: Row[] }
  | { readonly kind: 'insert'; readonly inserted: number }
  | { readonly kind: 'update'; readonly updated: number }
  | { readonly kind: 'delete'; readonly deleted: number }
  | { readonly kind: 'create'; readonly table: string };

/**
 * Dispatches any supported statement by leading keyword.
 *
 * `select` splits twice: the classifier reports SELECT and JOIN alike, so
 * the JOIN keyword is looked for again here. UPDATE and DELETE then scan
 * for their matched rows and re-apply the write per row, so a statement
 * that matches nothing is not an error and reports 0.
 *
 * @param db - The catalog to read or write.
 * @param sql - Any statement the parser accepts.
 * @returns A tag plus the rows for a read, the affected count for a write,
 *   or the created table name for CREATE TABLE. INSERT always reports 1: a
 *   second row cannot be inserted in one statement, so a failure throws
 *   instead.
 * @throws {QueryError} If the statement does not parse.
 * @throws {TableNotFoundError} If a named table does not exist.
 * @throws {TableExistsError} From CREATE TABLE for a name already in use.
 * @throws {ConstraintError} From an INSERT whose key already exists.
 */
export function executeSql(db: RelationalDatabase, sql: string): SqlResult {
  switch (classifyStatement(sql)) {
    case 'select':
      // Substring match, not a token match: a string literal in the WHERE
      // clause containing "join" would be misread as a JOIN, and the JOIN
      // parser would then reject the statement. That is a loud failure, not
      // a wrong answer.
      if (/\bJOIN\b/i.test(sql)) return { kind: 'join', rows: executeJoin(db, sql) };
      return { kind: 'select', rows: executeSelect(db, sql) };
    case 'create': {
      const plan = parseCreateTable(sql);
      db.createTable(plan.table, plan.columns);
      return { kind: 'create', table: plan.table };
    }
    case 'insert': {
      const plan = parseInsert(sql);
      const table = db.table(plan.table);
      const row: Row = {};
      plan.columns.forEach((c, i) => {
        row[c] = plan.values[i] as Row[keyof Row];
      });
      table.insert(row);
      return { kind: 'insert', inserted: 1 };
    }
    case 'update': {
      const plan = parseUpdate(sql);
      const table = db.table(plan.table);
      const where = singleWhere(plan.whereCol, plan.whereOp, plan.whereVal);
      const pkCol = table.schema.primaryKey;
      let updated = 0;
      // The rows are collected by the scan before any is written. That is
      // what keeps the patch from changing the set the scan walks, and it
      // also means a patch that invalidates the WHERE re-evaluates against
      // stale membership.
      for (const r of table.scan(where)) {
        const patch: Partial<Row> = {};
        for (const s of plan.sets) patch[s.column] = s.value as Row[keyof Row];
        if (table.update((r as Record<string, unknown>)[pkCol], patch)) updated++;
      }
      return { kind: 'update', updated };
    }
    case 'delete': {
      const plan = parseDelete(sql);
      const table = db.table(plan.table);
      const where = singleWhere(plan.whereCol, plan.whereOp, plan.whereVal);
      const pkCol = table.schema.primaryKey;
      let deleted = 0;
      // `scan` returns copies, so deleting while walking the result cannot
      // disturb the iteration the way it would over the live row map.
      for (const r of table.scan(where)) {
        if (table.delete((r as Record<string, unknown>)[pkCol])) deleted++;
      }
      return { kind: 'delete', deleted };
    }
  }
}

/**
 * Dispatches SELECT vs JOIN by detecting the JOIN keyword.
 *
 * The read-only counterpart of `executeSql`, returning rows directly
 * instead of a tagged result. A non-SELECT statement fails in the parser.
 *
 * @param db - The catalog to read.
 * @param sql - A SELECT or JOIN statement.
 * @returns The result rows.
 * @throws {QueryError} If the statement does not parse.
 * @throws {TableNotFoundError} If a named table does not exist.
 */
export function executeQuery(db: RelationalDatabase, sql: string): Row[] {
  if (/\bJOIN\b/i.test(sql)) return executeJoin(db, sql);
  return executeSelect(db, sql);
}
