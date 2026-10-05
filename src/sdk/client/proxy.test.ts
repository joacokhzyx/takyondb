import { describe, expect, it } from 'vitest';
import { BackpressureError, TakyonClient, TakyonBindings } from './proxy';
import { TakyonSchema } from './schema';
import { TakyonDB } from '../takyon';
import {
    RECORD_BUMP_INIT,
    RECORD_BUMP_OFFSET,
    STRING_BUMP_OFFSET,
    STRING_DATA_START,
    defaultRegions,
    writeRegions,
} from './layout';

function mockBindings(size: number, store: Map<string, number>): TakyonBindings {
    const buffer = new ArrayBuffer(size);
    // A real arena carries a header, so the fixture writes one. The SDK
    // refuses a segment without a table, which is the right behaviour: a
    // client that guessed the regions would write into the index.
    const regions = defaultRegions(size);
    writeRegions(buffer, regions);
    // Pre-seed bump words the way a fresh arena looks (when they fit).
    const view = new DataView(buffer);
    if (RECORD_BUMP_OFFSET + 4 <= size) view.setUint32(RECORD_BUMP_OFFSET, RECORD_BUMP_INIT, true);
    if (STRING_BUMP_OFFSET + 4 <= size) view.setUint32(STRING_BUMP_OFFSET, STRING_DATA_START, true);
    return {
        initSharedMemory: () => buffer,
        pushDelta: () => 0,
        notifyArena: () => 0,
        verifyTestValue: () => 0,
        insert_index: (key: string, value_offset: number) => {
            store.set(key, value_offset);
            return 0;
        },
        search_index: (key: string) => store.get(key) ?? -1,
        remove_index: (key: string) => (store.delete(key) ? 1 : 0),
        trigger_checkpoint: () => 0,
        start_vacuum: () => 0,
        stop_vacuum: () => 0,
        disconnect_shm: () => 0,
        commit: () => 0,
        ringStats: () => ({
            saturated_total: 0,
            saturated_wait_ns: 0,
            dropped_total: 0,
            durable_tail: 0,
        }),
    };
}

const UserDef = { username: 'string', age: 'uint32', score: 'float64' } as const;

/** A bridge whose commit/ringStats behaviour the test dictates. */
function bindingsWith(overrides: Partial<TakyonBindings>, store = new Map<string, number>()): TakyonBindings {
    return { ...mockBindings(16 * 1024 * 1024, store), ...overrides };
}

describe('durability contract', () => {
    it('commit() forwards its timeout and passes through the native code', () => {
        const seen: number[] = [];
        const db = new TakyonDB(bindingsWith({ commit: (ms: number) => (seen.push(ms), 0) }), 16 * 1024 * 1024);
        db.client.commit(1234);
        expect(seen).toEqual([1234]);
        // A second call with no argument uses the documented default rather
        // than whatever the previous caller passed.
        db.client.commit();
        expect(seen).toEqual([1234, 5000]);
    });

    it('commit() reports an expired wait as BackpressureError, not as a failure', () => {
        const db = new TakyonDB(bindingsWith({ commit: () => -2 }), 16 * 1024 * 1024);
        let thrown: unknown;
        try {
            db.client.commit(10);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(BackpressureError);
        // The distinguishing property: the bytes are in memory, the log does
        // not have them. A caller branches on this to decide whether
        // retrying is safe.
        expect((thrown as BackpressureError).durable).toBe(false);
        expect((thrown as BackpressureError).detail.code).toBe(-2);
    });

    it('commit() says durability is impossible when nothing is logging', () => {
        const db = new TakyonDB(bindingsWith({ commit: () => -3 }), 16 * 1024 * 1024);
        // Deliberately NOT a BackpressureError: nothing is full, nothing is
        // slow, and a caller that applies back-pressure here would wait
        // forever for a flusher that does not exist.
        expect(() => db.client.commit()).toThrow(/durab/i);
        expect(() => db.client.commit()).not.toThrow(BackpressureError);
    });

    it('commit() fails loudly on an addon that predates it', () => {
        const legacy = mockBindings(16 * 1024 * 1024, new Map<string, number>());
        delete (legacy as { commit?: unknown }).commit;
        const db = new TakyonDB(legacy, 16 * 1024 * 1024);
        // Silence here would be the worst outcome available: a caller would
        // believe writes were durable because a call it made returned.
        expect(() => db.client.commit()).toThrow(/newer TakyonDB addon/);
        // The same addon still works for everything that does not need it.
        expect(db.client.ringStats().durable_tail).toBe(0);
    });

    it('a refused index write surfaces as BackpressureError through insert()', () => {
        // The typed error has to survive the whole path, not just the bridge:
        // `Collection.insert` is what an application calls, and a generic
        // Error there is what made "retry" and "the write never happened"
        // look like the same option.
        const db = new TakyonDB(bindingsWith({ insert_index: () => -2 }), 16 * 1024 * 1024);
        const users = db.collection('users', new TakyonSchema({ ...UserDef }));
        expect(() => users.insert('user_1', { age: 30 })).toThrow(BackpressureError);

        // A refusal for any other reason stays a plain Error, so a caller
        // cannot mistake an invalid key for something worth retrying.
        const bad = new TakyonDB(bindingsWith({ insert_index: () => -1 }), 16 * 1024 * 1024);
        const other = bad.collection('users', new TakyonSchema({ ...UserDef }));
        expect(() => other.insert('user_1', { age: 30 })).not.toThrow(BackpressureError);
    });

    it('a refused field write surfaces as BackpressureError, not as a generic push failure', () => {
        // Flipped after the insert, because the insert's own field write
        // would be refused first and the test would prove nothing about a
        // later assignment.
        let refuse = false;
        const db = new TakyonDB(bindingsWith({ pushDelta: () => (refuse ? -2 : 0) }), 16 * 1024 * 1024);
        const users = db.collection('users', new TakyonSchema({ ...UserDef }));
        const alice = users.insert('user_1', { age: 30 });
        refuse = true;
        expect(() => {
            alice.score = 1.5;
        }).toThrow(BackpressureError);
        // The in-place write happened before the refusal: Takyon writes to
        // the mapping first, so the value is readable even though the log
        // refused to record it. That is precisely the state the error
        // describes.
        expect(alice.score).toBe(1.5);
    });

    it('ringStats() reads the counters and defaults absent ones to zero', () => {
        const db = new TakyonDB(
            bindingsWith({
                ringStats: () => ({ saturated_total: 7, saturated_wait_ns: 12_000, dropped_total: 1, durable_tail: 900 }),
            }),
            16 * 1024 * 1024
        );
        expect(db.client.ringStats()).toEqual({
            saturated_total: 7,
            saturated_wait_ns: 12_000,
            dropped_total: 1,
            durable_tail: 900,
        });

        const partial = mockBindings(16 * 1024 * 1024, new Map<string, number>());
        delete (partial as { ringStats?: unknown }).ringStats;
        const db2 = new TakyonDB(partial, 16 * 1024 * 1024);
        expect(db2.client.ringStats()).toEqual({
            saturated_total: 0,
            saturated_wait_ns: 0,
            dropped_total: 0,
            durable_tail: 0,
        });
    });
});

describe('TakyonDB with mocked bridge', () => {
    it('inserts, finds and round-trips scalar fields', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        const alice = users.insert('user_123', { age: 28, score: 1500.5 });
        expect(alice.age).toBe(28);
        expect(alice.score).toBe(1500.5);

        const found = users.find('user_123');
        expect(found?.age).toBe(28);
        expect(db.client.getBindings().search_index('users:user_123')).toBeGreaterThanOrEqual(0);
    });

    it('round-trips string fields through the string arena', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        users.insert('u1', { username: 'Alice' });
        expect(users.find('u1')?.username).toBe('Alice');
    });

    it('returns null for missing keys and rejects bad input', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        expect(users.find('nope')).toBeNull();
        expect(() => users.insert('', { age: 1 })).toThrow();
        const uint8schema = new TakyonSchema({ flag: 'uint8' });
        const uint8users = db.collection('flags', uint8schema);
        const fproxy = uint8users.insert('f1', { flag: 1 });
        expect(() => ((fproxy as Record<string, unknown>).flag = 300)).toThrow();
        expect(() => ((fproxy as Record<string, unknown>).flag = -1)).toThrow();
        const proxy = users.insert('u2', { age: 30 });
        expect(() => ((proxy as Record<string, unknown>).age = -1)).toThrow();
        expect(() => ((proxy as Record<string, unknown>).username = 42)).toThrow();
    });

    it('rejects a record that would run past the record region', () => {
        // The bound is the record region the arena's header declares, not
        // the end of the mapping: an arena whose records end at 2 MiB has
        // 62 MiB of index and strings behind them, and writing a record
        // there would corrupt the index.
        const size = 16 * 1024 * 1024;
        const store = new Map<string, number>();
        const client = new TakyonClient(mockBindings(size, store), size);
        const schema = new TakyonSchema({ ...UserDef });
        const regions = client.getRegions();
        expect(() => client.createProxy(schema, regions.artRoot)).toThrow();
    });

    it('refuses a segment that carries no region table', () => {
        // A client that fell back to the constants would be writing where
        // the daemon put the index, so a header-less segment is refused at
        // attach rather than tolerated.
        const store = new Map<string, number>();
        const bare = new ArrayBuffer(16 * 1024 * 1024);
        const bindings = mockBindings(16 * 1024 * 1024, store);
        bindings.initSharedMemory = () => bare;
        expect(() => new TakyonClient(bindings, bare.byteLength)).toThrow(/not a Takyon arena/);
    });

    it('stopVacuum tolerates bridges without the method', () => {
        const store = new Map<string, number>();
        const bindings = mockBindings(16 * 1024 * 1024, store);
        delete bindings.stop_vacuum;
        const client = new TakyonClient(bindings, 16 * 1024 * 1024);
        expect(client.stopVacuum()).toBe(false);
    });

    it('shutdownEngine tolerates bridges without the method', () => {
        const store = new Map<string, number>();
        const bindings = mockBindings(16 * 1024 * 1024, store);
        delete bindings.disconnect_shm;
        const client = new TakyonClient(bindings, 16 * 1024 * 1024);
        expect(client.shutdownEngine()).toBe(false);
    });

    it('namespaces keys by collection name', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);
        const orders = db.collection('orders', schema);

        users.insert('shared', { age: 1 });
        orders.insert('shared', { age: 2 });

        // Same raw key in two collections must not collide.
        expect(store.has('users:shared')).toBe(true);
        expect(store.has('orders:shared')).toBe(true);
        expect(store.has('shared')).toBe(false);
        expect(users.find('shared')?.age).toBe(1);
        expect(orders.find('shared')?.age).toBe(2);
    });

    it('rejects empty collection names', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        expect(() => db.collection('', schema)).toThrow();
    });

    it('rejects keys containing NUL', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        expect(() => users.insert('a\0b', { age: 1 })).toThrow();
        expect(users.find('a\0b')).toBeNull();
        expect(store.has('users:a\0b')).toBe(false);
    });

    it('rejects keys over the char or byte length limit', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        const tooLongChars = 'a'.repeat(257);
        expect(() => users.insert(tooLongChars, { age: 1 })).toThrow();
        expect(users.find(tooLongChars)).toBeNull();

        // 200 chars but 400 UTF-8 bytes ('é' is 2 bytes), over the byte
        // limit.
        const tooLongBytes = 'é'.repeat(200);
        expect(tooLongBytes.length).toBeLessThanOrEqual(256);
        expect(() => users.insert(tooLongBytes, { age: 1 })).toThrow();
        expect(users.find(tooLongBytes)).toBeNull();

        // Boundary: exactly 256 chars / 256 bytes is accepted.
        const maxKey = 'a'.repeat(256);
        users.insert(maxKey, { age: 7 });
        expect(users.find(maxKey)?.age).toBe(7);
    });

    it('deletes an existing key and find returns null after', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        users.insert('alice', { age: 28 });
        expect(store.has('users:alice')).toBe(true);
        expect(users.delete('alice')).toBe(true);
        expect(store.has('users:alice')).toBe(false);
        expect(users.find('alice')).toBeNull();
    });

    it('delete returns false for missing keys', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        expect(users.delete('nope')).toBe(false);
        // Namespaced isolation: deleting from one collection leaves the
        // other intact.
        const orders = db.collection('orders', schema);
        users.insert('shared', { age: 1 });
        orders.insert('shared', { age: 2 });
        expect(users.delete('shared')).toBe(true);
        expect(users.find('shared')).toBeNull();
        expect(orders.find('shared')?.age).toBe(2);
    });

    it('delete throws on invalid keys and bridge errors', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        expect(() => users.delete('')).toThrow();
        expect(() => users.delete('a\0b')).toThrow();
        expect(() => users.delete('a'.repeat(257))).toThrow();

        const errStore = new Map<string, number>();
        const errBindings = mockBindings(64 * 1024 * 1024, errStore);
        errBindings.remove_index = () => -1;
        const errDb = new TakyonDB(errBindings, 64 * 1024 * 1024);
        const errUsers = errDb.collection('users', schema);
        expect(() => errUsers.delete('alice')).toThrow();
    });

    it('updates existing records and returns null when missing', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        users.insert('alice', { username: 'Alice', age: 28, score: 10 });
        const updated = users.update('alice', { age: 29, score: 20.5 });
        expect(updated?.age).toBe(29);
        expect(updated?.score).toBe(20.5);
        expect(updated?.username).toBe('Alice');
        expect(users.find('alice')?.age).toBe(29);

        expect(users.update('missing', { age: 1 })).toBeNull();
        expect(users.update('a\0b', { age: 1 })).toBeNull();
    });

    it('upserts: creates when missing, updates when present', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        const created = users.upsert('bob', { age: 30, score: 5 });
        expect(created.created).toBe(true);
        expect(created.proxy.age).toBe(30);
        expect(users.find('bob')?.age).toBe(30);

        const offsetBefore = store.get('users:bob');
        const updated = users.upsert('bob', { age: 31 });
        expect(updated.created).toBe(false);
        expect(updated.proxy.age).toBe(31);
        expect(users.find('bob')?.age).toBe(31);
        // Update is in place: same index offset, no duplicate record.
        expect(store.get('users:bob')).toBe(offsetBefore);
    });

    it('does not reclaim record bytes on delete (bump only grows)', () => {
        const store = new Map<string, number>();
        const db = new TakyonDB(mockBindings(64 * 1024 * 1024, store), 64 * 1024 * 1024);
        const schema = new TakyonSchema({ ...UserDef });
        const users = db.collection('users', schema);

        users.insert('first', { age: 1 });
        const firstOffset = store.get('users:first');
        expect(firstOffset).toBeGreaterThanOrEqual(0);
        expect(users.delete('first')).toBe(true);

        users.insert('second', { age: 2 });
        const secondOffset = store.get('users:second');
        expect(secondOffset).toBeGreaterThanOrEqual(0);
        // Bump allocator never reuses the freed slot: strictly higher offset.
        expect(secondOffset).toBeGreaterThan(firstOffset as number);
        expect(secondOffset).not.toBe(firstOffset);
    });
});
