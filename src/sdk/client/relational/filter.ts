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

/** A predicate specialised for one `where` clause, ready to run per row. */
export type CompiledWhere = (row: Record<string, unknown>) => boolean;

/** SQL LIKE with `%` as a multi-character wildcard and `_` as one character. */
function likeToRegExp(like: string | number | boolean): RegExp {
  const raw = String(like);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '%') {
      out += '.*';
    } else if (ch === '_') {
      out += '.';
    } else {
      // Escape RegExp metacharacters so a literal '.' in the pattern does not
      // silently become a wildcard.
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Per-column checks, in declaration order. AND semantics. */
function compilePerColumn(where: Where): CompiledWhere {
  const columns: Array<[string, Array<(v: unknown) => boolean>]> = [];

  for (const [col, cond] of Object.entries(where)) {
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
      columns.push([col, [(v) => v === cond]]);
      continue;
    }
    const c = cond as Condition;
    const checks: Array<(v: unknown) => boolean> = [];
    if (c.eq !== undefined) {
      const expected = c.eq;
      checks.push((v) => v === expected);
    }
    if (c.ne !== undefined) {
      const expected = c.ne;
      checks.push((v) => v !== expected);
    }
    // Ordered comparisons only apply to numeric cells, as before.
    if (c.gt !== undefined) {
      const t = c.gt as number;
      checks.push((v) => typeof v === 'number' && v > t);
    }
    if (c.gte !== undefined) {
      const t = c.gte as number;
      checks.push((v) => typeof v === 'number' && v >= t);
    }
    if (c.lt !== undefined) {
      const t = c.lt as number;
      checks.push((v) => typeof v === 'number' && v < t);
    }
    if (c.lte !== undefined) {
      const t = c.lte as number;
      checks.push((v) => typeof v === 'number' && v <= t);
    }
    if (c.in !== undefined) {
      const arr = c.in as readonly unknown[];
      // `Array.includes` is linear and this runs once per row, so build a Set
      // once the membership list is long enough to pay for itself.
      const set = arr.length >= 8 ? new Set<unknown>(arr) : null;
      checks.push((v) => (set ? set.has(v) : arr.includes(v)));
    }
    if (c.like !== undefined) {
      // `like` is declared over the scalar union; an array here would be
      // meaningless, and String() renders it predictably.
      const re = likeToRegExp(c.like as string | number | boolean);
      checks.push((v) => typeof v === 'string' && re.test(v));
    }
    columns.push([col, checks]);
  }

  if (columns.length === 1) {
    const [col, checks] = columns[0];
    return (row) => {
      const v = row[col];
      for (let i = 0; i < checks.length; i++) if (!checks[i](v)) return false;
      return true;
    };
  }

  return (row) => {
    for (let c = 0; c < columns.length; c++) {
      const v = row[columns[c][0]];
      const checks = columns[c][1];
      for (let i = 0; i < checks.length; i++) if (!checks[i](v)) return false;
    }
    return true;
  };
}

/**
 * Cache of compiled clauses, keyed by the `Where` object itself.
 *
 * `Table.scan` hands the same clause to every row, so the clause is compiled
 * once instead of per row. WeakMap, so a clause is collected with it.
 *
 * The clause is snapshotted when compiled: treat a `Where` as immutable for
 * the duration of a query, which is what every caller here does.
 */
const compiled = new WeakMap<Where, CompiledWhere>();

/** Returns the compiled predicate for `where`, compiling it once per object. */
export function compiledWhere(where: Where): CompiledWhere {
  let fn = compiled.get(where);
  if (fn === undefined) {
    fn = compilePerColumn(where);
    compiled.set(where, fn);
  }
  return fn;
}

/**
 * Matches a decoded row against a where clause (AND semantics).
 *
 * Previously this rebuilt the predicate for every row: `Object.entries(where)`
 * allocated an entries array per row, and a `like` predicate compiled a new
 * `RegExp` per row *per predicate*.
 */
export function matchesWhere(row: Record<string, unknown>, where?: Where): boolean {
  if (!where) return true;
  return compiledWhere(where)(row);
}
