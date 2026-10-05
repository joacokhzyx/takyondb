/**
 * The fluent surface over the client: a schema-compiled `TakyonDB` and the
 * `Collection`s that namespace the shared ART index.
 */

import { TakyonClient, TakyonBindings, MappedObject, utf8ByteLength } from './client/proxy';
import { TakyonSchema, FieldType } from './client/schema';
import { loadBindings } from './client/addon';
import { MAX_KEY_LEN } from './client/layout';

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
//
// The namespace is a plain prefix, not a length-prefixed escape, so a
// collection name containing a colon can be made to collide with a
// differently-named collection's key. `collection()` rejects NUL but not
// `:`, so a name is trusted input.
/**
 * Rows of one schema, addressed by key. Every method maps the caller's
 * key through the collection's namespace before it reaches the shared ART
 * index, so two collections never see each other's rows.
 *
 * A collection is created by `TakyonDB.collection` and holds no state of
 * its own beyond the name and schema: the rows live in the arena.
 */
export class Collection<T extends Record<string, FieldType>> {
    /**
     * @param db - The owning database, used for record allocation.
     * @param name - The key namespace, already validated by
     *   `TakyonDB.collection`.
     * @param schema - The compiled record layout for rows in this
     *   collection.
     */
    constructor(
        private db: TakyonDB,
        private name: string,
        private schema: TakyonSchema<T>
    ) {}

    private namespacedKey(key: string): string {
        return `${this.name}:${key}`;
    }

    /**
     * Inserts a new record and returns the live proxy over it.
     *
     * The order is allocate, index, then fill. The index entry is what
     * makes the record findable, so publishing it before the fields are
     * written would expose a zero-filled row to a concurrent `find`. It
     * also means a failed field assignment leaves an indexed record behind;
     * the arena is bump-allocated and nothing reclaims it.
     *
     * Durability depends on the engine, not on this call. The binding is
     * only replayable from the WAL when a daemon owns the data directory;
     * with no daemon the key is in shared memory and nothing else, so it is
     * lost on restart even though this returned successfully. See
     * `TakyonBindings.insert_index`.
     *
     * @param key - 1 to 256 characters, NUL-free, and at most 256 UTF-8
     *   bytes.
     * @param data - Field values to write. `undefined` entries are skipped,
     *   so a partial object leaves the rest of the record as mapped memory,
     *   which is zeros for a freshly allocated record.
     * @returns The proxy over the new record.
     * @throws {Error} If the key is empty, over the length or byte limit, or
     *   contains a NUL.
     * @throws {Error} If the record arena is exhausted.
     * @throws {Error} If `insert_index` returns nonzero, which covers a
     *   full ring, an exhausted string arena, and an ART insert failure.
     * @throws {TypeError} If a field is assigned a value of the wrong
     *   JavaScript type for its schema type.
     */
    public insert(key: string, data: Partial<MappedObject<T>>): MappedObject<T> {
        const invalid = keyError(key);
        if (invalid) {
            throw new Error(invalid);
        }
        const namespaced = this.namespacedKey(key);
        const offset = this.db.allocateRecordOffset(this.schema.totalSize);

        if (this.db.client.getBindings().insert_index(namespaced, offset) !== 0) {
            throw new Error(`insert_index failed for key '${key}'`);
        }

        const proxy = this.db.client.createProxy(this.schema, offset);

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
     *
     * The returned proxy is live and unversioned: two finds of the same key
     * return two proxies over the same bytes, and a delete does not
     * invalidate either. The index is the only authority on whether a record
     * exists, so a record whose bytes were never written still resolves.
     *
     * @param key - The key, namespaced with the collection name.
     * @returns The proxy, or `null` when the key is invalid or absent.
     *   `search_index` also returns -1 for a stored offset at or above
     *   `0x7FFFFFFF`, which is reserved so it cannot alias this answer.
     * @throws {RangeError} If the key passes the character check but the
     *   bridge rejects its UTF-8 byte length. `keyError` bounds both, so
     *   this is unreachable through `insert`-shaped input.
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
     *
     * @param key - The key, namespaced with the collection name.
     * @returns True when the key was present, false when it was not.
     * @throws {Error} If the key is empty, over the length or byte limit, or
     *   contains a NUL. Unlike `find`, `delete` rejects an invalid key
     *   rather than reporting it as absent.
     * @throws {RangeError} If the key passes the character check but the
     *   bridge rejects its UTF-8 byte length.
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
     *
     * Every assignment is a separate arena allocation for a string field:
     * the previous bytes are abandoned, not reused.
     *
     * @param key - The key, namespaced with the collection name.
     * @param data - Field values to write; `undefined` entries are skipped.
     * @returns The proxy, or `null` when the key is invalid or absent. No
     *   field is written in that case.
     * @throws {Error} If the string arena is exhausted, or the ring is full
     *   when `pushDelta` or `notifyArena` reports failure.
     * @throws {TypeError} If a field is assigned a value of the wrong
     *   JavaScript type.
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
     * Returns the proxy plus a flag saying whether a new record was
     * created.
     *
     * The lookup and the insert are not atomic. Two concurrent upserts of
     * the same missing key can both take the insert branch, and the second
     * `insert_index` overwrites the first binding while the first
     * allocation is leaked in the record arena.
     *
     * @param key - The key, namespaced with the collection name.
     * @param data - Field values to write; `undefined` entries are skipped.
     * @returns The proxy, and `created` true when this call allocated the
     *   record and false when it updated an existing one.
     * @throws The same errors as `insert`.
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

/**
 * Owns one mapped engine segment and hands out namespaced collections over
 * it. The relational engine (`client/relational`) is independent of this
 * class and needs no mapping.
 */
export class TakyonDB {
    /**
     * The client over the mapped segment, exposed so callers can reach the
     * index and pushdown bindings that `TakyonDB` does not wrap.
     */
    public readonly client: TakyonClient;

    /**
     * @param bindings - Native addon bindings. Optional: when omitted the
     *   bundled N-API addon is located and loaded automatically (see
     *   `loadBindings`). Pass it explicitly to inject a mock, a
     *   pre-resolved addon, or a test double.
     * @param memorySize - Segment size in bytes. The default is 64 MiB; the
     *   bridge accepts 1 byte to 1 GiB, and `layout.ts` needs room for the
     *   ring, the ART root at 2 MiB, and the string arena at 10 MiB.
     * @throws {Error} If no bindings are supplied and no addon is found, or
     *   if the mapping fails.
     * @throws {RangeError} If `memorySize` is outside the bridge's accepted
     *   range.
     */
    constructor(
        bindings?: TakyonBindings,
        memorySize: number = 64 * 1024 * 1024,
    ) {
        // Lazy import shape: the loader reaches for the filesystem, so it is
        // only pulled in when a caller actually needs the native addon. The
        // relational engine (tables, queries, SQL) never touches this path.
        const resolved = bindings ?? loadBindings();
        this.client = new TakyonClient(resolved, memorySize);
    }

    /**
     * Creates a collection, namespacing its keys in the shared ART index.
     *
     * Returns a new object every call; there is no interning, so two
     * collections of the same name address the same keys through two
     * instances and can both mutate them.
     *
     * @param name - The key namespace. Must be non-empty and NUL-free.
     * @param schema - The compiled record layout for rows here.
     * @returns A collection over this database.
     * @throws {Error} If `name` is not a non-empty string, or contains a
     *   NUL. A colon is accepted, which lets a name be chosen that collides
     *   with another collection's namespaced keys.
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
     * Bump-allocates `size` bytes of record arena.
     *
     * The bump word is process-wide, not per database, so two `TakyonDB`
     * instances in one process share one record space. Nothing moves the
     * word backwards, so the space is consumed permanently even after
     * `Collection.delete`.
     *
     * @param size - Record size in bytes, matching `schema.totalSize`.
     * @returns The absolute arena offset of the allocation.
     * @throws {Error} If `size` is not a positive integer, or the
     *   allocation would run into the region the arena's header says the
     *   index begins at. That limit is the record region this arena was
     *   configured with; a larger arena only helps if its record region
     *   was configured larger too.
     * @internal
     */
    public allocateRecordOffset(size: number): number {
        if (!Number.isInteger(size) || size <= 0) {
            throw new Error(`record size must be positive, got ${size}`);
        }
        const regions = this.client.getRegions();
        // Single shared bump word (see layout.zig). Atomics make the
        // allocation itself thread-safe across workers. The view is
        // pooled on the client, so an insert allocates no view.
        const atomicArr = this.client.getRecordBumpView();
        Atomics.compareExchange(atomicArr, 0, 0, regions.recordStart);
        const allocatedOffset = Atomics.add(atomicArr, 0, size);

        if (allocatedOffset + size > regions.recordStart + regions.recordBytes) {
            throw new Error(
                `Out of record memory: this arena's record region is ` +
                    `${regions.recordBytes} bytes. Raise "regions": { "record_bytes": N } ` +
                    'in takyon.json and restart the daemon.',
            );
        }

        return allocatedOffset;
    }
}
