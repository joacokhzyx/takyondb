import { describe, it, expect } from 'vitest';
import { compiledWhere, matchesWhere } from './filter';
import { aggregate } from './aggregation';
import type { Row } from './codec';

describe('matchesWhere: scalar shorthand', () => {
    it('compares directly when the clause value is not a condition object', () => {
        expect(matchesWhere({ a: 1 }, { a: 1 })).toBe(true);
        expect(matchesWhere({ a: 1 }, { a: 2 })).toBe(false);
        expect(matchesWhere({ a: 'x' }, { a: 'x' })).toBe(true);
    });

    it('treats a missing where clause as a match', () => {
        expect(matchesWhere({ a: 1 })).toBe(true);
    });
});

describe('matchesWhere: comparison operators', () => {
    it('supports eq and ne', () => {
        expect(matchesWhere({ a: 5 }, { a: { eq: 5 } })).toBe(true);
        expect(matchesWhere({ a: 5 }, { a: { eq: 6 } })).toBe(false);
        expect(matchesWhere({ a: 5 }, { a: { ne: 6 } })).toBe(true);
        expect(matchesWhere({ a: 5 }, { a: { ne: 5 } })).toBe(false);
    });

    it('supports the ordered comparisons on numbers', () => {
        const row = { a: 10 };
        expect(matchesWhere(row, { a: { gt: 9 } })).toBe(true);
        expect(matchesWhere(row, { a: { gt: 10 } })).toBe(false);
        expect(matchesWhere(row, { a: { gte: 10 } })).toBe(true);
        expect(matchesWhere(row, { a: { lt: 11 } })).toBe(true);
        expect(matchesWhere(row, { a: { lte: 10 } })).toBe(true);
        expect(matchesWhere(row, { a: { lt: 10 } })).toBe(false);
    });

    it('does not apply ordered comparisons to non-numeric cells', () => {
        // A string cell must not satisfy a numeric ordering by coercion.
        expect(matchesWhere({ a: 'zzz' }, { a: { gte: 1 } })).toBe(false);
        expect(matchesWhere({ a: undefined }, { a: { lt: 1 } })).toBe(false);
    });

    it('supports in, on both the array and the Set path', () => {
        expect(matchesWhere({ a: 3 }, { a: { in: [1, 2, 3] } })).toBe(true);
        expect(matchesWhere({ a: 9 }, { a: { in: [1, 2, 3] } })).toBe(false);
        // 8+ entries take the Set path; same answer either way.
        const big = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        expect(matchesWhere({ a: 7 }, { a: { in: big } })).toBe(true);
        expect(matchesWhere({ a: 70 }, { a: { in: big } })).toBe(false);
        // Exactly at the threshold.
        const eight = [1, 2, 3, 4, 5, 6, 7, 8];
        expect(matchesWhere({ a: 8 }, { a: { in: eight } })).toBe(true);
    });

    it('ANDs multiple columns and multiple checks on one column', () => {
        const row = { a: 10, b: 'keep' };
        expect(matchesWhere(row, { a: { gte: 10 }, b: { eq: 'keep' } })).toBe(true);
        expect(matchesWhere(row, { a: { gte: 10, lte: 10 }, b: { eq: 'keep' } })).toBe(true);
        expect(matchesWhere(row, { a: { gte: 10, lte: 10 }, b: { eq: 'drop' } })).toBe(false);
    });

    it('fails fast on the first failing column', () => {
        expect(matchesWhere({ a: 1, b: 2 }, { a: { eq: 1 }, b: { eq: 99 } })).toBe(false);
    });
});

describe('matchesWhere: like', () => {
    it('treats % as a multi-character wildcard', () => {
        expect(matchesWhere({ a: 'hello world' }, { a: { like: 'hello%' } })).toBe(true);
        expect(matchesWhere({ a: 'hello world' }, { a: { like: '%world' } })).toBe(true);
        expect(matchesWhere({ a: 'hello world' }, { a: { like: '%o w%' } })).toBe(true);
        expect(matchesWhere({ a: 'hello world' }, { a: { like: 'hello' } })).toBe(false);
    });

    it('treats _ as exactly one character', () => {
        expect(matchesWhere({ a: 'abc' }, { a: { like: 'a_c' } })).toBe(true);
        expect(matchesWhere({ a: 'abbc' }, { a: { like: 'a_c' } })).toBe(false);
    });

    it('anchors the pattern at both ends', () => {
        expect(matchesWhere({ a: 'xabcx' }, { a: { like: 'abc' } })).toBe(false);
    });

    it('treats regex metacharacters in the pattern as literals', () => {
        // Regression: the pattern used to be interpolated into a RegExp
        // unescaped, so a '.' in a LIKE pattern silently matched any
        // character. 'a.c' must match a literal dot and nothing else.
        expect(matchesWhere({ a: 'a.c' }, { a: { like: 'a.c' } })).toBe(true);
        expect(matchesWhere({ a: 'abc' }, { a: { like: 'a.c' } })).toBe(false);
        // Parentheses and brackets too.
        expect(matchesWhere({ a: 'f(x)' }, { a: { like: 'f(x)' } })).toBe(true);
        expect(matchesWhere({ a: 'fx' }, { a: { like: 'f(x)' } })).toBe(false);
        expect(matchesWhere({ a: 'a[0]' }, { a: { like: 'a[0]' } })).toBe(true);
        expect(matchesWhere({ a: 'a' }, { a: { like: 'a[0]' } })).toBe(false);
    });

    it('does not apply like to non-string cells', () => {
        expect(matchesWhere({ a: 42 }, { a: { like: '4%' } })).toBe(false);
    });
});

describe('compiledWhere', () => {
    it('compiles a clause once and reuses the same predicate', () => {
        const where = { a: { gte: 5 } };
        const first = compiledWhere(where);
        const second = compiledWhere(where);
        expect(second).toBe(first);
    });

    it('produces a predicate equivalent to matchesWhere for every row', () => {
        const where = { a: { gte: 5 }, b: { like: 'x%' } };
        const pred = compiledWhere(where);
        for (const row of [
            { a: 5, b: 'xyz' },
            { a: 4, b: 'xyz' },
            { a: 9, b: 'abc' },
            { a: 9, b: 'nope' },
        ]) {
            expect(pred(row)).toBe(matchesWhere({ ...row }, { ...where }));
        }
    });

    it('is safe to run against a large row set without recompiling', () => {
        const where = { n: { gte: 500 } };
        const rows = Array.from({ length: 2000 }, (_, i) => ({ n: i }));
        const matched = rows.filter((r) => compiledWhere(where)(r));
        expect(matched).toHaveLength(1500);
        expect(matched[0].n).toBe(500);
    });
});

describe('aggregate', () => {
    const rows: Row[] = [
        { a: 3 },
        { a: -7 },
        { a: 10 },
        { a: 1 },
    ];

    it('computes count, sum, avg, min and max', () => {
        expect(aggregate(rows, 'count', 'a')).toBe(4);
        expect(aggregate(rows, 'sum', 'a')).toBe(7);
        expect(aggregate(rows, 'avg', 'a')).toBeCloseTo(1.75, 10);
        expect(aggregate(rows, 'min', 'a')).toBe(-7);
        expect(aggregate(rows, 'max', 'a')).toBe(10);
    });

    it('seeds min and max from the first value, not from zero', () => {
        // A naive accumulator initialised at 0 reports 0 as the min of an
        // all-positive column.
        const positive: Row[] = [{ a: 4 }, { a: 9 }, { a: 2 }];
        expect(aggregate(positive, 'min', 'a')).toBe(2);
        const negative: Row[] = [{ a: -4 }, { a: -9 }, { a: -2 }];
        expect(aggregate(negative, 'min', 'a')).toBe(-9);
        expect(aggregate(negative, 'max', 'a')).toBe(-2);
    });

    it('ignores non-numeric and missing cells', () => {
        const mixed = [{ a: 1 }, { a: 'x' }, { a: null }, {}, { a: 3 }] as unknown as Row[];
        expect(aggregate(mixed, 'sum', 'a')).toBe(4);
        expect(aggregate(mixed, 'avg', 'a')).toBeCloseTo(2, 10);
        expect(aggregate(mixed, 'count', 'a')).toBe(5); // count ignores the column
    });

    it('returns 0 for an empty or all-non-numeric set', () => {
        expect(aggregate([], 'sum', 'a')).toBe(0);
        expect(aggregate([] as Row[], 'min', 'a')).toBe(0);
        const nonNumeric = [{ a: 'x' }] as unknown as Row[];
        expect(aggregate(nonNumeric, 'max', 'a')).toBe(0);
    });

    it('throws when a column is required but not given', () => {
        expect(() => aggregate(rows, 'sum')).toThrow(/requires a column/);
    });

    it('handles a column far wider than the argument limit', () => {
        // Math.min(...vals) Makefans onto the call stack and throws a
        // RangeError past roughly 100k arguments. A loop cannot.
        const wide: Row[] = Array.from({ length: 200000 }, (_, i) => ({ a: i }));
        expect(() => aggregate(wide, 'min', 'a')).not.toThrow();
        expect(aggregate(wide, 'min', 'a')).toBe(0);
        expect(aggregate(wide, 'max', 'a')).toBe(199999);
    });
});
