/**
 * Database fixtures.
 *
 * The worker's `db` is a module-level singleton (`db/db.ts`) that 22 modules
 * import directly. Rather than refactor all of them to take an injected
 * handle, tests run the real Dexie instance against `fake-indexeddb` (installed
 * in tests/setup.ts). That keeps the real schema, compound indexes and version
 * upgrades under test — which is exactly where the query bugs live.
 *
 * Call `resetDb()` in a `beforeEach` to get a clean database per test.
 */
import { db } from "db/db";

import type {
    IDBZoteroLibrary,
    IDBZoteroKey,
    AnyIDBZoteroItem,
    IDBZoteroCollection,
} from "types/db-schema";

/**
 * Drop and recreate every table. Runs the real version-upgrade chain, so a
 * broken `db.version(n)` block fails here rather than in production.
 */
export async function resetDb(): Promise<void> {
    if (db.isOpen()) db.close();
    await db.delete();
    await db.open();
}

const ISO = "2026-01-01T00:00:00.000Z";

/** Seed a library row. Versions default to 0 — i.e. never synced. */
export async function seedLibrary(
    overrides: Partial<IDBZoteroLibrary> & { id: number },
): Promise<IDBZoteroLibrary> {
    const library: IDBZoteroLibrary = {
        type: "user",
        name: `Library ${overrides.id}`,
        collectionVersion: 0,
        itemVersion: 0,
        syncedAt: ISO,
        ...overrides,
    };
    await db.libraries.put(library);
    return library;
}

/** Seed the API-key row that `startSync` reads before doing anything else. */
export async function seedKey(
    overrides: Partial<IDBZoteroKey> & { key: string; userID: number },
): Promise<IDBZoteroKey> {
    const keyRow = {
        username: "test-user",
        displayName: "Test User",
        access: { user: { library: true, files: true, notes: true, write: true } },
        joinedGroups: [],
        ...overrides,
    };
    await db.keys.put(keyRow);
    return keyRow;
}

/**
 * Seed an item. `raw` mirrors what the Zotero API returns, since sync pushes
 * `item.raw` straight back to the server.
 */
export async function seedItem(
    overrides: Partial<AnyIDBZoteroItem> & { libraryID: number; key: string },
): Promise<AnyIDBZoteroItem> {
    const { libraryID, key } = overrides;
    const item = {
        itemType: "journalArticle",
        parentItem: "",
        trashed: 0,
        title: `Item ${key}`,
        collections: [],
        dateAdded: ISO,
        dateModified: ISO,
        version: 1,
        searchCreators: [],
        searchTags: [],
        syncStatus: "synced",
        syncError: "",
        syncedAt: ISO,
        raw: {
            key,
            version: 1,
            library: { type: "user", id: libraryID, name: "Library" },
            data: {
                key,
                version: 1,
                itemType: "journalArticle",
                title: `Item ${key}`,
                dateAdded: ISO,
                dateModified: ISO,
                collections: [],
                tags: [],
                relations: {},
            },
        },
        ...overrides,
    } as unknown as AnyIDBZoteroItem;
    await db.items.put(item);
    return item;
}

/** Seed a collection row. */
export async function seedCollection(
    overrides: Partial<IDBZoteroCollection> & { libraryID: number; key: string },
): Promise<IDBZoteroCollection> {
    const { libraryID, key } = overrides;
    const collection = {
        version: 1,
        name: `Collection ${key}`,
        parentCollection: "",
        trashed: 0,
        syncStatus: "synced",
        syncedAt: ISO,
        syncError: "",
        raw: {
            key,
            version: 1,
            library: { type: "user", id: libraryID, name: "Library" },
            data: { key, version: 1, name: `Collection ${key}`, parentCollection: false },
        },
        ...overrides,
    } as unknown as IDBZoteroCollection;
    await db.collections.put(collection);
    return collection;
}

export { db };
