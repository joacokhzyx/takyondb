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
    trigger_checkpoint(): number;
    start_vacuum(string_offset: number): number;
    stop_vacuum?(): number;
}

export type MappedObject<T> = {
    [P in keyof T]: T[P] extends 'uint8' | 'uint32' | 'float64' ? number : (T[P] extends 'string' ? string : never);
};

export class TakyonClient {
    private buffer: ArrayBuffer;

    constructor(private bindings: TakyonBindings, size: number) {
        if (!Number.isInteger(size) || size <= 0) {
            throw new Error("size must be a positive integer");
        }
        const buf = this.bindings.initSharedMemory(size);
        if (!buf) throw new Error("Failed to map shared memory");
        this.buffer = buf;
    }
    
    public getBuffer() { return this.buffer; }
    public getBindings() { return this.bindings; }

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
        const view = new DataView(this.buffer, baseOffset, schema.totalSize);
        const bindings = this.bindings;

        const targetBuffer = this.buffer;
        
        return new Proxy({} as MappedObject<T>, {
            get(target, prop: string | symbol) {
                if (typeof prop === 'string' && schema.fields[prop]) {
                    const field = schema.fields[prop];
                    if (field.type === 'string') {
                        const strOffset = view.getUint32(field.offset, true);
                        const strLen = view.getUint32(field.offset + 4, true);
                        if (strOffset === 0 && strLen === 0) return "";
                        if (strOffset + strLen > targetBuffer.byteLength) {
                            throw new Error(
                                `corrupt string pointer {offset: ${strOffset}, len: ${strLen}} exceeds shared memory`
                            );
                        }
                        const strBytes = new Uint8Array(targetBuffer, strOffset, strLen);
                        return new TextDecoder('utf-8').decode(strBytes);
                    }

                    switch (field.type) {
                        case 'uint8': return view.getUint8(field.offset);
                        case 'uint32': return view.getUint32(field.offset, true); // little-endian
                        case 'float64': return view.getFloat64(field.offset, true);
                    }
                }
                return Reflect.get(target, prop);
            },
            
            set(target, prop: string | symbol, value: any) {
                if (typeof prop === 'string' && schema.fields[prop]) {
                    const field = schema.fields[prop];
                    
                    if (field.type === 'string') {
                        if (typeof value !== 'string') {
                            throw new Error(`expected string for field, got ${typeof value}`);
                        }
                        const bytes = new TextEncoder().encode(value);
                        const strLen = bytes.length;

                        if (STRING_DATA_START >= targetBuffer.byteLength) {
                            throw new Error(
                                `shared memory (${targetBuffer.byteLength} bytes) too small for string arena at ${STRING_DATA_START}`
                            );
                        }
                        const atomicArr = new Uint32Array(targetBuffer, STRING_BUMP_OFFSET, 1);
                        Atomics.compareExchange(atomicArr, 0, 0, STRING_DATA_START);
                        const allocatedOffset = Atomics.add(atomicArr, 0, strLen);
                        if (allocatedOffset + strLen > targetBuffer.byteLength) {
                            throw new Error("Out of string arena memory");
                        }

                        const dest = new Uint8Array(targetBuffer, allocatedOffset, strLen);
                        dest.set(bytes);

                        if (bindings.notifyArena(allocatedOffset, strLen) !== 0) {
                            throw new Error("notifyArena failed: ring buffer full or arena not mapped");
                        }

                        view.setUint32(field.offset, allocatedOffset, true);
                        view.setUint32(field.offset + 4, strLen, true);

                        const ptrBuf = new ArrayBuffer(8);
                        const ptrView = new DataView(ptrBuf);
                        ptrView.setUint32(0, allocatedOffset, true);
                        ptrView.setUint32(4, strLen, true);
                        if (bindings.pushDelta(baseOffset + field.offset, new Uint8Array(ptrBuf)) !== 0) {
                            throw new Error("pushDelta failed: ring buffer full");
                        }

                        return true;
                    }
                    
                    const tmpBuf = new ArrayBuffer(field.size);
                    const tmpView = new DataView(tmpBuf);

                    switch (field.type) {
                        case 'uint8':
                            if (!Number.isInteger(value) || value < 0 || value > 255) {
                                throw new Error(`uint8 out of range: ${value}`);
                            }
                            view.setUint8(field.offset, value);
                            tmpView.setUint8(0, value);
                            break;
                        case 'uint32':
                            if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
                                throw new Error(`uint32 out of range: ${value}`);
                            }
                            view.setUint32(field.offset, value, true);
                            tmpView.setUint32(0, value, true);
                            break;
                        case 'float64':
                            if (typeof value !== 'number') {
                                throw new Error(`float64 must be a number, got ${typeof value}`);
                            }
                            view.setFloat64(field.offset, value, true);
                            tmpView.setFloat64(0, value, true);
                            break;
                    }

                    if (field.size > MAX_DELTA_INLINE) {
                        throw new Error(`field size ${field.size} exceeds inline delta capacity`);
                    }
                    if (bindings.pushDelta(baseOffset + field.offset, new Uint8Array(tmpBuf)) !== 0) {
                        throw new Error("pushDelta failed: ring buffer full");
                    }
                    return true;
                }
                return Reflect.set(target, prop, value);
            }
        });
    }
}
