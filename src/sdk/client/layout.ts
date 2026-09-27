/**
 * Byte offsets of the shared arena, mirroring `src/core/memory/layout.zig`.
 * Import these constants rather than hardcoding offsets; the Zig side pins
 * the same absolute values with `comptime` assertions.
 */

/** Bytes reserved at the front of the segment for the arena header. */
export const GLOBAL_RESERVED = 1024;
/** Byte offset of the ring buffer header. */
export const RING_OFFSET = 1024;
/** Ring slot count the engine initializes by default. */
export const RING_DEFAULT_CAPACITY = 4096;
/** Size of one ring slot: the 64-byte `DeltaMessage` plus its sequence word. */
export const DELTA_SIZE = 64;
/**
 * Largest payload carried inline in a `DeltaMessage`. 48 bytes of the
 * 64-byte slot are payload; the rest is the offset, length, and 4-valued
 * protocol tag.
 */
export const MAX_DELTA_INLINE = 48;
/** Bytes of the ring header, padded to whole cache lines. */
export const RING_HEADER_BYTES = 192;
/** Per-slot sequence words backing the MPMC ring (u64 per slot). */
export const RING_SEQ_BYTES = 8;

/** Byte offset of the arena magic word. */
export const MAGIC_OFFSET = 0;
/** Byte offset of the arena layout version. */
export const VERSION_OFFSET = 4;
/** Arena layout version this SDK was written against. */
export const LAYOUT_VERSION = 2;

/** Byte offset of the shared record bump word. */
export const RECORD_BUMP_OFFSET = RING_OFFSET + RING_HEADER_BYTES + RING_DEFAULT_CAPACITY * (DELTA_SIZE + RING_SEQ_BYTES);
/** First byte available to records, immediately after the bump word. */
export const RECORD_START = RECORD_BUMP_OFFSET + 8;
/** Value the record bump word is seeded to on first use. */
export const RECORD_BUMP_INIT = RECORD_START;
/** Byte offset of the ART root pointer. Records must not reach it. */
export const ART_ROOT_OFFSET = 2097152;
/** Byte offset of the ART node bump word. */
export const ART_BUMP_OFFSET = ART_ROOT_OFFSET + 4;
/** First byte available to ART nodes. */
export const ART_START = ART_ROOT_OFFSET + 8;

/** Byte offset of the string arena region. */
export const STRING_ARENA_START = 10 * 1024 * 1024;
/** Byte offset of the shared string bump word. */
export const STRING_BUMP_OFFSET = STRING_ARENA_START;
/** First byte available to string payloads. */
export const STRING_DATA_START = STRING_ARENA_START + 4;

/** Smallest arena `layout.zig` pins, in bytes. */
export const MIN_ARENA_SIZE = 16 * 1024 * 1024;

/**
 * Magic for future header validation ("TAKY"). Mirrors `ARENA_MAGIC` in
 * `src/core/memory/layout.zig`.
 */
export const ARENA_MAGIC = 0x54414b59;

/** Bytes needed to host a RingBuffer with `capacity` slots starting at
 * RING_OFFSET (header + slots), for bounds checking before init.
 * @param capacity - Number of ring slots.
 * @returns The byte length of the header plus every slot with its
 *   sequence word.
 */
export function ringBytes(capacity: number): number {
    return RING_HEADER_BYTES + capacity * (DELTA_SIZE + RING_SEQ_BYTES);
}

/**
 * Lowest arena size that fits the given ring capacity plus ART root.
 * @param capacity - Number of ring slots.
 * @returns The minimum `memorySize` to pass to the bridge.
 */
export function minArenaForCapacity(capacity: number): number {
    return RING_OFFSET + ringBytes(capacity) + 1024;
}

/** Max key length accepted by takyon_insert_index / takyon_search_index. */
export const MAX_KEY_LEN = 256;
