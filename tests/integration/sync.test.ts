/**
 * SyncService against the fake Zotero server.
 *
 * Nothing here is mocked at the service boundary: the real `ZoteroAPIService`,
 * the real `zotero-api-client`, the real Dexie schema and the real sync code
 * all run. Only the network (fake server on `globalThis.fetch`) and the main
 * thread (`FakeParentHost`) are substituted.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SyncService } from "worker/services/sync";
import { ZoteroAPIService } from "worker/services/zotero";
import { LibraryService } from "worker/services/library";
import { DEFAULT_SETTINGS } from "settings/types";

import { db, resetDb, seedKey, seedLibrary, seedItem } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import { createFakeZoteroServer } from "../fakes/zotero-server";

import type { FakeParentHost } from "../fakes/parent-host";
import type { FakeZoteroServer } from "../fakes/zotero-server";
import type { LibrarySyncMode, ZotFlowSettings } from "settings/types";

const API_KEY = "TESTKEY";
const USER_ID = 1;

let server: FakeZoteroServer;
let host: FakeParentHost;
let sync: SyncService;
let settings: ZotFlowSettings;

async function setup(mode: LibrarySyncMode = "bidirectional") {
    await resetDb();
    await seedKey({ key: API_KEY, userID: USER_ID });
    await seedLibrary({ id: USER_ID, type: "user", name: "My Library" });

    settings = {
        ...DEFAULT_SETTINGS,
        zoteroapikey: API_KEY,
        librariesConfig: { [USER_ID]: { mode } },
    };

    host = createFakeParentHost();
    server = createFakeZoteroServer({ apiKey: API_KEY, userID: USER_ID });
    server.install();

    sync = new SyncService(
        new ZoteroAPIService(API_KEY),
        settings,
        host,
        new LibraryService(settings, host),
    );
}

afterEach(() => server.restore());

describe("pull", () => {
    beforeEach(() => setup());

    test("first sync pulls every item and records the library version", async () => {
        const lib = server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "First" } });
        lib.addItem({ key: "BBBBBBBB", data: { title: "Second" } });

        const result = await sync.startSync();

        expect(result.failCount).toBe(0);
        expect(result.successCount).toBe(1);
        expect(result.syncedLibraryIDs).toEqual([USER_ID]);

        const stored = await db.items.toArray();
        expect(stored.map((i) => i.key).sort()).toEqual(["AAAAAAAA", "BBBBBBBB"]);
        expect(stored.every((i) => i.syncStatus === "synced")).toBe(true);
        expect(stored.find((i) => i.key === "AAAAAAAA")!.title).toBe("First");

        const libRow = await db.libraries.get(USER_ID);
        expect(libRow!.itemVersion).toBe(lib.version);
    });

    test("pulls collections into their own table", async () => {
        server.library(USER_ID).addCollection({
            key: "CCCCCCCC",
            data: { name: "Papers" },
        });

        await sync.startSync();

        const collections = await db.collections.toArray();
        expect(collections).toHaveLength(1);
        expect(collections[0]!.name).toBe("Papers");
        expect(collections[0]!.syncStatus).toBe("synced");
    });

    test("second sync is a no-op when nothing changed remotely", async () => {
        server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await sync.startSync();

        server.clearRequests();
        await sync.startSync();

        // The delta probe still runs, but no batch fetch follows it.
        const batchFetches = server
            .requestsFor("/items")
            .filter((r) => r.query.has("itemKey"));
        expect(batchFetches).toHaveLength(0);
        expect(await db.items.count()).toBe(1);
    });

    test("incremental sync only fetches items newer than the stored version", async () => {
        const lib = server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await sync.startSync();

        lib.addItem({ key: "BBBBBBBB", data: { title: "Added later" } });
        server.clearRequests();
        await sync.startSync();

        const batchFetch = server
            .requestsFor("/items")
            .find((r) => r.query.has("itemKey"));
        expect(batchFetch!.query.get("itemKey")).toBe("BBBBBBBB");
        expect(await db.items.count()).toBe(2);
    });

    test("batches the item fetch at PULL_BULK_SIZE", async () => {
        const lib = server.library(USER_ID);
        // 101 items -> two batch requests (100 + 1).
        for (let i = 0; i < 101; i++) {
            lib.addItem({ key: `KEY${String(i).padStart(5, "0")}` });
        }

        await sync.startSync();

        const batchFetches = server
            .requestsFor("/items")
            .filter((r) => r.query.has("itemKey"));
        expect(batchFetches).toHaveLength(2);
        expect(batchFetches[0]!.query.get("itemKey")!.split(",")).toHaveLength(100);
        expect(batchFetches[1]!.query.get("itemKey")!.split(",")).toHaveLength(1);
        expect(await db.items.count()).toBe(101);
    });

    test("a remotely deleted item is removed locally", async () => {
        const lib = server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        lib.addItem({ key: "BBBBBBBB" });
        await sync.startSync();
        expect(await db.items.count()).toBe(2);

        lib.deleteItem("AAAAAAAA");
        await sync.startSync();

        expect((await db.items.toArray()).map((i) => i.key)).toEqual(["BBBBBBBB"]);
    });

    test("a locally edited item hit by a remote edit is flagged as a conflict", async () => {
        const lib = server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Original" } });
        await sync.startSync();

        // Local edit that has not been pushed yet.
        await db.items.update([USER_ID, "AAAAAAAA"], {
            syncStatus: "updated",
            title: "My local title",
        });
        // …and a competing remote edit.
        lib.updateItem("AAAAAAAA", { title: "Remote title" });

        await sync.startSync();

        const stored = await db.items.get([USER_ID, "AAAAAAAA"]);
        expect(stored!.syncStatus).toBe("conflict");
        expect(stored!.title).toBe("My local title");
        expect((stored!.serverCopyRaw as any).data.title).toBe("Remote title");
    });

    test("offline aborts before any request is made", async () => {
        const original = navigator.onLine;
        Object.defineProperty(navigator, "onLine", {
            value: false,
            configurable: true,
        });
        try {
            await expect(sync.startSync()).rejects.toThrow(/offline/i);
            expect(server.requests).toHaveLength(0);
        } finally {
            Object.defineProperty(navigator, "onLine", {
                value: original,
                configurable: true,
            });
        }
    });

    test("an aborted signal short-circuits the whole run", async () => {
        server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        const controller = new AbortController();
        controller.abort();

        const result = await sync.startSync(controller.signal);

        expect(result).toEqual({
            successCount: 0,
            failCount: 0,
            changedItems: [],
            syncedLibraryIDs: [],
        });
        expect(server.requests).toHaveLength(0);
    });

    test("a failing library is reported, not thrown", async () => {
        server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        server.failNext({ status: 500, pathIncludes: "/collections" });

        const result = await sync.startSync();

        expect(result.failCount).toBe(1);
        expect(result.successCount).toBe(0);
        expect(host.notices.some((n) => n.type === "error")).toBe(true);
    });
});

describe("push", () => {
    beforeEach(() => setup("bidirectional"));

    test("locally created items are posted and marked synced", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
            title: "Drafted locally",
        });

        await sync.startSync();

        const posts = server
            .requestsFor("/items")
            .filter((r) => r.method === "POST");
        expect(posts).toHaveLength(1);
        expect(server.library(USER_ID).items.has("NEWITEM1")).toBe(true);

        const stored = await db.items.get([USER_ID, "NEWITEM1"]);
        expect(stored!.syncStatus).toBe("synced");
        expect(stored!.version).toBeGreaterThan(0);
    });

    test("locally deleted items are deleted remotely and dropped locally", async () => {
        server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await sync.startSync();
        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });

        await sync.startSync();

        expect(server.library(USER_ID).items.has("AAAAAAAA")).toBe(false);
        expect(await db.items.get([USER_ID, "AAAAAAAA"])).toBeUndefined();
    });

    test("a 412 on delete flags the item as a conflict", async () => {
        const lib = server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await sync.startSync();

        // Local delete, then a competing remote edit bumps the item version.
        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });
        lib.updateItem("AAAAAAAA", { title: "Remote edit" });
        // Freeze the local version so the delete carries a stale precondition.
        await db.items.update([USER_ID, "AAAAAAAA"], { version: 1 });

        await sync.startSync();

        const stored = await db.items.get([USER_ID, "AAAAAAAA"]);
        expect(stored!.syncStatus).toBe("conflict");
        expect(lib.items.has("AAAAAAAA")).toBe(true);
    });

    test("readonly libraries never push", async () => {
        await setup("readonly");
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });

        await sync.startSync();

        expect(
            server.requests.filter((r) => r.method === "POST"),
        ).toHaveLength(0);
        expect(server.library(USER_ID).items.has("NEWITEM1")).toBe(false);
    });
});
