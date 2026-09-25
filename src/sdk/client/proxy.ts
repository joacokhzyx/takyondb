/**
 * ============================================================================
 * File: proxy.ts
 * Description: Transparent JS Proxies for direct memory mutation using DataView.
 * Author/Maintainer: TakyonDB Team
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { TakyonSchema, FieldType } from './schema';
import {
    MAX_DELTA_INLINE,
    RECORD_BUMP_OFFSET,
    STRING_BUMP_OFFSET,
    STRING_DATA_START,
} from './layout';

export interface TakyonBindings {
    initSharedMemory(size: number): ArrayBuffer | null;
    pushDelta(offset: number, data: Uint8Array): number;
    notifyArena(offset: number, size: number): number;
    verifyTestValue(): number;
    insert_index(key: string, value_offset: number): number;
    search_index(key: string): number;
    remove_index(key: string): number;
    scan_prefix?(prefix: string, max_results?: number): Uint32Array;
    scan_range?(prefix: string, lo?: string, hi?: string, max_results?: number): Uint32Array;
    filter_u32?(values: Uint32Array, op: number, target: number): Uint32Array;
    filter_f64?(values: Float64Array, op: number, target: number): Uint32Array;
    agg_sum?(values: Float64Array): number;
    agg_sum_selected?(values: Float64Array, sel: Uint32Array): number;
    agg_min_selected?(values: Float64Array, sel: Uint32Array): number;
    agg_max_selected?(values: Float64Array, sel: Uint32Array): number;
    verify_record?(buf: Uint8Array): boolean;
    scrub_records?(buf: Uint8Array): { ok: number; corrupt: number; bytes: number; truncated: boolean };
    trigger_checkpoint(): number;
    start_vacuum(string_offset: number): number;
    stop_vacuum?(): number;
    disconnect_shm?(): number;
}

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

/** UTF-8 byte length without allocating the encoded copy (shared scratch). */
export function utf8ByteLength(s: string): number {
    if (s.length * 4 > encodeScratch.length) encodeScratch = new Uint8Array(s.length * 4);
    return sharedEncoder.encodeInto(s, encodeScratch).written;
}

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
    private recordBumpView?: Uint32Array;

    constructor(private bindings: TakyonBindings, size: number) {
        if (!Number.isInteger(size) || size <= 0) {
            throw new Error("size must be a positive integer");
        }
        const buf = this.bindings.initSharedMemory(size);
        if (!buf) throw new Error("Failed to map shared memory");
        this.buffer = buf;
    }

    private view(): DataView {
        if (!this.sharedView) this.sharedView = new DataView(this.buffer);
        return this.sharedView;
    }

    private stringBump(): Uint32Array {
        if (!this.bumpView) this.bumpView = new Uint32Array(this.buffer, STRING_BUMP_OFFSET, 1);
        return this.bumpView;
    }
    
    public getBuffer() { return this.buffer; }
    public getBindings() { return this.bindings; }
    public getRecordBumpView(): Uint32Array {
        if (!this.recordBumpView) {
            this.recordBumpView = new Uint32Array(this.buffer, RECORD_BUMP_OFFSET, 1);
        }
        return this.recordBumpView;
    }

    public triggerCheckpoint(): boolean {
        return this.bindings.trigger_checkpoint() === 0;
    }

    public startVacuum(stringOffset: number): boolean {
        return this.bindings.start_vacuum(stringOffset) === 0;
    }

    public stopVacuum(): boolean {
        const fn = this.bindings.stop_vacuum;
        if (!fn) return false;
        return fn.call(this.bindings) === 0;
    }

    /**
     * Reference-counted engine detach. Safe to call per client: the shared
     * mapping stays valid while other clients hold it; teardown happens on
     * the last disconnect. Call at end of process/tests.
     */
    public shutdownEngine(): boolean {
        const fn = this.bindings.disconnect_shm;
        if (!fn) return false;
        return fn.call(this.bindings) === 0;
    }
    
    public createProxy<T extends Record<string, FieldType>>(
        schema: TakyonSchema<T>,
        baseOffset: number
    ): MappedObject<T> {
        if (!Number.isInteger(baseOffset) || baseOffset < 0) {
            throw new Error(`baseOffset out of range: ${baseOffset}`);
        }
        if (baseOffset + schema.totalSize > this.buffer.byteLength) {
            throw new Error(
                `record [${baseOffset}, ${baseOffset + schema.totalSize}) exceeds shared memory (${this.buffer.byteLength} bytes)`
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

                        if (STRING_DATA_START >= targetBuffer.byteLength) {
                            throw new Error(
                                `shared memory (${targetBuffer.byteLength} bytes) too small for string arena at ${STRING_DATA_START}`
                            );
                        }
                        Atomics.compareExchange(bumpView, 0, 0, STRING_DATA_START);
                        const allocatedOffset = Atomics.add(bumpView, 0, strLen);
                        if (allocatedOffset + strLen > targetBuffer.byteLength) {
                            throw new Error("Out of string arena memory");
                        }

                        const dest = new Uint8Array(targetBuffer, allocatedOffset, strLen);
                        dest.set(encodeScratch.subarray(0, strLen));

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
