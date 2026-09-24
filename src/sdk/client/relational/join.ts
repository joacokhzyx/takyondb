/**
 * ============================================================================
 * File: join.ts
 * Description: Hash join over two tables reusing zero-copy decoded rows.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { Row } from './codec';
import { RelationalTable } from './table';

export interface JoinRow {
  readonly left: Row;
  readonly right: Row;
}

/** Inner hash join: left.<leftKey> == right.<rightKey>. */
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
