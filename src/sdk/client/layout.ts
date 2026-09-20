/**
 * ============================================================================
 * File: layout.ts
 * Description: Mirror of src/core/memory/layout.zig. Single source of truth
 *   for SharedArena offsets shared between Zig and TypeScript. Import these
 *   constants instead of hardcoding magic numbers.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

export const GLOBAL_RESERVED = 1024;
export const RING_OFFSET = 1024;
export const RING_DEFAULT_CAPACITY = 4096;
export const DELTA_SIZE = 64;
export const MAX_DELTA_INLINE = 48;
export const RING_HEADER_BYTES = 192;

export const MAGIC_OFFSET = 0;
export const VERSION_OFFSET = 4;
export const LAYOUT_VERSION = 2;

export const RECORD_BUMP_OFFSET = RING_OFFSET + RING_HEADER_BYTES + RING_DEFAULT_CAPACITY * DELTA_SIZE;
export const RECORD_START = RECORD_BUMP_OFFSET + 8;
export const RECORD_BUMP_INIT = RECORD_START;
export const ART_ROOT_OFFSET = 2097152;
export const ART_BUMP_OFFSET = ART_ROOT_OFFSET + 4;
export const ART_START = ART_ROOT_OFFSET + 8;

export const STRING_ARENA_START = 10 * 1024 * 1024;
export const STRING_BUMP_OFFSET = STRING_ARENA_START;
export const STRING_DATA_START = STRING_ARENA_START + 4;

export const MIN_ARENA_SIZE = 16 * 1024 * 1024;

/** Magic for future header validation ("TAKY"). Mirrors layout.zig ARENA_MAGIC. */
export const ARENA_MAGIC = 0x54414b59;

/** Bytes needed to host a RingBuffer with `capacity` slots starting at
 * RING_OFFSET (header + slots), for bounds checking before init. */
export function ringBytes(capacity: number): number {
    return RING_HEADER_BYTES + capacity * DELTA_SIZE;
}

/** Lowest arena size that fits the given ring capacity plus ART root. */
export function minArenaForCapacity(capacity: number): number {
    return RING_OFFSET + ringBytes(capacity) + 1024;
}

/** Max key length accepted by takyon_insert_index / takyon_search_index. */
export const MAX_KEY_LEN = 256;
