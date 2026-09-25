/**
 * ============================================================================
 * File: takyon.ts
 * Description: Fluent SDK for TakyonDB. Abstracting offsets/pointers and supporting collection-based syntax.
 * Author/Maintainer: TakyonDB Team
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { TakyonClient, TakyonBindings, MappedObject, utf8ByteLength } from './client/proxy';
import { TakyonSchema, FieldType } from './client/schema';
import {
    ART_ROOT_OFFSET,
    MAX_KEY_LEN,
    RECORD_BUMP_INIT,
    RECORD_START,
} from './client/layout';

// Fixed-length records grow from RECORD_START up to the ART index.
// The bump word lives at RECORD_BUMP_OFFSET (see layout.zig); there must be
// exactly one record bump shared by all clients.
const MAX_RECORD_ARENA = ART_ROOT_OFFSET;

// The engine ART index requires NUL-free keys, and takyon_insert_index /
// takyon_search_index accept at most MAX_KEY_LEN bytes. JS string length
// counts UTF-16 code units, so validate both the character count and the
// UTF-8 byte length.
function keyError(key: unknown): string | null {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LEN) {
        return `key must be 1..${MAX_KEY_LEN} chars`;
    }
    if (key.includes('\0')) {
        return 'key must not contain NUL (\\0) characters';
    }
    if (utf8ByteLength(key) > MAX_KEY_LEN) {
        return `key must be <= ${MAX_KEY_LEN} UTF-8 bytes`;
    }
    return null;
}

// Collection keys are namespaced as `${name}:${key}` before hitting the
// shared ART index so that two collections can use the same raw key without
// colliding (e.g. `users:alice` vs `orders:alice`).
export class Collection<T extends Record<string, FieldType>> {
    constructor(
        private db: TakyonDB,
        private name: string,
        private schema: TakyonSchema<T>
    ) {}

    private namespacedKey(key: string): string {
        return `${this.name}:${key}`;
    }

    /**
     * Inserts a new record into the collection and returns the proxy object.
     */
    public insert(key: string, data: Partial<MappedObject<T>>): MappedObject<T> {
        const invalid = keyError(key);
        if (invalid) {
            throw new Error(invalid);
        }
        const namespaced = this.namespacedKey(key);
        // Allocate offset for this record
        const offset = this.db.allocateRecordOffset(this.schema.totalSize);

        // Insert into ART index
        if (this.db.client.getBindings().insert_index(namespaced, offset) !== 0) {
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
     * Invalid keys (empty, too long, or containing NUL) return null instead
     * of throwing, mirroring the C-ABI "not found" path.
     */
    public find(key: string): MappedObject<T> | null {
        if (keyError(key)) return null;
        const namespaced = this.namespacedKey(key);
        const offset = this.db.client.getBindings().search_index(namespaced);
        // C-ABI returns -1 for "not found" (and for invalid offsets).
        if (offset < 0) return null;
        
        return this.db.client.createProxy(this.schema, offset);
    }

    /**
     * Deletes a record by key. Returns true iff the bridge reports the key
     * was present (1), false when the key is missing (0), and throws on
     * bridge errors (-1).
     *
     * Note: record/string bytes are NOT reclaimed. The engine uses bump
     * allocators for both arenas; vacuum compacts strings while deleted
     * record slots await GC, so the record bump word only ever grows.
     */
    public delete(key: string): boolean {
        const invalid = keyError(key);
        if (invalid) {
            throw new Error(invalid);
        }
        const namespaced = this.namespacedKey(key);
        const rc = this.db.client.getBindings().remove_index(namespaced);
        if (rc === 1) return true;
        if (rc === 0) return false;
        throw new Error(`remove_index failed for key '${key}'`);
    }

    /**
     * Updates fields of an existing record in place. Field assignment goes
     * through the live proxy (same loop as insert), so string/scalar
     * deltas are emitted as usual. Returns the proxy, or null if missing
     * (including invalid keys, mirroring find). Proxy write failures
     * (pushDelta/notifyArena) throw.
     */
    public update(key: string, data: Partial<MappedObject<T>>): MappedObject<T> | null {
        const proxy = this.find(key);
        if (!proxy) return null;
        for (const [k, v] of Object.entries(data)) {
            if (v !== undefined) {
                (proxy as any)[k] = v;
            }
        }
        return proxy;
    }

    /**
     * Inserts when the key is missing, otherwise updates in place.
     * Returns the proxy plus a flag indicating whether a new record was created.
     */
    public upsert(key: string, data: Partial<MappedObject<T>>): { proxy: MappedObject<T>; created: boolean } {
        const existing = this.find(key);
        if (!existing) {
            return { proxy: this.insert(key, data), created: true };
        }
        for (const [k, v] of Object.entries(data)) {
            if (v !== undefined) {
                (existing as any)[k] = v;
            }
        }
        return { proxy: existing, created: false };
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
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error('collection name must be a non-empty string');
        }
        if (name.includes('\0')) {
            throw new Error('collection name must not contain NUL (\\0) characters');
        }
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
        // The view is pooled on the client: no per-insert allocation.
        const atomicArr = this.client.getRecordBumpView();
        Atomics.compareExchange(atomicArr, 0, 0, RECORD_BUMP_INIT);
        const allocatedOffset = Atomics.add(atomicArr, 0, size);
        
        if (allocatedOffset + size > MAX_RECORD_ARENA) {
            throw new Error("Out of record memory. Increase MAX_RECORD_ARENA.");
        }
        
        return allocatedOffset;
    }
}
