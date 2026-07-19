/**
 * ============================================================================
 * File: proxy.ts
 * Description: Transparent JS Proxies for direct memory mutation using DataView.
 * Author/Maintainer: TakyonDB Team
 * License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
 * ============================================================================
 */

import { TakyonSchema, FieldType } from './schema';

export interface TakyonBindings {
    initSharedMemory(size: number): ArrayBuffer | null;
    pushDelta(offset: number, data: Uint8Array): number;
    notifyArena(offset: number, size: number): number;
    verifyTestValue(): number;
    insert_index(key: string, value_offset: number): number;
    search_index(key: string): number;
    trigger_checkpoint(): number;
    start_vacuum(string_offset: number): number;
}

export type MappedObject<T> = {
    [P in keyof T]: T[P] extends 'uint8' | 'uint32' | 'float64' ? number : (T[P] extends 'string' ? string : never);
};

export class TakyonClient {
    private buffer: ArrayBuffer;
    
    constructor(private bindings: TakyonBindings, size: number) {
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
    
    public createProxy<T extends Record<string, FieldType>>(
        schema: TakyonSchema<T>,
        baseOffset: number
    ): MappedObject<T> {
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
                        const strBytes = new Uint8Array(targetBuffer, strOffset, strLen);
                        return new TextDecoder('utf-8').decode(strBytes);
                    }
                    
                    switch (field.type) {
                        case 'uint8': return view.getUint8(field.offset);
                        case 'uint32': return view.getUint32(field.offset, true); // Little indian
                        case 'float64': return view.getFloat64(field.offset, true);
                    }
                }
                return Reflect.get(target, prop);
            },
            
            set(target, prop: string | symbol, value: any) {
                if (typeof prop === 'string' && schema.fields[prop]) {
                    const field = schema.fields[prop];
                    
                    if (field.type === 'string') {
                        const bytes = new TextEncoder().encode(value);
                        const strLen = bytes.length;
                        
                        const STRING_BUMP_OFFSET = 10485760; // 10MB
                        const STRING_ARENA_START = 10485764;
                        
                        const atomicArr = new Uint32Array(targetBuffer, STRING_BUMP_OFFSET, 1);
                        Atomics.compareExchange(atomicArr, 0, 0, STRING_ARENA_START);
                        const allocatedOffset = Atomics.add(atomicArr, 0, strLen);
                        
                        const dest = new Uint8Array(targetBuffer, allocatedOffset, strLen);
                        dest.set(bytes);
                        
                        bindings.notifyArena(allocatedOffset, strLen);
                        
                        view.setUint32(field.offset, allocatedOffset, true);
                        view.setUint32(field.offset + 4, strLen, true);
                        
                        const ptrBuf = new ArrayBuffer(8);
                        const ptrView = new DataView(ptrBuf);
                        ptrView.setUint32(0, allocatedOffset, true);
                        ptrView.setUint32(4, strLen, true);
                        bindings.pushDelta(baseOffset + field.offset, new Uint8Array(ptrBuf));
                        
                        return true;
                    }
                    
                    const tmpBuf = new ArrayBuffer(field.size);
                    const tmpView = new DataView(tmpBuf);

                    switch (field.type) {
                        case 'uint8': 
                            view.setUint8(field.offset, value);
                            tmpView.setUint8(0, value);
                            break;
                        case 'uint32': 
                            view.setUint32(field.offset, value, true);
                            tmpView.setUint32(0, value, true);
                            break;
                        case 'float64': 
                            view.setFloat64(field.offset, value, true);
                            tmpView.setFloat64(0, value, true);
                            break;
                    }
                    
                    bindings.pushDelta(baseOffset + field.offset, new Uint8Array(tmpBuf));
                    return true;
                }
                return Reflect.set(target, prop, value);
            }
        });
    }
}
