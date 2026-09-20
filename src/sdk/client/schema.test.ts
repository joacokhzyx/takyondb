/**
 * ============================================================================
 * File: schema.test.ts
 * Description: Unit tests for TakyonSchema offsets and validation.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { TakyonSchema } from './schema';

describe('TakyonSchema', () => {
    it('computes packed offsets and total size', () => {
        const s = new TakyonSchema({
            a: 'uint8',
            b: 'uint32',
            c: 'float64',
            name: 'string',
        });
        expect(s.fields.a).toEqual({ type: 'uint8', offset: 0, size: 1 });
        expect(s.fields.b).toEqual({ type: 'uint32', offset: 1, size: 4 });
        expect(s.fields.c).toEqual({ type: 'float64', offset: 5, size: 8 });
        expect(s.fields.name).toEqual({ type: 'string', offset: 13, size: 8 });
        expect(s.totalSize).toBe(21);
    });

    it('rejects empty definitions and unknown types', () => {
        expect(() => new TakyonSchema({} as never)).toThrow();
        expect(() => new TakyonSchema({ x: 'bool' } as never)).toThrow(/unknown field type/);
    });
});
