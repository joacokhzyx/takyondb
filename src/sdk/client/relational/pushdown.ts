/**
 * ============================================================================
 * File: pushdown.ts
 * Description: Predicate pushdown and vectorized aggregation with native
 *   kernels plus pure-TS fallback. Single-numeric-condition filters use
 *   `filter_u32`/`filter_f64` (SIMD in Zig); aggregations over selections
 *   use Kahan `agg_sum_selected`/`agg_min/max_selected`. Without a native
 *   bridge every path falls back to identical TS semantics (NaN never Eq,
 *   always Ne; empty agg is 0).
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { TakyonBindings } from '../proxy';
import { Row } from './codec';

/** CmpOp encoding shared with Zig `filter.zig` (0=Eq..5=Lte). */
export const PUSH_OP = { eq: 0, ne: 1, gt: 2, gte: 3, lt: 4, lte: 5 } as const;
export type PushOpName = keyof typeof PUSH_OP;

function cmpU32(v: number, op: number, t: number): boolean {
  switch (op) {
    case 0:
      return v === t;
    case 1:
      return v !== t;
    case 2:
      return v > t;
    case 3:
      return v >= t;
    case 4:
      return v < t;
    default:
      return v <= t;
  }
}

function cmpF64(v: number, op: number, t: number): boolean {
  // NaN semantics fall out of IEEE comparisons (never Eq, always Ne).
  switch (op) {
    case 0:
      return v === t;
    case 1:
      return v !== t;
    case 2:
      return v > t;
    case 3:
      return v >= t;
    case 4:
      return v < t;
    default:
      return v <= t;
  }
}

function fallbackFilterU32(values: Uint32Array, op: number, target: number): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) if (cmpU32(values[i]!, op, target)) out.push(i);
  return Uint32Array.from(out);
}

function fallbackFilterF64(values: Float64Array, op: number, target: number): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) if (cmpF64(values[i]!, op, target)) out.push(i);
  return Uint32Array.from(out);
}

/** Filters u32 values, preferring the native SIMD kernel. */
export function pushFilterU32(
  bindings: TakyonBindings | undefined,
  values: Uint32Array,
  op: PushOpName,
  target: number,
): Uint32Array {
  const code = PUSH_OP[op];
  const fn = bindings?.filter_u32;
  if (fn) {
    try {
      return fn.call(bindings, values, code, target >>> 0);
    } catch {
      // Fall through to TS on bridge errors (stale addon, OOM, ...).
    }
  }
  return fallbackFilterU32(values, code, target >>> 0);
}

/** Filters f64 values, preferring the native kernel. */
export function pushFilterF64(
  bindings: TakyonBindings | undefined,
  values: Float64Array,
  op: PushOpName,
  target: number,
): Uint32Array {
  const code = PUSH_OP[op];
  const fn = bindings?.filter_f64;
  if (fn) {
    try {
      return fn.call(bindings, values, code, target);
    } catch {
      // Fall through to TS.
    }
  }
  return fallbackFilterF64(values, code, target);
}

function fallbackSum(values: Float64Array): number {
  // Kahan summation matches the Zig kernel.
  let sum = 0;
  let c = 0;
  for (const v of values) {
    const y = v - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

function fallbackSumSelected(values: Float64Array, sel: Uint32Array): number {
  let sum = 0;
  let c = 0;
  for (const idx of sel) {
    if (idx >= values.length) break;
    const y = values[idx]! - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

/** Kahan sum over a full column. */
export function pushSum(bindings: TakyonBindings | undefined, values: Float64Array): number {
  const fn = bindings?.agg_sum;
  if (fn) {
    try {
      return fn.call(bindings, values);
    } catch {
      // Fall through.
    }
  }
  return fallbackSum(values);
}

/** Kahan sum over a selection vector. */
export function pushSumSelected(
  bindings: TakyonBindings | undefined,
  values: Float64Array,
  sel: Uint32Array,
): number {
  const fn = bindings?.agg_sum_selected;
  if (fn) {
    try {
      return fn.call(bindings, values, sel);
    } catch {
      // Fall through.
    }
  }
  return fallbackSumSelected(values, sel);
}

/** Min over a selection (0 when empty, mirrors TS aggregate()). */
export function pushMinSelected(
  bindings: TakyonBindings | undefined,
  values: Float64Array,
  sel: Uint32Array,
): number {
  const fn = bindings?.agg_min_selected;
  if (fn) {
    try {
      return fn.call(bindings, values, sel);
    } catch {
      // Fall through.
    }
  }
  if (sel.length === 0) return 0;
  let m = Number.POSITIVE_INFINITY;
  let seen = false;
  for (const idx of sel) {
    if (idx >= values.length) break;
    seen = true;
    if (values[idx]! < m) m = values[idx]!;
  }
  return seen ? m : 0;
}

/** Max over a selection (0 when empty, mirrors TS aggregate()). */
export function pushMaxSelected(
  bindings: TakyonBindings | undefined,
  values: Float64Array,
  sel: Uint32Array,
): number {
  const fn = bindings?.agg_max_selected;
  if (fn) {
    try {
      return fn.call(bindings, values, sel);
    } catch {
      // Fall through.
    }
  }
  if (sel.length === 0) return 0;
  let m = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const idx of sel) {
    if (idx >= values.length) break;
    seen = true;
    if (values[idx]! > m) m = values[idx]!;
  }
  return seen ? m : 0;
}

/**
 * Columnar scan helper: extracts a numeric column from rows into a dense
 * Float64Array plus a validity mask (non-numbers become NaN + invalid).
 * Returns indices of rows with valid numbers for pushdown chaining.
 */
export function columnize(rows: Row[], column: string): { values: Float64Array; valid: Uint32Array } {
  const values = new Float64Array(rows.length);
  const idx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = (rows[i] as Record<string, unknown>)[column];
    if (typeof v === 'number') {
      values[i] = v;
      idx.push(i);
    } else {
      values[i] = Number.NaN;
    }
  }
  return { values, valid: Uint32Array.from(idx) };
}
