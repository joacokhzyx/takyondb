/**
 * ============================================================================
 * File: executor.ts
 * Description: Executes parsed SELECT plans against the catalog.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
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

/** Builds a single-condition WHERE from parsed parts (shared by statements). */
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

/** Executes a SELECT subset string, returning decoded rows. */
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

/** Executes a JOIN subset string. Merged rows: right wins on collisions. */
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

export type SqlResult =
  | { readonly kind: 'select'; readonly rows: Row[] }
  | { readonly kind: 'join'; readonly rows: Row[] }
  | { readonly kind: 'insert'; readonly inserted: number }
  | { readonly kind: 'update'; readonly updated: number }
  | { readonly kind: 'delete'; readonly deleted: number }
  | { readonly kind: 'create'; readonly table: string };

/** Dispatches any supported statement by leading keyword. */
export function executeSql(db: RelationalDatabase, sql: string): SqlResult {
  switch (classifyStatement(sql)) {
    case 'select':
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
      for (const r of table.scan(where)) {
        if (table.delete((r as Record<string, unknown>)[pkCol])) deleted++;
      }
      return { kind: 'delete', deleted };
    }
  }
}

/** Dispatches SELECT vs JOIN by detecting the JOIN keyword. */
export function executeQuery(db: RelationalDatabase, sql: string): Row[] {
  if (/\bJOIN\b/i.test(sql)) return executeJoin(db, sql);
  return executeSelect(db, sql);
}
