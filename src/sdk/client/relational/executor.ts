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
import { parseSelect } from './sql';

/** Executes a SELECT subset string, returning decoded rows. */
export function executeSelect(db: RelationalDatabase, sql: string): Row[] {
  const plan = parseSelect(sql);
  const table = db.table(plan.table);
  const q = new QueryBuilder(table);
  if (plan.whereCol && plan.whereOp) {
    const v = plan.whereVal as string | number;
    switch (plan.whereOp) {
      case '=':
        q.where({ [plan.whereCol]: { eq: v } });
        break;
      case '!=':
        q.where({ [plan.whereCol]: { ne: v } });
        break;
      case '>':
        q.where({ [plan.whereCol]: { gt: v } });
        break;
      case '>=':
        q.where({ [plan.whereCol]: { gte: v } });
        break;
      case '<':
        q.where({ [plan.whereCol]: { lt: v } });
        break;
      case '<=':
        q.where({ [plan.whereCol]: { lte: v } });
        break;
    }
  }
  if (plan.columns !== '*') q.select(plan.columns as string[]);
  if (plan.limit !== undefined) q.limit(plan.limit);
  return q.all();
}
