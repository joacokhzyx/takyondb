/**
 * ============================================================================
 * File: sql.ts
 * Description: Minimal SQL subset parser compiling to query builder calls.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { QueryError } from './errors';

export type ParsedSelect = {
  readonly table: string;
  readonly columns: string[] | '*';
  readonly whereCol?: string;
  readonly whereOp?: string;
  readonly whereVal?: string | number;
  readonly limit?: number;
};

/** Parses `SELECT <cols> FROM <tbl> [WHERE <col> <op> <val>] [LIMIT <n>]`. */
export function parseSelect(sql: string): ParsedSelect {
  const m = sql
    .trim()
    .match(
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*(=|!=|>=|<=|>|<)\s*('[^']*'|\d+(?:\.\d+)?))?(?:\s+LIMIT\s+(\d+))?\s*;?$/i,
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
    limit: m[6] ? Number(m[6]) : undefined,
  };
}
