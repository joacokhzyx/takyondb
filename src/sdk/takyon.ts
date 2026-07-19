/**
 * ============================================================================
 * File: takyon.ts
 * Description: Fluent SDK for TakyonDB. Abstracting offsets/pointers and supporting collection-based syntax.
 * Author/Maintainer: TakyonDB Team
 * License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
 * ============================================================================
 */

import { TakyonClient, TakyonBindings, MappedObject } from './client/proxy';
import { TakyonSchema, FieldType } from './client/schema';

// Central record allocator inside the shared memory (after the RingBuffer and before String Arena)
// For simplicity we will allocate records starting at a fixed offset, e.g. 4096.
// In a full implementation, we'd have a free-list or bump allocator for records.
const RECORD_ARENA_START = 4096;
const MAX_RECORD_ARENA = 32768; // Up to string arena

export class Collection<T extends Record<string, FieldType>> {
    constructor(
        private db: TakyonDB,
        private name: string,
        private schema: TakyonSchema<T>
    ) {}

    /**
     * Inserts a new record into the collection and returns the proxy object.
     */
    public insert(key: string, data: Partial<MappedObject<T>>): MappedObject<T> {
        // Allocate offset for this record
        const offset = this.db.allocateRecordOffset(this.schema.totalSize);
        
        // Insert into ART index
        this.db.client.getBindings().insert_index(key, offset);
        
        // Create proxy
        const proxy = this.db.client.createProxy(this.schema, offset);
        
        // Initialize data
        for (const [k, v] of Object.entries(data)) {
            if (v !== undefined) {
                (proxy as any)[k] = v;
            }
        }
        
        return proxy;
    }

    /**
     * Finds a record by its exact string key using the Lock-Free ART index.
     */
    public find(key: string): MappedObject<T> | null {
        const offset = this.db.client.getBindings().search_index(key);
        if (offset === 0) return null; // 0 means not found
        
        return this.db.client.createProxy(this.schema, offset);
    }
}

export class TakyonDB {
    public readonly client: TakyonClient;
    private currentRecordOffset: number = RECORD_ARENA_START;

    constructor(bindings: TakyonBindings, memorySize: number = 64 * 1024) {
        this.client = new TakyonClient(bindings, memorySize);
    }

    /**
     * Creates or returns a reference to a Takyon collection.
     */
    public collection<T extends Record<string, FieldType>>(name: string, schema: TakyonSchema<T>): Collection<T> {
        return new Collection<T>(this, name, schema);
    }

    /**
     * Allocates memory for a new record.
     * @internal
     */
    public allocateRecordOffset(size: number): number {
        // We use a simple bump allocator for records for now
        // In a real implementation this would be backed by Atomics to be thread-safe
        // across multiple node instances.
        const atomicArr = new Uint32Array(this.client.getBuffer(), 2048, 1);
        Atomics.compareExchange(atomicArr, 0, 0, RECORD_ARENA_START);
        const allocatedOffset = Atomics.add(atomicArr, 0, size);
        
        if (allocatedOffset + size > MAX_RECORD_ARENA) {
            throw new Error("Out of record memory. Increase MAX_RECORD_ARENA.");
        }
        
        return allocatedOffset;
    }
}
