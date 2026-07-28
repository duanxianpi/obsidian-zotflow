/**
 * ConflictService — what the Activity Center shows for a stuck row, and what
 * resolving it does to the DB.
 *
 * The stakes are asymmetric: "keep local" must leave a row the next push can
 * actually upload (wrong version → a permanent 412 loop), and "accept remote"
 * must not silently discard a row the server still has.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { ConflictService } from "worker/services/conflict";
import { db, resetDb, seedItem, seedCollection, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";

import type { FakeParentHost } from "../fakes/parent-host";

const LIB = 1;
const GROUP = 777;

let host: FakeParentHost;
let conflict: ConflictService;

beforeEach(async () => {
    await resetDb();
    await seedLibrary({ id: LIB, type: "user", name: "My Library" });
    host = createFakeParentHost();
    conflict = new ConflictService(host);
});

afterEach(() => vi.restoreAllMocks());

/** A conflicted item with both sides present. */
async function conflictedItem(over: Record<string, unknown> = {}) {
    await seedItem({
        libraryID: LIB,
        key: "ARTICLE1",
        syncStatus: "conflict",
        syncError: "Remote update conflict",
        title: "Local title",
        version: 7,
        raw: {
            key: "ARTICLE1",
            version: 3,
            data: {
                key: "ARTICLE1",
                version: 3,
                itemType: "journalArticle",
                title: "Local title",
                pages: "1-10",
            },
        } as any,
        serverCopyRaw: {
            key: "ARTICLE1",
            version: 7,
            data: {
                key: "ARTICLE1",
                version: 7,
                itemType: "journalArticle",
                title: "Remote title",
                pages: "1-10",
                publisher: "Remote Press",
            },
        } as any,
        ...over,
    } as any);
}

async function conflictedCollection(over: Record<string, unknown> = {}) {
    await seedCollection({
        libraryID: LIB,
        key: "COLL0001",
        syncStatus: "conflict",
        syncError: "Remote update conflict",
        name: "Local name",
        version: 7,
        raw: {
            key: "COLL0001",
            version: 3,
            data: { key: "COLL0001", version: 3, name: "Local name" },
        } as any,
        serverCopyRaw: {
            key: "COLL0001",
            version: 7,
            data: { key: "COLL0001", version: 7, name: "Remote name" },
        } as any,
        ...over,
    } as any);
}

describe("listing conflicts", () => {
    test("only conflicted rows are reported", async () => {
        await conflictedItem();
        await seedItem({ libraryID: LIB, key: "SYNCED01", syncStatus: "synced" });
        await seedItem({ libraryID: LIB, key: "UPDATED1", syncStatus: "updated" });

        const conflicts = await conflict.getItemConflicts();
        expect(conflicts.map((c) => c.key)).toEqual(["ARTICLE1"]);
    });

    test("every library is scanned", async () => {
        await seedLibrary({ id: GROUP, type: "group", name: "Group" });
        await conflictedItem();
        await seedItem({
            libraryID: GROUP,
            key: "GROUPITM",
            syncStatus: "conflict",
        });

        const conflicts = await conflict.getItemConflicts();
        expect(conflicts.map((c) => c.key).sort()).toEqual([
            "ARTICLE1",
            "GROUPITM",
        ]);
    });

    test("a titleless item is labelled by type and key", async () => {
        await seedItem({
            libraryID: LIB,
            key: "ANNOTAT1",
            itemType: "annotation",
            title: "",
            syncStatus: "conflict",
        });

        const [info] = await conflict.getItemConflicts();
        expect(info!.title).toBe("annotation (ANNOTAT1)");
    });

    test("a read failure is reported as a DB error", async () => {
        vi.spyOn(db.libraries, "toArray").mockRejectedValue(new Error("boom"));
        await expect(conflict.getItemConflicts()).rejects.toThrow(
            /Failed to query item conflicts/i,
        );
    });

    test("a read failure on the collection side is reported too", async () => {
        vi.spyOn(db.libraries, "toArray").mockRejectedValue(new Error("boom"));
        await expect(conflict.getCollectionConflicts()).rejects.toThrow(
            /Failed to query collection conflicts/i,
        );
    });
});

describe("conflict classification", () => {
    test("both sides changed is an update conflict", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();
        expect(info!.conflictType).toBe("update");
    });

    test("no server copy means the remote deleted it", async () => {
        await conflictedItem({ serverCopyRaw: undefined });
        const [info] = await conflict.getItemConflicts();
        expect(info!.conflictType).toBe("delete");
    });

    test("a 412 in the error marks it as a failed push", async () => {
        await conflictedItem({ syncError: "Library modified (412)" });
        const [info] = await conflict.getItemConflicts();
        expect(info!.conflictType).toBe("push");
    });

    test("a `code: message` error marks it as a failed push", async () => {
        // This is the shape pushDirtyItems writes for a per-item failure.
        await conflictedItem({ syncError: "400: Invalid field" });
        const [info] = await conflict.getItemConflicts();
        expect(info!.conflictType).toBe("push");
    });
});

describe("field diffs", () => {
    test("only differing fields are listed", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();

        const fields = Object.fromEntries(
            info!.fields.map((f) => [f.field, [f.localValue, f.remoteValue]]),
        );
        expect(fields.title).toEqual(["Local title", "Remote title"]);
        // Present on the remote only.
        expect(fields.publisher).toEqual(["(undefined)", "Remote Press"]);
        // Identical on both sides.
        expect(fields).not.toHaveProperty("pages");
    });

    test("key and version are never shown as differences", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();
        expect(info!.fields.map((f) => f.field)).not.toContain("key");
        expect(info!.fields.map((f) => f.field)).not.toContain("version");
    });

    test("a remote deletion is shown as a whole-item diff", async () => {
        await conflictedItem({ serverCopyRaw: undefined });
        const [info] = await conflict.getItemConflicts();

        expect(info!.fields).toHaveLength(1);
        expect(info!.fields[0]!.field).toBe("(entire item)");
        expect(info!.fields[0]!.remoteValue).toBe("(deleted on server)");
        expect(info!.fields[0]!.localValue).toContain("Local title");
    });

    test("a missing local payload is shown as a whole-item diff", async () => {
        await conflictedItem({ raw: undefined });
        const [info] = await conflict.getItemConflicts();

        expect(info!.fields[0]!.localValue).toBe("(no local data)");
        expect(info!.fields[0]!.remoteValue).toContain("Remote title");
    });

    test("neither side having data yields no diff rather than a crash", async () => {
        await conflictedItem({ raw: undefined, serverCopyRaw: undefined });
        const [info] = await conflict.getItemConflicts();
        expect(info!.fields).toEqual([]);
    });

    test("structured values are stringified for display", async () => {
        await conflictedItem({
            raw: {
                key: "ARTICLE1",
                data: { key: "ARTICLE1", tags: [{ tag: "local" }], extra: null },
            },
            serverCopyRaw: {
                key: "ARTICLE1",
                data: { key: "ARTICLE1", tags: [{ tag: "remote" }], extra: 42 },
            },
        });
        const [info] = await conflict.getItemConflicts();

        const fields = Object.fromEntries(
            info!.fields.map((f) => [f.field, [f.localValue, f.remoteValue]]),
        );
        expect(fields.tags![0]).toContain('"tag": "local"');
        expect(fields.extra).toEqual(["(null)", "42"]);
    });
});

describe("resolving an item", () => {
    test("keep-local queues the row for the next push", async () => {
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.syncStatus).toBe("updated");
        expect(stored.syncError).toBe("");
        expect(stored.serverCopyRaw).toBeUndefined();
        expect(stored.title).toBe("Local title");
    });

    test("keep-local stamps the server version into the payload", async () => {
        // Without this the next push sends a stale
        // If-Unmodified-Since-Version and 412s forever.
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.version).toBe(7);
        expect((stored.raw as any).version).toBe(7);
        expect((stored.raw as any).data.version).toBe(7);
    });

    test("accept-remote replaces the row and re-derives its fields", async () => {
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.syncError).toBe("");
        expect(stored.serverCopyRaw).toBeUndefined();
        // Derived columns are rebuilt from the server payload, not copied.
        expect(stored.title).toBe("Remote title");
        expect(stored.version).toBe(7);
    });

    test("accept-remote on a remote deletion removes the row", async () => {
        await conflictedItem({ serverCopyRaw: undefined });

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote");

        expect(await db.items.get([LIB, "ARTICLE1"])).toBeUndefined();
    });

    test("keep-local on a remote deletion re-uploads the row", async () => {
        await conflictedItem({ serverCopyRaw: undefined });

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.syncStatus).toBe("updated");
    });

    test("a row that is no longer in conflict is skipped, not clobbered", async () => {
        // Two Activity Center clicks, or a sync in between.
        await seedItem({
            libraryID: LIB,
            key: "ARTICLE1",
            syncStatus: "synced",
            title: "Already resolved",
        });

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.title).toBe("Already resolved");
        expect(
            host.logsAt("warn").some((l) => /is not in conflict/.test(l.message)),
        ).toBe(true);
    });

    test("an unknown row is an error, not a silent no-op", async () => {
        await expect(
            conflict.resolveItemConflict(LIB, "MISSING1", "keep-local"),
        ).rejects.toThrow(/Item not found: 1\/MISSING1/);
    });

    test("resolution is logged with the action taken", async () => {
        await conflictedItem();
        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");
        expect(
            host
                .logsAt("info")
                .some((l) => /Resolved item conflict ARTICLE1 → keep-local/.test(l.message)),
        ).toBe(true);
    });
});

describe("resolving a collection", () => {
    test("keep-local queues it and stamps the server version", async () => {
        await conflictedCollection();

        await conflict.resolveCollectionConflict(LIB, "COLL0001", "keep-local");

        const stored = (await db.collections.get([LIB, "COLL0001"]))!;
        expect(stored.syncStatus).toBe("updated");
        expect(stored.serverCopyRaw).toBeUndefined();
        expect(stored.name).toBe("Local name");
        expect((stored.raw as any).version).toBe(7);
    });

    test("accept-remote re-derives the row from the server copy", async () => {
        await conflictedCollection();

        await conflict.resolveCollectionConflict(
            LIB,
            "COLL0001",
            "accept-remote",
        );

        const stored = (await db.collections.get([LIB, "COLL0001"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.name).toBe("Remote name");
    });

    test("accept-remote on a remote deletion removes it", async () => {
        await conflictedCollection({ serverCopyRaw: undefined });

        await conflict.resolveCollectionConflict(
            LIB,
            "COLL0001",
            "accept-remote",
        );

        expect(await db.collections.get([LIB, "COLL0001"])).toBeUndefined();
    });

    test("a collection deleted remotely is diffed as a whole", async () => {
        await conflictedCollection({ serverCopyRaw: undefined });
        const [info] = await conflict.getCollectionConflicts();

        expect(info!.fields).toHaveLength(1);
        expect(info!.fields[0]!.field).toBe("(entire collection)");
        expect(info!.fields[0]!.remoteValue).toBe("(deleted on server)");
    });

    test("a nameless collection is labelled by key", async () => {
        await conflictedCollection({ name: "" });
        const [info] = await conflict.getCollectionConflicts();
        expect(info!.name).toBe("COLL0001");
    });

    test("an unknown collection is an error", async () => {
        await expect(
            conflict.resolveCollectionConflict(LIB, "MISSING1", "keep-local"),
        ).rejects.toThrow(/Collection not found: 1\/MISSING1/);
    });

    test("a collection no longer in conflict is skipped", async () => {
        await seedCollection({
            libraryID: LIB,
            key: "COLL0001",
            syncStatus: "synced",
        });

        await conflict.resolveCollectionConflict(LIB, "COLL0001", "keep-local");

        expect((await db.collections.get([LIB, "COLL0001"]))!.syncStatus).toBe(
            "synced",
        );
    });
});

describe("batch resolution", () => {
    test("every conflicted item is resolved and counted", async () => {
        await conflictedItem();
        await seedItem({
            libraryID: LIB,
            key: "ARTICLE2",
            syncStatus: "conflict",
            serverCopyRaw: undefined,
        });
        await seedItem({ libraryID: LIB, key: "SYNCED01", syncStatus: "synced" });

        expect(await conflict.resolveAllItemConflicts("keep-local")).toBe(2);

        expect((await db.items.get([LIB, "ARTICLE1"]))!.syncStatus).toBe(
            "updated",
        );
        expect((await db.items.get([LIB, "ARTICLE2"]))!.syncStatus).toBe(
            "updated",
        );
        expect((await db.items.get([LIB, "SYNCED01"]))!.syncStatus).toBe(
            "synced",
        );
        expect(await conflict.getItemConflicts()).toEqual([]);
    });

    test("accept-remote in bulk can empty the table", async () => {
        await conflictedItem({ serverCopyRaw: undefined });
        await seedItem({
            libraryID: LIB,
            key: "ARTICLE2",
            syncStatus: "conflict",
            serverCopyRaw: undefined,
        });

        expect(await conflict.resolveAllItemConflicts("accept-remote")).toBe(2);
        expect(await db.items.count()).toBe(0);
    });

    test("nothing to resolve reports zero", async () => {
        expect(await conflict.resolveAllItemConflicts("keep-local")).toBe(0);
        expect(await conflict.resolveAllCollectionConflicts("keep-local")).toBe(
            0,
        );
    });

    test("collections resolve in bulk too", async () => {
        await conflictedCollection();
        await seedCollection({
            libraryID: LIB,
            key: "COLL0002",
            syncStatus: "conflict",
        });

        expect(await conflict.resolveAllCollectionConflicts("keep-local")).toBe(
            2,
        );
        expect(await conflict.getCollectionConflicts()).toEqual([]);
    });

    test("a failure mid-batch propagates rather than being swallowed", async () => {
        await conflictedItem();
        await seedItem({
            libraryID: LIB,
            key: "ARTICLE2",
            syncStatus: "conflict",
        });
        vi.spyOn(db.items, "update").mockRejectedValue(new Error("disk full"));

        await expect(
            conflict.resolveAllItemConflicts("keep-local"),
        ).rejects.toThrow(/Failed to resolve item conflict/i);
    });
});
