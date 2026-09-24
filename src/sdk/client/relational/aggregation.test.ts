/**
 * ============================================================================
 * File: aggregation.test.ts
 * Description: Unit tests for aggregations.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregation';

describe('aggregate', () => {
  it('computes count/sum/avg/min/max', () => {
    const rows = [{ v: 10 }, { v: 20 }];
    expect(aggregate(rows, 'count')).toBe(2);
    expect(aggregate(rows, 'sum', 'v')).toBe(30);
    expect(aggregate(rows, 'avg', 'v')).toBe(15);
    expect(aggregate(rows, 'min', 'v')).toBe(10);
    expect(aggregate(rows, 'max', 'v')).toBe(20);
  });
});
