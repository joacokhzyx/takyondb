/**
 * ============================================================================
 * File: layout.test.ts
 * Description: Unit tests for the shared memory layout mirror.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

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
        expect(layout.LAYOUT_VERSION).toBe(2);
        expect(layout.MIN_ARENA_SIZE).toBe(16 * 1024 * 1024);
    });
});
