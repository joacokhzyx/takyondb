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
});
