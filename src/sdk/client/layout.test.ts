import { describe, expect, it } from 'vitest';
import * as layout from './layout';

describe('shared layout', () => {
    it('keeps canonical offsets in order', () => {
        expect(layout.RING_OFFSET).toBe(1024);
        expect(layout.RECORD_START).toBeGreaterThan(layout.RECORD_BUMP_OFFSET + 4);
        expect(layout.ART_ROOT_OFFSET).toBeGreaterThan(layout.RECORD_START);
        expect(layout.STRING_ARENA_START).toBeGreaterThan(layout.ART_ROOT_OFFSET);
        expect(layout.STRING_DATA_START).toBe(layout.STRING_BUMP_OFFSET + 4);
        expect(layout.MIN_ARENA_SIZE).toBeGreaterThanOrEqual(layout.STRING_ARENA_START);
    });

    it('caps inline deltas and keys', () => {
        expect(layout.MAX_DELTA_INLINE).toBe(48);
        expect(layout.MAX_KEY_LEN).toBe(256);
        expect(layout.RING_DEFAULT_CAPACITY).toBeGreaterThanOrEqual(1024);
    });

    it('mirrors ART offsets and arena magic from layout.zig', () => {
        expect(layout.ART_BUMP_OFFSET).toBe(layout.ART_ROOT_OFFSET + 4);
        expect(layout.ART_START).toBe(layout.ART_ROOT_OFFSET + 8);
        expect(layout.ARENA_MAGIC).toBe(0x54414b59);
    });

    it('computes ring and arena sizes like layout.zig', () => {
        expect(layout.ringBytes(16)).toBe(192 + 16 * 64 + 16 * 8);
        expect(layout.ringBytes(4096)).toBe(192 + 4096 * (layout.DELTA_SIZE + layout.RING_SEQ_BYTES));
        expect(layout.minArenaForCapacity(16)).toBe(
            layout.RING_OFFSET + layout.ringBytes(16) + 1024
        );
        expect(layout.minArenaForCapacity(4096)).toBe(
            layout.RING_OFFSET + layout.ringBytes(4096) + 1024
        );
    });

    it('mirrors Wave-1 enlarged ring layout (RECORD_BUMP 296128, RECORD_START 296136)', () => {
        expect(layout.RING_HEADER_BYTES).toBe(192);
        expect(layout.RECORD_BUMP_OFFSET).toBe(
            layout.RING_OFFSET + layout.RING_HEADER_BYTES + layout.RING_DEFAULT_CAPACITY * (layout.DELTA_SIZE + layout.RING_SEQ_BYTES)
        );
        expect(layout.RECORD_BUMP_OFFSET).toBe(296128);
        expect(layout.RECORD_START).toBe(layout.RECORD_BUMP_OFFSET + 8);
        expect(layout.RECORD_START).toBe(296136);
        expect(layout.RECORD_BUMP_INIT).toBe(layout.RECORD_START);
    });

    it('exposes header magic/version constants and 16MB minimum arena', () => {
        expect(layout.MAGIC_OFFSET).toBe(0);
        expect(layout.VERSION_OFFSET).toBe(4);
        expect(layout.LAYOUT_VERSION).toBe(layout.LAYOUT_VERSION_WITH_TABLE);
        expect(layout.MIN_ARENA_SIZE).toBe(16 * 1024 * 1024);
    });
});

describe('region table', () => {
    function arenaOf(bytes: number): ArrayBuffer {
        const buffer = new ArrayBuffer(bytes);
        layout.writeRegions(buffer, layout.defaultRegions(bytes));
        return buffer;
    }

    it('round-trips through a buffer', () => {
        const bytes = 16 * 1024 * 1024;
        const buffer = arenaOf(bytes);
        const r = layout.readRegions(buffer);
        expect(r.arenaBytes).toBe(bytes);
        expect(r.ringCapacity).toBe(layout.RING_DEFAULT_CAPACITY);
        expect(r.recordStart).toBe(layout.RECORD_START);
        expect(r.artRoot).toBe(layout.ART_ROOT_OFFSET);
        expect(r.stringStart).toBe(layout.STRING_ARENA_START);
        expect(layout.recordBumpOffset(r)).toBe(layout.RECORD_BUMP_OFFSET);
        expect(layout.stringDataStart(r)).toBe(layout.STRING_DATA_START);
    });

    it('carries regions the constants cannot express', () => {
        // The point of the gate: a 64 MiB record region on a 256 MiB arena,
        // which the default layout has no way to describe.
        const bytes = 256 * 1024 * 1024;
        const r: layout.Regions = {
            arenaBytes: bytes,
            ringCapacity: 4096,
            recordStart: 296136,
            recordBytes: 64 * 1024 * 1024,
            artRoot: 296136 + 64 * 1024 * 1024,
            artBytes: 8 * 1024 * 1024,
            stringStart: 296136 + 72 * 1024 * 1024,
            stringBytes: bytes - (296136 + 72 * 1024 * 1024),
        };
        const buffer = new ArrayBuffer(bytes);
        layout.writeRegions(buffer, r);
        expect(layout.readRegions(buffer)).toEqual(r);
        expect(() => layout.validateRegions(layout.readRegions(buffer), bytes)).not.toThrow();
    });

    it('refuses a segment with no table rather than guessing', () => {
        const bare = new ArrayBuffer(4096);
        expect(() => layout.readRegions(bare)).toThrow(/not a Takyon arena/);

        // Right magic, layout version 2: no table behind it.
        const old = new ArrayBuffer(4096);
        const view = new DataView(old);
        view.setUint32(layout.MAGIC_OFFSET, layout.ARENA_MAGIC, true);
        view.setUint32(layout.VERSION_OFFSET, 2, true);
        expect(() => layout.readRegions(old)).toThrow(/layout version 2/);
    });

    it('names the relation that is broken', () => {
        const bytes = 16 * 1024 * 1024;
        const good = layout.defaultRegions(bytes);
        expect(() => layout.validateRegions(good, bytes)).not.toThrow();

        expect(() => layout.validateRegions({ ...good, arenaBytes: 1 }, bytes)).toThrow(/built for 1 bytes/);
        expect(() => layout.validateRegions({ ...good, ringCapacity: 3000 }, bytes)).toThrow(/power of two/);
        expect(() => layout.validateRegions({ ...good, recordBytes: good.artRoot }, bytes)).toThrow(/runs into the index/);
        expect(() => layout.validateRegions({ ...good, artRoot: good.artRoot + 4, artBytes: good.artBytes - 4 }, bytes)).toThrow(/8-byte aligned/);
        expect(() => layout.validateRegions({ ...good, stringBytes: 4 }, bytes)).toThrow(/no room for its bump word/);
    });
});
