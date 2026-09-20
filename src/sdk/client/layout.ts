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

export const RECORD_BUMP_OFFSET = 2048;
export const RECORD_BUMP_INIT = 4096;
export const RECORD_START = 4096;
export const ART_ROOT_OFFSET = 2097152;

export const STRING_ARENA_START = 10 * 1024 * 1024;
export const STRING_BUMP_OFFSET = STRING_ARENA_START;
export const STRING_DATA_START = STRING_ARENA_START + 4;

export const MIN_ARENA_SIZE = 64 * 1024 * 1024;

/** Max key length accepted by takyon_insert_index / takyon_search_index. */
export const MAX_KEY_LEN = 256;
