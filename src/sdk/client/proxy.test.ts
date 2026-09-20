/**
 * ============================================================================
 * File: proxy.test.ts
 * Description: Unit tests for TakyonClient/TakyonDB against a mocked
 *   N-API bridge backed by a plain ArrayBuffer.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { TakyonClient, TakyonBindings } from './proxy';
import { TakyonSchema } from './schema';
import { TakyonDB } from '../takyon';
import {
    RECORD_BUMP_INIT,
    RECORD_BUMP_OFFSET,
    STRING_BUMP_OFFSET,
    STRING_DATA_START,
} from './layout';

function mockBindings(size: number, store: Map<string, number>): TakyonBindings {
    const buffer = new ArrayBuffer(size);
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
    };
}

const UserDef = { username: 'string', age: 'uint32', score: 'float64' } as const;

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

    it('rejects out-of-range record mapping', () => {
        const store = new Map<string, number>();
        const client = new TakyonClient(mockBindings(1024, store), 1024);
        const schema = new TakyonSchema({ ...UserDef });
        expect(() => client.createProxy(schema, 4096)).toThrow();
    });

    it('stopVacuum tolerates bridges without the method', () => {
        const store = new Map<string, number>();
        const bindings = mockBindings(1024, store);
        delete bindings.stop_vacuum;
        const client = new TakyonClient(bindings, 1024);
        expect(client.stopVacuum()).toBe(false);
    });

    it('shutdownEngine tolerates bridges without the method', () => {
        const store = new Map<string, number>();
        const bindings = mockBindings(1024, store);
        delete bindings.disconnect_shm;
        const client = new TakyonClient(bindings, 1024);
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

        // 200 chars but 400 UTF-8 bytes ('é' is 2 bytes) — over the byte limit.
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
        // Namespaced isolation: deleting from one collection leaves the other intact.
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
