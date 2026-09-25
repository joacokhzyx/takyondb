/**
 * ============================================================================
 * File: pushdown.test.ts
 * Description: Parity tests for native pushdown kernels with TS fallback.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  pushFilterF64,
  pushFilterU32,
  pushMaxSelected,
  pushMinSelected,
  pushSum,
  pushSumSelected,
} from './pushdown';

describe('pushdown fallback (no native bridge)', () => {
  it('filters u32 across all operators', () => {
    const v = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(pushFilterU32(undefined, v, 'eq', 9))).toEqual([8]);
    expect(pushFilterU32(undefined, v, 'ne', 5).length).toBe(8);
    expect(Array.from(pushFilterU32(undefined, v, 'gt', 7))).toEqual([7, 8]);
    expect(Array.from(pushFilterU32(undefined, v, 'gte', 8))).toEqual([7, 8]);
    expect(Array.from(pushFilterU32(undefined, v, 'lt', 2))).toEqual([0]);
    expect(Array.from(pushFilterU32(undefined, v, 'lte', 2))).toEqual([0, 1]);
  });

  it('filters f64 with NaN semantics', () => {
    const v = Float64Array.from([1.5, 2.5, Number.NaN, 4.5]);
    expect(Array.from(pushFilterF64(undefined, v, 'eq', 2.5))).toEqual([1]);
    expect(pushFilterF64(undefined, v, 'ne', Number.NaN).length).toBe(4);
    expect(pushFilterF64(undefined, v, 'eq', Number.NaN).length).toBe(0);
  });

  it('aggregates match TS semantics incl. empty selection', () => {
    const v = Float64Array.from([10, 20, 30, 40]);
    expect(pushSum(undefined, v)).toBeCloseTo(100, 9);
    expect(pushSum(undefined, new Float64Array(0))).toBe(0);
    const sel = Uint32Array.from([1, 3]);
    expect(pushSumSelected(undefined, v, sel)).toBeCloseTo(60, 9);
    expect(pushMinSelected(undefined, v, sel)).toBe(20);
    expect(pushMaxSelected(undefined, v, sel)).toBe(40);
    const empty = new Uint32Array(0);
    expect(pushSumSelected(undefined, v, empty)).toBe(0);
    expect(pushMinSelected(undefined, v, empty)).toBe(0);
    expect(pushMaxSelected(undefined, v, empty)).toBe(0);
  });

  it('falls back when the native bridge throws', () => {
    const throwing = {
      filter_u32: () => {
        throw new Error('stale addon');
      },
    } as never;
    const v = Uint32Array.from([1, 2, 3]);
    expect(Array.from(pushFilterU32(throwing, v, 'gt', 1))).toEqual([1, 2]);
  });

  it('uses the native bridge when present', () => {
    const native = {
      filter_u32: (values: Uint32Array) => Uint32Array.from([values.length - 1]),
      agg_sum: () => 42,
    } as never;
    const v = Uint32Array.from([5, 6, 7]);
    expect(Array.from(pushFilterU32(native, v, 'eq', 7))).toEqual([2]);
    expect(pushSum(native, Float64Array.from([1, 2]))).toBe(42);
  });
});
