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

/** Computes an aggregation over rows for a numeric column (count ignores column). */
export function aggregate(rows: Row[], fn: AggFn, column?: string): number {
  if (fn === 'count') return rows.length;
  if (!column) throw new Error(`${fn} requires a column`);
  const vals = rows.map((r) => r[column] as number).filter((v) => typeof v === 'number');
  if (vals.length === 0) return 0;
  switch (fn) {
    case 'sum':
      return vals.reduce((a, b) => a + b, 0);
    case 'avg':
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'min':
      return Math.min(...vals);
    case 'max':
      return Math.max(...vals);
  }
}
