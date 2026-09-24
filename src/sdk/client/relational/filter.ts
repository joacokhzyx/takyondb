/**
 * ============================================================================
 * File: filter.ts
 * Description: Predicate model and zero-alloc matching for scans.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

export type CmpOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'like';

export type Condition = {
  readonly [op in CmpOp]?: string | number | boolean | readonly (string | number | boolean)[];
};

export type Where = Record<string, Condition | string | number | boolean>;

/** Matches a decoded row against a where clause (AND semantics). */
export function matchesWhere(row: Record<string, unknown>, where?: Where): boolean {
  if (!where) return true;
  for (const [col, cond] of Object.entries(where)) {
    const v = row[col];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Condition;
      if (c.eq !== undefined && v !== c.eq) return false;
      if (c.ne !== undefined && v === c.ne) return false;
      if (typeof v === 'number') {
        if (c.gt !== undefined && !(v > (c.gt as number))) return false;
        if (c.gte !== undefined && !(v >= (c.gte as number))) return false;
        if (c.lt !== undefined && !(v < (c.lt as number))) return false;
        if (c.lte !== undefined && !(v <= (c.lte as number))) return false;
      }
      if (c.in !== undefined) {
        const arr = c.in as readonly unknown[];
        if (!arr.includes(v)) return false;
      }
      if (c.like !== undefined && typeof v === 'string') {
        const pattern = String(c.like).replace(/%/g, '.*');
        if (!new RegExp(`^${pattern}$`).test(v)) return false;
      }
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}
