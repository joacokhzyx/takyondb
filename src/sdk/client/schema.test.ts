import { describe, expect, it } from 'vitest';
import { TakyonSchema } from './schema';

describe('TakyonSchema', () => {
    it('aligns every field and pads the record to a whole number of units', () => {
        // The offsets are the contract with the log: the record bump is a
        // byte counter that recovery rounds up to 8, so a packed 20-byte
        // record would be allocated a few bytes past where the log says on
        // every restart. Layout v4 packs aligned instead.
        const s = new TakyonSchema({
            a: 'uint8',
            b: 'uint32',
            c: 'float64',
            name: 'string',
        });
        expect(s.fields.a).toEqual({ type: 'uint8', offset: 0, size: 1 });
        // 1 byte of 'a' is followed by padding, not by 'b'.
        expect(s.fields.b).toEqual({ type: 'uint32', offset: 4, size: 4 });
        expect(s.fields.c).toEqual({ type: 'float64', offset: 8, size: 8 });
        expect(s.fields.name).toEqual({ type: 'string', offset: 16, size: 8 });
        // 24, not 21: the tail is padded so the next record starts aligned.
        expect(s.totalSize).toBe(24);
    });

    it('aligns a string first field to 8, not to 4', () => {
        // A fat pointer holds a 64-bit arena offset. Aligned to 4 it would
        // sit at an address that is not a multiple of 8 in a record that
        // starts aligned, which is exactly the disagreement this layout
        // exists to remove.
        const s = new TakyonSchema({ name: 'string', n: 'uint32' });
        expect(s.fields.name).toEqual({ type: 'string', offset: 0, size: 8 });
        expect(s.fields.n).toEqual({ type: 'uint32', offset: 8, size: 4 });
        expect(s.totalSize % 8).toBe(0);
    });

    it('pads a schema whose last field is narrower than a unit', () => {
        // 1 byte written, 8 reserved. Without the tail padding this record
        // is 1 byte and the next one starts one byte in, so its own
        // alignment would be relative to a misaligned base.
        const s = new TakyonSchema({ only: 'uint8' });
        expect(s.totalSize).toBe(8);
    });

    it('rejects empty definitions and unknown types', () => {
        expect(() => new TakyonSchema({} as never)).toThrow();
        expect(() => new TakyonSchema({ x: 'bool' } as never)).toThrow(/unknown field type/);
    });
});
