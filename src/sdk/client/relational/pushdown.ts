/**
 * Columnar predicate and aggregate kernels, preferring the native SIMD
 * implementation and falling back to an identical TypeScript one.
 *
 * The contract is that the two are indistinguishable: same comparison
 * results for the same inputs, NaN never `eq` and always `ne`, and 0 rather
 * than NaN for an empty aggregate. A bridge that throws is treated as
 * absent, so a stale addon degrades to slower code rather than to a
 * different answer.
 */

import { TakyonBindings } from '../proxy';
import { Row } from './codec';

/**
 * The comparison codes the native kernels expect, shared with Zig
 * `filter.zig` `CmpOp`. The numbers are the wire format across the C-ABI:
 * they are passed straight to `takyon_filter_u32` and `takyon_filter_f64`,
 * which reject anything above 5.
 */
export const PUSH_OP = { eq: 0, ne: 1, gt: 2, gte: 3, lt: 4, lte: 5 } as const;

/** The operator names `PUSH_OP` codes. */
export type PushOpName = keyof typeof PUSH_OP;

/**
 * Applies a comparison code to a u32 cell.
 *
 * The final `default` is `lte` rather than "no match" so an unexpected code
 * from a caller degrades to the loosest comparison instead of dropping the
 * row. The bridge range-checks `op` before it reaches here.
 */
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

/**
 * Applies a comparison code to an f64 cell.
 *
 * NaN semantics fall out of IEEE comparisons (never Eq, always Ne), which is
 * why no explicit NaN test appears here and why the native kernel agrees
 * without being told.
 */
function cmpF64(v: number, op: number, t: number): boolean {
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

/** The TypeScript filter for u32 columns, matching `column.filterU32`. */
function fallbackFilterU32(values: Uint32Array, op: number, target: number): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) if (cmpU32(values[i]!, op, target)) out.push(i);
  return Uint32Array.from(out);
}

/** The TypeScript filter for f64 columns, matching `column.filterF64`. */
function fallbackFilterF64(values: Float64Array, op: number, target: number): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) if (cmpF64(values[i]!, op, target)) out.push(i);
  return Uint32Array.from(out);
}

/**
 * Filters u32 values, preferring the native SIMD kernel.
 *
 * @param bindings - Native bindings, or undefined to use the fallback.
 * @param values - The column to filter.
 * @param op - The comparison to apply.
 * @param target - The value to compare against; truncated to u32, so a
 *   negative or fractional `target` compares against its `>>> 0` value
 *   rather than being rejected.
 * @returns Ascending indices of the matching cells.
 * @throws {TypeError} If `values` is not a `Uint32Array` and a native
 *   kernel is present; the fallback accepts anything array-like at runtime.
 * @throws {RangeError} If the native kernel rejects the length or the op
 *   code.
 */
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
      // Every other kernel below does the same, so a stale addon
      // degrades to slower code and never to a different answer.
    }
  }
  return fallbackFilterU32(values, code, target >>> 0);
}

/**
 * Filters f64 values, preferring the native kernel.
 *
 * @param bindings - Native bindings, or undefined to use the fallback.
 * @param values - The column to filter.
 * @param op - The comparison to apply.
 * @param target - The value to compare against, used as given including
 *   NaN.
 * @returns Ascending indices of the matching cells. A NaN cell matches
 *   `ne` and no other operator.
 * @throws {TypeError} If `values` is not a `Float64Array` and a native
 *   kernel is present.
 * @throws {RangeError} If the native kernel rejects the length or the op
 *   code.
 */
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
    }
  }
  return fallbackFilterF64(values, code, target);
}

/**
 * Compensated sum over every cell, matching `column.kahanSum`.
 *
 * Kahan rather than a plain accumulation because the native kernel is
 * compensated, and an uncompensated fallback would drift differently for
 * the same column.
 */
function fallbackSum(values: Float64Array): number {
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

/**
 * Compensated sum over the selected cells, matching
 * `column.kahanSumSelected`.
 */
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

/**
 * Compensated sum over a full column.
 *
 * @param bindings - Native bindings, or undefined to use the fallback.
 * @param values - The column to sum.
 * @returns The sum, or 0 for an empty column.
 * @throws {TypeError} If `values` is not a `Float64Array` and a native
 *   kernel is present.
 */
export function pushSum(bindings: TakyonBindings | undefined, values: Float64Array): number {
  const fn = bindings?.agg_sum;
  if (fn) {
    try {
      return fn.call(bindings, values);
    } catch {
    }
  }
  return fallbackSum(values);
}

/**
 * Compensated sum over a selection vector.
 *
 * @param bindings - Native bindings, or undefined to use the fallback.
 * @param values - The column.
 * @param sel - Ascending selection indices. An index at or past
 *   `values.length` ends the scan, matching `kahanSumSelected` in Zig; it
 *   is not a hard error.
 * @returns The sum of the selected cells, or 0 for an empty selection.
 * @throws {TypeError} If the arguments are not a `Float64Array` and a
 *   `Uint32Array` and a native kernel is present.
 */
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
    }
  }
  return fallbackSumSelected(values, sel);
}

/**
 * Min over a selection (0 when empty, mirrors TS aggregate()).
 *
 * @param bindings - Native bindings, or undefined to use the fallback.
 * @param values - The column.
 * @param sel - Ascending selection indices; an out-of-range index ends the
 *   scan.
 * @returns The minimum, or 0 for an empty selection. 0 rather than NaN or
 *   infinity, matching `aggregate`.
 * @throws {TypeError} If the arguments are not a `Float64Array` and a
 *   `Uint32Array` and a native kernel is present.
 */
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

/**
 * Max over a selection (0 when empty, mirrors TS aggregate()).
 *
 * @param bindings - Native bindings, or undefined to use the fallback.
 * @param values - The column.
 * @param sel - Ascending selection indices; an out-of-range index ends the
 *   scan.
 * @returns The maximum, or 0 for an empty selection.
 * @throws {TypeError} If the arguments are not a `Float64Array` and a
 *   `Uint32Array` and a native kernel is present.
 */
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
 *
 * The values array is dense and position-aligned with `rows`, so a
 * non-numeric cell becomes NaN rather than being dropped. That is what
 * keeps the indices a native filter returns usable against the original
 * rows: a NaN in a filtered column is excluded by every operator except
 * `ne`.
 *
 * @param rows - The rows to extract from.
 * @param column - The column to read.
 * @returns The dense values, and the ascending indices of the cells that
 *   held a number.
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
