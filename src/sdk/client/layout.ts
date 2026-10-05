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
export const LAYOUT_VERSION = 3;

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

// --- Region table (arena layout version 3) ---------------------------------
//
// Mirrors `Regions` in `src/core/memory/layout.zig`. The field offsets are
// fixed so the header can be parsed before anything in it is trusted; the
// values come from the mapping, not from this file. A client that used the
// constants above would place its records where the daemon put the index.

/** Byte offset of the total mapped size the table was built for. */
export const ARENA_BYTES_OFFSET = 8;
/** Byte offset of the ring slot count. */
export const RING_CAPACITY_OFFSET = 12;
/** Byte offset of the first record byte. */
export const RECORD_START_OFFSET = 16;
/** Byte offset of the record region size. */
export const RECORD_BYTES_OFFSET = 20;
/** Byte offset of the index root pointer. */
export const ART_ROOT_OFFSET_FIELD = 24;
/** Byte offset of the index region size. */
export const ART_BYTES_OFFSET = 28;
/** Byte offset of the string bump word. */
export const STRING_START_OFFSET = 32;
/** Byte offset of the string region size. */
export const STRING_BYTES_OFFSET = 36;
/** Byte offset of the shared monotonic clock. Nothing reads it yet. */
export const CLOCK_MS_OFFSET = 40;
/** First byte after the header proper. */
export const HEADER_BYTES = 48;

/** The first arena layout whose regions live in the header. */
export const LAYOUT_VERSION_WITH_TABLE = 3;

/** One arena's region boundaries, as the header reports them. */
export interface Regions {
  arenaBytes: number;
  ringCapacity: number;
  recordStart: number;
  recordBytes: number;
  artRoot: number;
  artBytes: number;
  stringStart: number;
  stringBytes: number;
}

/** Byte offset of the single shared record bump word for these regions. */
export function recordBumpOffset(regions: Regions): number {
  return RING_OFFSET + ringBytes(regions.ringCapacity);
}

/** First index byte, after the root and bump words. */
export function artStart(regions: Regions): number {
  return regions.artRoot + 8;
}

/** Byte offset of the index bump word. */
export function artBumpOffset(regions: Regions): number {
  return regions.artRoot + 4;
}

/** First string payload byte, after the bump word. */
export function stringDataStart(regions: Regions): number {
  return regions.stringStart + 4;
}

/**
 * Reads the region table out of a mapped arena.
 *
 * Throws on a segment whose magic, version or table is missing. A client
 * that fell back to the constants would be writing into regions the daemon
 * is not using, so refusing is the only safe answer.
 */
export function readRegions(buffer: ArrayBuffer): Regions {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`arena too small to hold a header (${buffer.byteLength} bytes)`);
  }
  const view = new DataView(buffer);
  if (view.getUint32(MAGIC_OFFSET, true) !== ARENA_MAGIC) {
    throw new Error('not a Takyon arena: magic mismatch');
  }
  const version = view.getUint32(VERSION_OFFSET, true);
  if (version < LAYOUT_VERSION_WITH_TABLE) {
    throw new Error(
      `arena is layout version ${version}; this SDK speaks ${LAYOUT_VERSION_WITH_TABLE} or later. ` +
        'The engine writes region boundaries into the header from version 3, and a client that ' +
        'guessed them would write into the wrong regions. Restart the daemon with this build.'
    );
  }
  return {
    arenaBytes: view.getUint32(ARENA_BYTES_OFFSET, true),
    ringCapacity: view.getUint32(RING_CAPACITY_OFFSET, true),
    recordStart: view.getUint32(RECORD_START_OFFSET, true),
    recordBytes: view.getUint32(RECORD_BYTES_OFFSET, true),
    artRoot: view.getUint32(ART_ROOT_OFFSET_FIELD, true),
    artBytes: view.getUint32(ART_BYTES_OFFSET, true),
    stringStart: view.getUint32(STRING_START_OFFSET, true),
    stringBytes: view.getUint32(STRING_BYTES_OFFSET, true),
  };
}

/**
 * Checks every relation between the regions, mirroring
 * `validateRegions` in the Zig core.
 *
 * The engine validates before it writes anything, so a table that reaches
 * the SDK has already passed. This is the client-side half of the same
 * contract, and it exists because the client is the one that would corrupt
 * the arena.
 */
export function validateRegions(regions: Regions, mappedBytes: number): void {
  if (mappedBytes < HEADER_BYTES) throw new Error('arena too small to hold a header');
  if (regions.arenaBytes !== mappedBytes) {
    throw new Error(`region table was built for ${regions.arenaBytes} bytes but the mapping is ${mappedBytes}`);
  }
  const cap = regions.ringCapacity;
  if (cap < 16 || (cap & (cap - 1)) !== 0) {
    throw new Error(`ring capacity ${cap} must be a power of two of at least 16`);
  }
  if (regions.recordStart < recordBumpOffset(regions) + 8) {
    throw new Error(`record region starts at ${regions.recordStart}, inside the ring`);
  }
  if (regions.recordStart + regions.recordBytes > regions.artRoot) {
    throw new Error('record region runs into the index');
  }
  if (regions.artRoot % 8 !== 0) {
    throw new Error(`index root ${regions.artRoot} is not 8-byte aligned`);
  }
  if (regions.artRoot + regions.artBytes > regions.stringStart) {
    throw new Error('index region runs into the string region');
  }
  if (regions.stringBytes < 8) {
    throw new Error('string region leaves no room for its bump word');
  }
  if (regions.stringStart + regions.stringBytes > regions.arenaBytes) {
    throw new Error('string region runs past the end of the arena');
  }
}

/**
 * The table this build would use with no configuration, for test fixtures.
 *
 * The engine is the authority: the daemon stamps the header, and a client
 * never writes one. This exists because a test fixture that hands the SDK a
 * bare `ArrayBuffer` is not a valid arena, and the honest way to fix that
 * is to make the fixture write a real header rather than to relax the SDK's
 * check. It mirrors `defaultRegions` in `layout.zig` for an arena of at
 * least `MIN_ARENA_SIZE`.
 */
export function defaultRegions(arenaBytes: number): Regions {
  const recordStart = RECORD_START;
  const artRoot = ART_ROOT_OFFSET;
  const stringStart = STRING_ARENA_START;
  return {
    arenaBytes,
    ringCapacity: RING_DEFAULT_CAPACITY,
    recordStart,
    recordBytes: artRoot - recordStart,
    artRoot,
    artBytes: stringStart - artRoot,
    stringStart,
    stringBytes: arenaBytes - stringStart,
  };
}

/**
 * Writes a region table into a buffer. Test fixtures only, for the same
 * reason as `defaultRegions`.
 */
export function writeRegions(buffer: ArrayBuffer, regions: Regions): void {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('buffer too small to hold a header');
  const view = new DataView(buffer);
  view.setUint32(MAGIC_OFFSET, ARENA_MAGIC, true);
  view.setUint32(VERSION_OFFSET, LAYOUT_VERSION, true);
  view.setUint32(ARENA_BYTES_OFFSET, regions.arenaBytes, true);
  view.setUint32(RING_CAPACITY_OFFSET, regions.ringCapacity, true);
  view.setUint32(RECORD_START_OFFSET, regions.recordStart, true);
  view.setUint32(RECORD_BYTES_OFFSET, regions.recordBytes, true);
  view.setUint32(ART_ROOT_OFFSET_FIELD, regions.artRoot, true);
  view.setUint32(ART_BYTES_OFFSET, regions.artBytes, true);
  view.setUint32(STRING_START_OFFSET, regions.stringStart, true);
  view.setUint32(STRING_BYTES_OFFSET, regions.stringBytes, true);
}
