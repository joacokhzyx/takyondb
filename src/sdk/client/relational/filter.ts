/**
 * The `where` predicate model, compiled once per clause object and then
 * applied per row without re-parsing.
 */

/** The comparison operators a `where` clause may name. */
export type CmpOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'like';

/**
 * The operators available for one column, all AND-ed. Ordered comparisons
 * (`gt`, `gte`, `lt`, `lte`) and `in` only ever match numbers; `like` only
 * ever matches strings.
 */
export type Condition = {
  readonly [op in CmpOp]?: string | number | boolean | readonly (string | number | boolean)[];
};

/**
 * A filter clause: column name to either a `Condition` or a bare value,
 * which is shorthand for `{ eq: value }`. Multiple columns are AND-ed.
 */
export type Where = Record<string, Condition | string | number | boolean>;

/** A predicate specialized for one `where` clause, ready to run per row. */
export type CompiledWhere = (row: Record<string, unknown>) => boolean;

/**
 * Compiles a SQL LIKE pattern to an anchored `RegExp`.
 *
 * Every literal character is escaped, so a `.` in the pattern matches a
 * literal dot rather than becoming a wildcard. Only `%` and `_` are special.
 *
 * @param like - The pattern, rendered with `String` if not already text.
 * @returns An anchored expression over the whole value.
 */
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

/**
 * Turns a clause into a closure, one list of checks per column.
 *
 * A single-column clause gets its own closure shape so the hot scan path
 * does not index into a two-level array per row.
 *
 * @param where - The clause. Snapshotted here, so the caller must not
 *   mutate it afterwards.
 * @returns A predicate that AND-s every column's checks.
 */
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
    // Ordered comparisons only apply to numeric cells, as before. A
    // string or boolean cell fails the typeof test and is excluded rather
    // than compared by coercion, which would order booleans as 0 and 1.
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
      // once the membership list is long enough to pay for itself. The
      // threshold is not pinned by a test, so treat it as a tunable: an
      // `in` list longer than this stops being O(rows * list) per row.
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
 * the duration of a query, which is what every caller here does. Mutating
 * one after first use is not detected; the cached predicate keeps
 * comparing against the values as they were.
 */
const compiled = new WeakMap<Where, CompiledWhere>();

/**
 * Returns the compiled predicate for a clause, compiling it once per object.
 *
 * Identity is the cache key, not structural equality, so two equivalent
 * clause literals compile separately.
 *
 * @param where - The clause. Must not be mutated after this call.
 * @returns The predicate to apply per row.
 */
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
 *
 * A column absent from the row is tested against `undefined`, so an `eq`
 * clause for it fails and a `ne` clause for it passes.
 *
 * @param row - The row to test.
 * @param where - The clause, or omitted to match every row.
 * @returns True when every column's checks pass.
 */
export function matchesWhere(row: Record<string, unknown>, where?: Where): boolean {
  if (!where) return true;
  return compiledWhere(where)(row);
}
