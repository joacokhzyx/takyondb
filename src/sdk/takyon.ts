/**
 * ============================================================================
 * File: takyon.ts
 * Description: Fluent SDK for TakyonDB. Abstracting offsets/pointers and supporting collection-based syntax.
 * Author/Maintainer: TakyonDB Team
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { TakyonClient, TakyonBindings, MappedObject } from './client/proxy';
import { TakyonSchema, FieldType } from './client/schema';
import {
    ART_ROOT_OFFSET,
    MAX_KEY_LEN,
    RECORD_BUMP_INIT,
    RECORD_BUMP_OFFSET,
    RECORD_START,
} from './client/layout';

// Fixed-length records grow from RECORD_START up to the ART index.
// The bump word lives at RECORD_BUMP_OFFSET (see layout.zig); there must be
// exactly one record bump shared by all clients.
const MAX_RECORD_ARENA = ART_ROOT_OFFSET;

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
        if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LEN) {
            throw new Error(`key must be 1..${MAX_KEY_LEN} chars`);
        }
        // Allocate offset for this record
        const offset = this.db.allocateRecordOffset(this.schema.totalSize);

        // Insert into ART index
        if (this.db.client.getBindings().insert_index(key, offset) !== 0) {
            throw new Error(`insert_index failed for key '${key}'`);
        }
        
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
        // C-ABI returns -1 for "not found" (and for invalid offsets).
        if (offset < 0) return null;
        
        return this.db.client.createProxy(this.schema, offset);
    }
}

export class TakyonDB {
    public readonly client: TakyonClient;
    private currentRecordOffset: number = RECORD_START;

    constructor(bindings: TakyonBindings, memorySize: number = 64 * 1024 * 1024) {
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
        if (!Number.isInteger(size) || size <= 0) {
            throw new Error(`record size must be positive, got ${size}`);
        }
        // Single shared bump word (see layout.zig). Atomics make the
        // allocation itself thread-safe; reclaiming freed records is future work.
        const atomicArr = new Uint32Array(this.client.getBuffer(), RECORD_BUMP_OFFSET, 1);
        Atomics.compareExchange(atomicArr, 0, 0, RECORD_BUMP_INIT);
        const allocatedOffset = Atomics.add(atomicArr, 0, size);
        
        if (allocatedOffset + size > MAX_RECORD_ARENA) {
            throw new Error("Out of record memory. Increase MAX_RECORD_ARENA.");
        }
        
        return allocatedOffset;
    }
}
