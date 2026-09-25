/**
 * ============================================================================
 * File: aggregation.ts
 * Description: Single-pass aggregations over decoded rows.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { Row } from './codec';

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * Computes an aggregation over rows for a numeric column (count ignores column).
 *
 * Single pass, no intermediate array: the previous version built
 * `rows.map(...).filter(...)` (two arrays per call) and then called
 * `Math.min(...vals)` / `Math.max(...vals)`, which Makefan onto the call
 * stack. That is both an allocation and a real hazard: a wide enough column
 * overflows the argument limit and throws a RangeError instead of returning a
 * number. Iterating keeps the result defined for any row count.
 */
export function aggregate(rows: Row[], fn: AggFn, column?: string): number {
  if (fn === 'count') return rows.length;
  if (!column) throw new Error(`${fn} requires a column`);

  let sum = 0;
  let count = 0;
  let min = 0;
  let max = 0;
  let seen = false;

  for (const row of rows) {
    const v = row[column] as unknown;
    if (typeof v !== 'number') continue;
    if (!seen) {
      // Seed on the first numeric value so min/max are correct for
      // all-negative and all-positive columns alike.
      min = v;
      max = v;
      seen = true;
    } else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    sum += v;
    count++;
  }

  if (count === 0) return 0;
  switch (fn) {
    case 'sum':
      return sum;
    case 'avg':
      return sum / count;
    case 'min':
      return min;
    case 'max':
      return max;
  }
}
