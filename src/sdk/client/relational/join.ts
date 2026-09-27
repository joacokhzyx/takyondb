/** Inner hash join between two tables, keyed on one column each. */

import { Row } from './codec';
import { RelationalTable } from './table';

/** One matched pair. The two rows are the objects `scan` handed out. */
export interface JoinRow {
  /** The row from the left table. */
  readonly left: Row;
  /** The row from the right table. */
  readonly right: Row;
}

/**
 * Inner hash join on one column from each table.
 *
 * The whole left table is scanned and hashed first, so the result is as
 * large as the product of the matching groups. Keys are compared as
 * `String(value)`, so `1` joins with `'1'`.
 *
 * @param left - The build-side table. Its rows are held until the probe
 *   side is done.
 * @param right - The probe-side table.
 * @param leftKey - Column to join on in `left`.
 * @param rightKey - Column to join on in `right`.
 * @returns Every matching pair, left rows in scan order. Empty when either
 *   side has no match.
 * @throws {Error} If either table is undefined at the call site; a missing
 *   key column simply yields `undefined` on both sides and joins.
 */
export function hashJoin(
  left: RelationalTable,
  right: RelationalTable,
  leftKey: string,
  rightKey: string,
): JoinRow[] {
  const build = new Map<string, Row[]>();
  for (const r of left.scan()) {
    const k = String(r[leftKey]);
    const arr = build.get(k) ?? [];
    arr.push(r);
    build.set(k, arr);
  }
  const out: JoinRow[] = [];
  for (const rr of right.scan()) {
    const k = String(rr[rightKey]);
    const matches = build.get(k);
    if (matches) for (const ll of matches) out.push({ left: ll, right: rr });
  }
  return out;
}
