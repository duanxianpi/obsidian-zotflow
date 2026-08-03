/**
 * The push half of a sync: which local rows are eligible, what the request
 * body looks like after sanitization, and how each bucket of the Zotero write
 * response (`successful` / `unchanged` / `failed`) is folded back into the DB.
 */
import { describe, test, expect, afterEach } from "vitest";
import { db, seedItem } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
afterEach(() => h?.dispose());

/** The body of the single POST the run made. */
function postedPayload(harness: SyncHarness): Record<string, any>[] {
    const posts = harness.server.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    return posts[0]!.body as Record<string, any>[];
}

describe("eligibility", () => {
    test("a clean library posts nothing", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });

        await h.sync.startSync();

        expect(h.server.requests.filter((r) => r.method === "POST")).toHaveLength(
            0,
        );
    });

    test("only created/updated/deleted rows are pushed", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "CREATED1", syncStatus: "created" });
        await seedItem({ libraryID: USER_ID, key: "UPDATED1", syncStatus: "updated" });
        await seedItem({ libraryID: USER_ID, key: "SYNCED01", syncStatus: "synced" });
        await seedItem({ libraryID: USER_ID, key: "IGNORED1", syncStatus: "ignore" });
        await seedItem({ libraryID: USER_ID, key: "CONFLIC1", syncStatus: "conflict" });

        await h.sync.startSync();

        expect(postedPayload(h).map((i) => i.key).sort()).toEqual([
            "CREATED1",
            "UPDATED1",
        ]);
    });

    test("notes are held back when the key lacks notes permission", async () => {
        h = await createSyncHarness({
            access: {
                user: { library: true, files: true, notes: false, write: true },
            },
        });
        await seedItem({
            libraryID: USER_ID,
            key: "NOTEITEM",
            itemType: "note",
            syncStatus: "created",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "ARTICLE1",
            syncStatus: "created",
        });

        await h.sync.startSync();

        expect(postedPayload(h).map((i) => i.key)).toEqual(["ARTICLE1"]);
        expect(
            h.host.logsAt("warn").some((l) => /Skipping 1 dirty note item/.test(l.message)),
        ).toBe(true);
        // Held back, not dropped: it can sync once permissions change.
        expect((await db.items.get([USER_ID, "NOTEITEM"]))!.syncStatus).toBe(
            "created",
        );
    });

    test("upserts are chunked at UPDATE_BULK_SIZE", async () => {
        h = await createSyncHarness();
        // 51 items -> two writes (50 + 1).
        for (let i = 0; i < 51; i++) {
            await seedItem({
                libraryID: USER_ID,
                key: `NEW${String(i).padStart(5, "0")}`,
                syncStatus: "created",
            });
        }

        await h.sync.startSync();

        const posts = h.server.requests.filter((r) => r.method === "POST");
        expect(posts).toHaveLength(2);
        expect(posts[0]!.body as unknown[]).toHaveLength(50);
        expect(posts[1]!.body as unknown[]).toHaveLength(1);
        expect(h.server.library(USER_ID).items.size).toBe(51);
    });
});

describe("request payload", () => {
    test("a created item is sent without a version so the server assigns one", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
        });

        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent!.key).toBe("NEWITEM1");
        expect(sent!.data.key).toBe("NEWITEM1");
        expect(sent).not.toHaveProperty("version");
        expect(sent!.data).not.toHaveProperty("version");
    });

    test("an updated item carries its version for optimistic locking", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();
        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "updated" });

        h.server.clearRequests();
        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent!.version).toBe(stored.version);
        expect(sent!.data.version).toBe(stored.version);
    });

    test("the stored version wins over a stale one in the raw payload", async () => {
        // The row's `version` column is authoritative — it is what the server
        // checks for optimistic locking. Copying `raw` alone is not enough,
        // because the two can disagree; if the stale one were sent, a
        // concurrent edit on the server would be silently overwritten.
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "AAAAAAAA",
            syncStatus: "updated",
            version: 42,
            raw: {
                key: "AAAAAAAA",
                version: 7,
                library: { type: "user", id: USER_ID, name: "Library" },
                data: {
                    key: "AAAAAAAA",
                    version: 7,
                    itemType: "journalArticle",
                    title: "Item AAAAAAAA",
                    dateAdded: "2020-01-01T00:00:00Z",
                    dateModified: "2020-01-01T00:00:00Z",
                    collections: [],
                    tags: [],
                    relations: {},
                },
            } as never,
        });

        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent!.version).toBe(42);
        expect(sent!.data.version).toBe(42);
    });

    test("dateModified is stamped and dateAdded normalized to Zotero's format", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            raw: {
                key: "NEWITEM1",
                data: {
                    key: "NEWITEM1",
                    itemType: "journalArticle",
                    dateAdded: "2020-03-04T05:06:07.891Z",
                    dateModified: "2020-03-04T05:06:07.891Z",
                },
            } as any,
        });

        await h.sync.startSync();

        const [sent] = postedPayload(h);
        const ZOTERO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
        expect(sent!.data.dateAdded).toBe("2020-03-04T05:06:07Z");
        expect(sent!.data.dateModified).toMatch(ZOTERO_DATE);
        expect(sent!.data.dateModified).not.toBe("2020-03-04T05:06:07Z");
    });

    test("annotationIsExternal is stripped — it is a local-only flag", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "ANNOTAT1",
            itemType: "annotation",
            syncStatus: "created",
            raw: {
                key: "ANNOTAT1",
                data: {
                    key: "ANNOTAT1",
                    itemType: "annotation",
                    annotationType: "highlight",
                    annotationIsExternal: true,
                },
            } as any,
        });

        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent!.data).not.toHaveProperty("annotationIsExternal");
        expect(sent!.data.annotationType).toBe("highlight");
    });
});

describe("write response handling", () => {
    test("a successful create is marked synced and adopts the server version", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
            title: "Drafted locally",
        });

        await h.sync.startSync();

        expect(h.server.library(USER_ID).items.has("NEWITEM1")).toBe(true);
        const stored = (await db.items.get([USER_ID, "NEWITEM1"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.syncError).toBeUndefined();
        expect(stored.version).toBe(h.server.library(USER_ID).version);
    });

    test("a successful update is marked synced and adopts the server version", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();
        const before = (await db.items.get([USER_ID, "AAAAAAAA"]))!.version;

        await db.items.update([USER_ID, "AAAAAAAA"], {
            syncStatus: "updated",
        });
        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.syncError).toBeUndefined();
        expect(stored.version).toBe(lib.version);
        expect(stored.version).not.toBe(before);
    });

    test("the server's echoed payload replaces the stored raw", async () => {
        // The write response is authoritative: the server may normalise or
        // add fields, and a local raw left behind would resurface as a phantom
        // change on the next diff.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], {
            syncStatus: "updated",
        });
        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        // The server bumps the version on every write; the stored raw has to
        // carry that, not the version it was pushed with.
        expect(stored.raw.version).toBe(lib.version);
        expect(stored.raw.data.version).toBe(lib.version);
    });

    test("an item the server reports unchanged keeps its version", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();
        const before = (await db.items.get([USER_ID, "AAAAAAAA"]))!.version;

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "updated" });
        lib.treatAsUnchanged("AAAAAAAA");
        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.version).toBe(before);
    });

    test("a per-item failure becomes a conflict carrying the server's reason", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });
        h.server
            .library(USER_ID)
            .rejectWrite("NEWITEM1", { code: 400, message: "Invalid field" });

        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "NEWITEM1"]))!;
        expect(stored.syncStatus).toBe("conflict");
        expect(stored.syncError).toBe("400: Invalid field");
        expect(
            h.host.logsAt("warn").some((l) => /Item failed NEWITEM1/.test(l.message)),
        ).toBe(true);
    });

    test("a failed update becomes a conflict too, not just a failed create", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "updated" });
        lib.rejectWrite("AAAAAAAA", { code: 412, message: "Version mismatch" });

        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("conflict");
        expect(stored.syncError).toBe("412: Version mismatch");
    });

    test("one failure does not spoil the rest of its batch", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "GOODITEM", syncStatus: "created" });
        await seedItem({ libraryID: USER_ID, key: "BADITEM1", syncStatus: "created" });
        h.server
            .library(USER_ID)
            .rejectWrite("BADITEM1", { code: 400, message: "nope" });

        await h.sync.startSync();

        expect((await db.items.get([USER_ID, "GOODITEM"]))!.syncStatus).toBe(
            "synced",
        );
        expect((await db.items.get([USER_ID, "BADITEM1"]))!.syncStatus).toBe(
            "conflict",
        );
    });

    test("a server-assigned key replaces the local row rather than duplicating it", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "LOCALKEY",
            syncStatus: "created",
            title: "Drafted locally",
        });
        h.server.library(USER_ID).remapKey("LOCALKEY", "SERVERKY");

        await h.sync.startSync();

        expect(await db.items.get([USER_ID, "LOCALKEY"])).toBeUndefined();
        const stored = (await db.items.get([USER_ID, "SERVERKY"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.raw.key).toBe("SERVERKY");
        expect(await db.items.count()).toBe(1);
    });

    test("the library version advances to the write's version", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });

        await h.sync.startSync();

        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(
            h.server.library(USER_ID).version,
        );
    });

    test("a dropped connection mid-write leaves the item dirty", async () => {
        // No `.response` on the error, so the 412 check reads `e.code` instead
        // of a status — it must not be mistaken for a version conflict.
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });
        h.server.failNext({
            networkError: true,
            pathIncludes: "/items",
            method: "POST",
        });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(0);
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe(
            "created",
        );
        // Not a 412: no retry was attempted.
        expect(h.server.requests.filter((r) => r.method === "POST")).toHaveLength(
            1,
        );
    });

    test("a batch that errors out is logged and leaves the item dirty", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });
        h.server.failNext({ status: 500, pathIncludes: "/items", method: "POST" });

        const result = await h.sync.startSync();

        // A single batch failing must not fail the library.
        expect(result.failCount).toBe(0);
        expect(
            h.host.logsAt("error").some((l) => /Batch upload failed/.test(l.message)),
        ).toBe(true);
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe(
            "created",
        );
    });
});

describe("deletions", () => {
    test("a locally deleted item is removed remotely and locally", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();
        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });

        await h.sync.startSync();

        expect(h.server.library(USER_ID).items.has("AAAAAAAA")).toBe(false);
        expect(await db.items.get([USER_ID, "AAAAAAAA"])).toBeUndefined();
    });

    test("the delete carries If-Unmodified-Since-Version", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();
        const version = (await db.items.get([USER_ID, "AAAAAAAA"]))!.version;
        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });

        h.server.clearRequests();
        await h.sync.startSync();

        const del = h.server.requests.find((r) => r.method === "DELETE")!;
        expect(del.headers.get("If-Unmodified-Since-Version")).toBe(
            String(version),
        );
    });

    test("a 412 on delete flags the item as a conflict and keeps the remote copy", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });
        // Forced rather than provoked through version arithmetic: a remote edit
        // large enough to make the server 412 would also be seen by the pull,
        // which claims the item first (see the test below).
        h.server.failNext({ status: 412, method: "DELETE" });

        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("conflict");
        expect(stored.syncError).toMatch(/modified since you deleted it/i);
        expect(lib.items.has("AAAAAAAA")).toBe(true);
    });

    test("a remote edit to a locally deleted item is caught by the pull, not the delete", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });
        lib.updateItem("AAAAAAAA", { title: "Remote edit" });

        h.server.clearRequests();
        await h.sync.startSync();

        // Pull runs first, sees a dirty local row, and parks the server copy.
        // Push then skips it: "conflict" is not an eligible status, so no
        // DELETE is ever attempted and the remote item survives.
        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("conflict");
        expect(stored.syncError).toBe("Remote update conflict");
        expect((stored.serverCopyRaw as any).data.title).toBe("Remote edit");
        expect(h.server.requests.filter((r) => r.method === "DELETE")).toHaveLength(
            0,
        );
        expect(lib.items.has("AAAAAAAA")).toBe(true);
    });

    test("a 404 on delete means someone got there first — drop it locally", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });
        h.server.failNext({ status: 404, method: "DELETE" });

        await h.sync.startSync();

        expect(await db.items.get([USER_ID, "AAAAAAAA"])).toBeUndefined();
    });

    test("any other delete error leaves the row dirty for the next run", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });
        h.server.failNext({ status: 500, method: "DELETE" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(0); // one item must not fail the library
        expect((await db.items.get([USER_ID, "AAAAAAAA"]))!.syncStatus).toBe(
            "deleted",
        );
        expect(
            h.host.logsAt("error").some((l) => /Failed to delete AAAAAAAA/.test(l.message)),
        ).toBe(true);
    });

    test("a dropped connection mid-delete is treated like any other error", async () => {
        // A network failure surfaces without `.response`, so the status falls
        // through to `e.code || 0` — a different branch from an HTTP error.
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });
        h.server.failNext({ networkError: true, method: "DELETE" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(0);
        expect((await db.items.get([USER_ID, "AAAAAAAA"]))!.syncStatus).toBe(
            "deleted",
        );
    });

    test("deletions and upserts travel in the same run", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "deleted" });
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });

        await h.sync.startSync();

        const lib = h.server.library(USER_ID);
        expect(lib.items.has("AAAAAAAA")).toBe(false);
        expect(lib.items.has("NEWITEM1")).toBe(true);
        expect((await db.items.toArray()).map((i) => i.key)).toEqual(["NEWITEM1"]);
    });
});
