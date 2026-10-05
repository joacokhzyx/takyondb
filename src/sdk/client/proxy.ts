/**
 * The native binding surface and the zero-copy record proxy that sits on top
 * of it. Everything here addresses the shared arena by absolute byte offset;
 * no value is copied out except strings, which are decoded on read.
 */

import { TakyonSchema, FieldType } from './schema';
import {
    MAX_DELTA_INLINE,
    readRegions,
    stringDataStart,
    validateRegions,
    type Regions,
} from './layout';

/**
 * The native engine surface: one method per `pub export fn` in
 * `src/core/c_abi/exports.zig`, wrapped by `src/sdk/bindings/binding.cc`.
 *
 * Return conventions are the C-ABI ones, not JavaScript ones. Most methods
 * return `i32` with `0` for success and `-1` for error. Three depart from
 * that, and the departures are what a caller has to branch on, so they are
 * spelled out on the individual members below.
 *
 * The optional members are absent from an addon built before they were
 * added. Absence is not failure: `loadBindings` does not check for optional
 * methods, so a caller that needs one must test for it and report the
 * feature as unsupported.
 */
export interface TakyonBindings {
    /**
     * Maps the process-wide engine segment and returns the mapped bytes.
     *
     * The result is an external `ArrayBuffer` over the `mmap`, not a
     * `SharedArrayBuffer`: Node cannot wrap a raw pointer in one, so
     * `Atomics.wait` throws on it. Cross-worker coordination comes from the
     * shared pages, not from V8 atomics.
     *
     * @param size - Segment size in bytes, 1 to 1 GiB.
     * @returns The mapped region, or `null` on failure. `null` covers a
     *   failed mapping and a request for a second segment while one is
     *   already attached: the engine owns exactly one mapping, so a
     *   differing size or name is refused rather than served (see
     *   `resolveShmName` in `exports.zig`). A repeat call with the same
     *   size returns the same pages and increments the engine's refcount.
     * @throws {RangeError} If `size` is 0 or above 1 GiB.
     */
    initSharedMemory(size: number): ArrayBuffer | null;

    /**
     * Queues an inline record mutation of at most 48 bytes.
     *
     * @param offset - Absolute arena offset of the first byte.
     * @param data - The new bytes, 1 to 48 of them.
     * @returns 0 on success, -1 on error.
     * @throws {TypeError} If `data` is not a `Uint8Array`.
     * @throws {RangeError} If `data.length` is 0 or above 48.
     */
    pushDelta(offset: number, data: Uint8Array): number;

    /**
     * Announces that arena bytes at `offset` are now readable.
     *
     * A string write calls this before `pushDelta` of the fat pointer, so
     * the daemon never sees a pointer to bytes it has not been told about.
     *
     * @param offset - Absolute arena offset of the payload.
     * @param size - Payload length in bytes, at least 1.
     * @returns 0 on success, -1 on error.
     */
    notifyArena(offset: number, size: number): number;

    /**
     * Pops one message off the ring and returns its payload.
     *
     * This drains the ring; it is a test hook, not a status call. There is
     * no daemon in the unit tests, so this is the only consumer.
     *
     * @returns The 4-byte payload as an integer, 1 when the popped message
     *   had a different size, or -2 when the ring is not ready or empty.
     */
    verifyTestValue(): number;

    /**
     * Binds `key` to `value_offset` in the ART index.
     *
     * The ART lives in shared memory and nothing else records the mapping,
     * so a key indexed after the last checkpoint is gone after a crash
     * unless it also reached the WAL. That happens only when a daemon owns
     * the data directory: in the autonomous path the client created the
     * segment itself, there is no log writer, and the binding is lost on
     * restart with no error reported. See `takyon_insert_index`.
     *
     * @param key - NUL-free key of 1 to 256 UTF-8 bytes.
     * @param value_offset - Absolute arena offset to bind the key to.
     * @returns 0 on success, -1 on error: not attached, bad key length,
     *   `value_offset` past the arena, the ART insert failed, the ring was
     *   full, or the string arena is exhausted.
     * @throws {RangeError} If `key` is empty, over 256 bytes, or contains a
     *   NUL. The bridge rejects rather than truncating.
     */
    insert_index(key: string, value_offset: number): number;

    /**
     * Resolves `key` to the arena offset it was bound to.
     *
     * @param key - NUL-free key of 1 to 256 UTF-8 bytes.
     * @returns The offset, or -1 for not found. -1 is also returned for a
     *   bad key length and for a stored offset at or above `0x7FFFFFFF`,
     *   which is reserved so it can never alias the not-found answer.
     * @throws {RangeError} If `key` is empty, over 256 bytes, or contains a
     *   NUL.
     */
    search_index(key: string): number;

    /**
     * Removes `key` from the ART index.
     *
     * @param key - NUL-free key of 1 to 256 UTF-8 bytes.
     * @returns 1 when the key was present and deleted, 0 when it was not
     *   found, -1 on error.
     * @throws {RangeError} If `key` is empty, over 256 bytes, or contains a
     *   NUL.
     */
    remove_index(key: string): number;

    /**
     * Collects the value offsets of every key starting with `prefix`.
     *
     * @param prefix - NUL-free key prefix, 1 to 256 UTF-8 bytes.
     * @param max_results - Cap on returned offsets, 1 to 4096. Defaults to
     *   1024. The cap is silent: a wider prefix is truncated, not an error.
     * @returns The offsets in key order, possibly empty.
     * @throws {RangeError} For a bad prefix or a `max_results` outside
     *   1..4096.
     * @throws {Error} When the engine is not attached.
     */
    scan_prefix?(prefix: string, max_results?: number): Uint32Array;

    /**
     * Collects value offsets for keys starting with `prefix` whose suffix
     * sorts within `[lo, hi]`.
     *
     * Bounds are compared bytewise on the key suffix, so ordering is
     * lexicographic, not numeric.
     *
     * @param prefix - NUL-free key prefix, 1 to 256 UTF-8 bytes.
     * @param lo - Inclusive lower bound on the suffix, or `''` for
     *   unbounded below.
     * @param hi - Exclusive upper bound on the suffix, or `''` for
     *   unbounded above.
     * @param max_results - Cap on returned offsets, 1 to 4096. Defaults to
     *   1024.
     * @returns The offsets in key order. Inverted bounds return empty
     *   rather than raising.
     * @throws {RangeError} For a bad prefix or a `max_results` outside
     *   1..4096.
     * @throws {Error} When the engine is not attached.
     */
    scan_range?(prefix: string, lo?: string, hi?: string, max_results?: number): Uint32Array;

    /**
     * SIMD comparison kernel over a u32 column.
     *
     * @param values - The column.
     * @param op - Comparison code 0 (`eq`) through 5 (`lte`), matching
     *   `PUSH_OP` in `relational/pushdown.ts`.
     * @param target - The value to compare against.
     * @returns Indices of the matching elements, ascending.
     * @throws {TypeError} If `values` is not a `Uint32Array`.
     * @throws {RangeError} If `op` is above 5 or the length is 0 or above
     *   1e8.
     */
    filter_u32?(values: Uint32Array, op: number, target: number): Uint32Array;

    /**
     * Comparison kernel over an f64 column.
     *
     * NaN semantics follow IEEE: a NaN cell is never `eq` and always `ne`.
     *
     * @param values - The column.
     * @param op - Comparison code 0 (`eq`) through 5 (`lte`).
     * @param target - The value to compare against.
     * @returns Indices of the matching elements, ascending.
     * @throws {TypeError} If `values` is not a `Float64Array`.
     * @throws {RangeError} If `op` is above 5 or the length is 0 or above
     *   1e8.
     */
    filter_f64?(values: Float64Array, op: number, target: number): Uint32Array;

    /**
     * Compensated (Kahan) sum over an f64 column.
     *
     * @param values - The column.
     * @returns The sum, or 0 for an empty column.
     * @throws {TypeError} If `values` is not a `Float64Array`.
     */
    agg_sum?(values: Float64Array): number;

    /**
     * Compensated sum over the selected elements of a column.
     *
     * @param values - The column.
     * @param sel - Ascending selection indices. An index at or past
     *   `values.length` ends the scan rather than reading out of bounds.
     * @returns The sum, or 0 for an empty selection.
     * @throws {TypeError} If the arguments are not a `Float64Array` and a
     *   `Uint32Array`.
     */
    agg_sum_selected?(values: Float64Array, sel: Uint32Array): number;

    /**
     * Minimum over the selected elements of a column.
     *
     * @param values - The column.
     * @param sel - Ascending selection indices; an out-of-range index ends
     *   the scan.
     * @returns The minimum, or 0 for an empty selection, matching the
     *   TypeScript `aggregate` fallback rather than returning NaN.
     * @throws {TypeError} If the arguments are not a `Float64Array` and a
     *   `Uint32Array`.
     */
    agg_min_selected?(values: Float64Array, sel: Uint32Array): number;

    /**
     * Maximum over the selected elements of a column.
     *
     * @param values - The column.
     * @param sel - Ascending selection indices; an out-of-range index ends
     *   the scan.
     * @returns The maximum, or 0 for an empty selection.
     * @throws {TypeError} If the arguments are not a `Float64Array` and a
     *   `Uint32Array`.
     */
    agg_max_selected?(values: Float64Array, sel: Uint32Array): number;

    /**
     * Verifies one CRC-sealed record envelope.
     *
     * @param buf - The sealed envelope, `TREC` magic and CRC32 included.
     * @returns True when the envelope verifies.
     */
    verify_record?(buf: Uint8Array): boolean;

    /**
     * Walks a buffer of concatenated sealed envelopes.
     *
     * @param buf - The extent to walk.
     * @returns Counts of intact and corrupt envelopes, the bytes consumed,
     *   and whether the walk stopped on a partial trailing envelope.
     * @throws {Error} On bad arguments.
     */
    scrub_records?(buf: Uint8Array): { ok: number; corrupt: number; bytes: number; truncated: boolean };

    /**
     * Queues a checkpoint sentinel on the ring.
     *
     * @returns 0 when the sentinel was queued, -1 when the ring is not
     *   ready or is full. A queued sentinel only does something if a
     *   daemon drains the ring; with no daemon it is inert.
     */
    trigger_checkpoint(): number;

    /**
     * Starts the string-arena compaction thread.
     *
     * @param string_offset - Absolute arena offset of the string fat
     *   pointer to relocate through.
     * @returns 0 on success, -1 when not attached, the offset is out of
     *   range, a vacuum thread is already running, or the thread could not
     *   be spawned.
     */
    start_vacuum(string_offset: number): number;

    /**
     * Stops the vacuum thread. The native export is void, so this always
     * reports 0; the return value exists only to match the other methods.
     *
     * @returns 0.
     */
    stop_vacuum?(): number;

    /**
     * Drops one reference to the process-wide engine mapping. The unmap
     * and the state invalidation happen on the last call only, so a
     * partial disconnect leaves the memory valid for the other clients.
     *
     * The native export is void, so this always reports 0.
     *
     * @returns 0.
     */
    disconnect_shm?(): number;
}

/**
 * The object type a schema compiles to: every field becomes a plain number
 * or a string, and property access is a memory read rather than a stored
 * value. Reading is live, so a write through one proxy is visible through
 * any other proxy over the same offset.
 */
export type MappedObject<T> = {
    [P in keyof T]: T[P] extends 'uint8' | 'uint32' | 'float64' ? number : (T[P] extends 'string' ? string : never);
};

// Process-wide shared codecs: TextEncoder/TextDecoder are stateless for
// non-streaming use, so one instance per worker thread is enough and
// avoids per-operation construction on hot paths.
const sharedEncoder = new TextEncoder();
const sharedDecoder = new TextDecoder('utf-8');

// Shared scratch for scalar pushDelta payloads (max 8B: float64 / fat
// pointer) plus one typed view per payload size. pushDelta copies
// synchronously into the ring, so reuse across sequential calls is safe
// (single-threaded callers; each worker_thread owns its client).
const scratchBuf = new ArrayBuffer(8);
const scratchView = new DataView(scratchBuf);
const scratchU8_1 = new Uint8Array(scratchBuf, 0, 1);
const scratchU8_4 = new Uint8Array(scratchBuf, 0, 4);
const scratchU8_8 = new Uint8Array(scratchBuf, 0, 8);

// Growable UTF-8 staging area for string writes. Sized value.length * 4
// (worst case per UTF-16 unit); encodeInto reports the exact byte count
// so no over-allocation reaches the arena.
let encodeScratch: Uint8Array = new Uint8Array(256);

/**
 * Counts the UTF-8 bytes `s` will occupy, without allocating the encoded
 * copy. The scratch buffer is grown, not replaced per call, so this is
 * cheaper than `Buffer.byteLength` on the paths that run per record.
 *
 * The engine bounds keys by bytes, not by JavaScript string length, so
 * every key check needs this rather than `s.length`.
 *
 * @param s - The string to measure.
 * @returns The UTF-8 byte length.
 */
export function utf8ByteLength(s: string): number {
    if (s.length * 4 > encodeScratch.length) encodeScratch = new Uint8Array(s.length * 4);
    return sharedEncoder.encodeInto(s, encodeScratch).written;
}

/**
 * A client over one mapped engine segment: owns the `ArrayBuffer`, the
 * views onto it, and the calls into the native bindings.
 *
 * The segment is process-wide, so two clients in one process normally share
 * one mapping and the engine's own reference count, not this class, tracks
 * how many are holding it. See `shutdownEngine`.
 */
export class TakyonClient {
    private buffer: ArrayBuffer;
    // Single DataView over the whole arena: proxies address absolute
    // offsets (baseOffset + field.offset) instead of allocating one view
    // per record. Created lazily so tiny/mock buffers still construct
    // (failures surface at use, as before); the buffer is fixed for the
    // client's lifetime.
    private sharedView?: DataView;
    // Single bump-pointer views for the string/record arenas.
    private bumpView?: Uint32Array;
    /** The mapped segment's region boundaries. Read once at construction. */
    private regions!: Regions;
    private recordBumpView?: Uint32Array;

    /**
     * @param bindings - The native engine surface. A mock implementing the
     *   same interface is enough; the unit tests pass one.
     * @param size - Segment size in bytes, 1 to 1 GiB.
     * @throws {Error} If `size` is not a positive integer.
     * @throws {Error} If `initSharedMemory` returns null, which is the
     *   bridge's signal that the mapping failed.
     */
    constructor(private bindings: TakyonBindings, size: number) {
        if (!Number.isInteger(size) || size <= 0) {
            throw new Error("size must be a positive integer");
        }
        const buf = this.bindings.initSharedMemory(size);
        if (!buf) throw new Error("Failed to map shared memory");
        this.buffer = buf;
        // Read and check the region table before anything can address a
        // region. The engine validated it before it wrote anything, so a
        // failure here means the two builds disagree about the layout, and
        // continuing would put records where the index is.
        this.regions = readRegions(buf);
        validateRegions(this.regions, buf.byteLength);
    }

    /**
     * @returns The mapped arena's region boundaries, read from its header.
     */
    public getRegions(): Regions { return this.regions; }

    private view(): DataView {
        if (!this.sharedView) this.sharedView = new DataView(this.buffer);
        return this.sharedView;
    }

    private stringBump(): Uint32Array {
        if (!this.bumpView) {
            this.bumpView = new Uint32Array(this.buffer, this.regions.stringStart, 1);
        }
        return this.bumpView;
    }

    /**
     * @returns The mapped arena bytes. The same object every call, so a
     *   caller can hold it for the client's lifetime.
     */
    public getBuffer(): ArrayBuffer { return this.buffer; }

    /**
     * @returns The bindings this client was constructed with, for the
     *   index and pushdown entry points that `TakyonClient` does not wrap.
     */
    public getBindings(): TakyonBindings { return this.bindings; }

    /**
     * Exposes the single record bump word so callers can allocate with
     * `Atomics`. The word is shared by every client in the process, which
     * is what makes concurrent allocation safe; do not read it as a record
     * count, because nothing ever moves the word backwards.
     *
     * @returns A one-element `Uint32Array` view at `RECORD_BUMP_OFFSET`.
     * @throws {RangeError} If the mapped segment is smaller than the bump
     *   word, which the constructor does not check.
     */
    public getRecordBumpView(): Uint32Array {
        if (!this.recordBumpView) {
            this.recordBumpView = new Uint32Array(this.buffer, this.regions.recordStart - 8, 1);
        }
        return this.recordBumpView;
    }

    /**
     * Asks a daemon to snapshot. With no daemon attached the sentinel sits
     * in a ring nobody drains, so this reports success and nothing
     * persists.
     *
     * @returns True when the sentinel was queued.
     */
    public triggerCheckpoint(): boolean {
        return this.bindings.trigger_checkpoint() === 0;
    }

    /**
     * @param stringOffset - Absolute arena offset of the string fat
     *   pointer to relocate through.
     * @returns True when the vacuum thread started, false when the arena is
     *   not attached, the offset is out of range, one is already running,
     *   or the thread could not be spawned.
     */
    public startVacuum(stringOffset: number): boolean {
        return this.bindings.start_vacuum(stringOffset) === 0;
    }

    /**
     * @returns False when the addon predates `stop_vacuum`; otherwise true,
     *   because the native export is void and the bridge always reports 0.
     */
    public stopVacuum(): boolean {
        const fn = this.bindings.stop_vacuum;
        if (!fn) return false;
        return fn.call(this.bindings) === 0;
    }

    /**
     * Reference-counted engine detach. Safe to call per client: the shared
     * mapping stays valid while other clients hold it; teardown happens on
     * the last disconnect. Call at end of process/tests.
     *
     * @returns False when the addon predates `disconnect_shm`; otherwise
     *   true, because the native export is void and the bridge always
     *   reports 0. The return value does not tell you whether this call was
     *   the one that unmapped.
     */
    public shutdownEngine(): boolean {
        const fn = this.bindings.disconnect_shm;
        if (!fn) return false;
        return fn.call(this.bindings) === 0;
    }

    /**
     * Wraps one record so that property reads and writes address the arena
     * directly. There is no stored copy of the record, so two proxies over
     * the same offset always agree.
     *
     * Scalar writes are validated, written in place, and announced with
     * `pushDelta` as an inline message (tag 0, at most 48 bytes). String
     * writes bump-allocate the bytes in the string arena, announce them
     * with `notifyArena` (tag 1), then push the 8-byte fat pointer (tag 0)
     * as the mutation. That order is load-bearing: a daemon that observed
     * the new pointer before the bytes were announced would log a pointer
     * into memory the WAL has no record of.
     *
     * @param schema - The compiled record layout.
     * @param baseOffset - Absolute arena offset of the record's first byte.
     * @returns A proxy whose schema fields read and write that record.
     *   Properties outside the schema fall through to a plain object.
     * @throws {Error} If `baseOffset` is not a non-negative integer, or the
     *   record would extend past this arena's record region.
     * @throws {TypeError} If a string field is assigned a non-string, a
     *   `uint8` or `uint32` field a non-integer or an out-of-range number,
     *   or a `float64` field a non-number.
     * @throws {Error} If the string region configured for this arena is
   *   exhausted, or `notifyArena` or
     *   `pushDelta` returns nonzero because the ring is full.
     * @throws {Error} On read, if a stored string pointer addresses memory
     *   past the end of the mapping.
     */
    public createProxy<T extends Record<string, FieldType>>(
        schema: TakyonSchema<T>,
        baseOffset: number
    ): MappedObject<T> {
        if (!Number.isInteger(baseOffset) || baseOffset < 0) {
            throw new Error(`baseOffset out of range: ${baseOffset}`);
        }
        // The record region, not the mapping. An arena whose records end at
        // 2 MiB has index and strings behind that address, and a record
        // mapped there corrupts them without failing.
        const regions = this.regions;
        if (baseOffset + schema.totalSize > regions.recordStart + regions.recordBytes) {
            throw new Error(
                `record [${baseOffset}, ${baseOffset + schema.totalSize}) exceeds this arena's ` +
                    `record region, which ends at ${regions.recordStart + regions.recordBytes}`
            );
        }
        const bindings = this.bindings;
        const sharedView = this.view();
        const bumpView = this.stringBump();

        const targetBuffer = this.buffer;

        return new Proxy({} as MappedObject<T>, {
            get(target, prop: string | symbol) {
                if (typeof prop === 'string' && schema.fields[prop]) {
                    const field = schema.fields[prop];
                    const abs = baseOffset + field.offset;
                    if (field.type === 'string') {
                        const strOffset = sharedView.getUint32(abs, true);
                        const strLen = sharedView.getUint32(abs + 4, true);
                        // A zero fat pointer means "never written", not
                        // "at offset 0". Offset 0 is the ring header, so
                        // dereferencing it would corrupt head and tail.
                        if (strOffset === 0 && strLen === 0) return "";
                        if (strOffset + strLen > targetBuffer.byteLength) {
                            throw new Error(
                                `corrupt string pointer {offset: ${strOffset}, len: ${strLen}} exceeds shared memory`
                            );
                        }
                        const strBytes = new Uint8Array(targetBuffer, strOffset, strLen);
                        return sharedDecoder.decode(strBytes);
                    }

                    switch (field.type) {
                        case 'uint8': return sharedView.getUint8(abs);
                        case 'uint32': return sharedView.getUint32(abs, true); // little-endian
                        case 'float64': return sharedView.getFloat64(abs, true);
                    }
                }
                return Reflect.get(target, prop);
            },
            
            set(target, prop: string | symbol, value: any) {
                if (typeof prop === 'string' && schema.fields[prop]) {
                    const field = schema.fields[prop];
                    const abs = baseOffset + field.offset;
                    
                    if (field.type === 'string') {
                        if (typeof value !== 'string') {
                            throw new Error(`expected string for field, got ${typeof value}`);
                        }
                        if (value.length * 4 > encodeScratch.length) {
                            encodeScratch = new Uint8Array(value.length * 4);
                        }
                        const { written: strLen } = sharedEncoder.encodeInto(value, encodeScratch);

                        if (regions.stringStart + 4 >= targetBuffer.byteLength) {
                            throw new Error(
                                `shared memory (${targetBuffer.byteLength} bytes) too small for string arena at ${regions.stringStart}`
                            );
                        }
                        // Seed the bump on first use. A zero bump would hand
                        // out offset 0 (the ring header); the compare-and-set
                        // doubles as the check, so this costs one uncontended
                        // atomic on the hot path. Mirrors `allocString` in
                        // `src/core/c_abi/exports.zig`, which the C-ABI
                        // insert path uses for index keys.
                        Atomics.compareExchange(bumpView, 0, 0, stringDataStart(regions));
                        const allocatedOffset = Atomics.add(bumpView, 0, strLen);
                        if (allocatedOffset + strLen > regions.stringStart + regions.stringBytes) {
                            throw new Error("Out of string arena memory");
                        }

                        const dest = new Uint8Array(targetBuffer, allocatedOffset, strLen);
                        dest.set(encodeScratch.subarray(0, strLen));

                        // Tag 1 (arena) before tag 0 (inline). The daemon
                        // replays in ring order, so announcing the bytes
                        // first is what makes the pointer it records
                        // afterwards resolvable during recovery.
                        if (bindings.notifyArena(allocatedOffset, strLen) !== 0) {
                            throw new Error("notifyArena failed: ring buffer full or arena not mapped");
                        }

                        sharedView.setUint32(abs, allocatedOffset, true);
                        sharedView.setUint32(abs + 4, strLen, true);

                        scratchView.setUint32(0, allocatedOffset, true);
                        scratchView.setUint32(4, strLen, true);
                        if (bindings.pushDelta(abs, scratchU8_8) !== 0) {
                            throw new Error("pushDelta failed: ring buffer full");
                        }

                        return true;
                    }
                    
                    switch (field.type) {
                        case 'uint8':
                            if (!Number.isInteger(value) || value < 0 || value > 255) {
                                throw new Error(`uint8 out of range: ${value}`);
                            }
                            sharedView.setUint8(abs, value);
                            scratchView.setUint8(0, value);
                            if (bindings.pushDelta(abs, scratchU8_1) !== 0) {
                                throw new Error("pushDelta failed: ring buffer full");
                            }
                            break;
                        case 'uint32':
                            if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
                                throw new Error(`uint32 out of range: ${value}`);
                            }
                            sharedView.setUint32(abs, value, true);
                            scratchView.setUint32(0, value, true);
                            if (bindings.pushDelta(abs, scratchU8_4) !== 0) {
                                throw new Error("pushDelta failed: ring buffer full");
                            }
                            break;
                        case 'float64':
                            if (typeof value !== 'number') {
                                throw new Error(`float64 must be a number, got ${typeof value}`);
                            }
                            sharedView.setFloat64(abs, value, true);
                            scratchView.setFloat64(0, value, true);
                            if (bindings.pushDelta(abs, scratchU8_8) !== 0) {
                                throw new Error("pushDelta failed: ring buffer full");
                            }
                            break;
                    }

                    // A field wider than the inline payload would have to go
                    // through the string arena, which is not what a scalar
                    // assignment means. No current FieldType exceeds 8, so
                    // this cannot fire; it is the tripwire for a future type
                    // that would otherwise be silently written as a fat
                    // pointer the reader decodes as a number.
                    if (field.size > MAX_DELTA_INLINE) {
                        throw new Error(`field size ${field.size} exceeds inline delta capacity`);
                    }
                    return true;
                }
                return Reflect.set(target, prop, value);
            }
        });
    }
}
