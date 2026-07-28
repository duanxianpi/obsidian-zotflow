/**
 * `SyncService.startSync` as an orchestrator: entry guards, which libraries a
 * run touches, the 412 push-retry loop, progress reporting and the notices it
 * emits. What happens *inside* a library is covered by sync-pull / sync-push.
 */
import { describe, test, expect, afterEach } from "vitest";
import { db, seedItem } from "../fakes/db";
import { createSyncHarness, API_KEY, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
afterEach(() => h?.dispose());

const GROUP_ID = 777;

describe("entry guards", () => {
    test("missing API key aborts before any request", async () => {
        h = await createSyncHarness({ settings: { zoteroapikey: "" } });
        await expect(h.sync.startSync()).rejects.toThrow(/API Key missing/i);
        expect(h.server.requests).toHaveLength(0);
    });

    test("API key absent from the local DB is an auth failure", async () => {
        h = await createSyncHarness({ omitKey: true });
        await expect(h.sync.startSync()).rejects.toThrow(/API Key not found/i);
        expect(h.server.requests).toHaveLength(0);
    });

    test("offline aborts before any request", async () => {
        h = await createSyncHarness();
        const original = navigator.onLine;
        Object.defineProperty(navigator, "onLine", {
            value: false,
            configurable: true,
        });
        try {
            await expect(h.sync.startSync()).rejects.toThrow(/offline/i);
            expect(h.server.requests).toHaveLength(0);
        } finally {
            Object.defineProperty(navigator, "onLine", {
                value: original,
                configurable: true,
            });
        }
    });

    test("an already-aborted signal short-circuits the whole run", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });

        const controller = new AbortController();
        controller.abort();

        expect(await h.sync.startSync(controller.signal)).toEqual({
            successCount: 0,
            failCount: 0,
            changedItems: [],
            syncedLibraryIDs: [],
        });
        expect(h.server.requests).toHaveLength(0);
    });

    test("absent librariesConfig warns and does nothing", async () => {
        h = await createSyncHarness();
        // Distinct from an empty object: this is "never configured".
        (h.settings as { librariesConfig?: unknown }).librariesConfig = undefined;

        expect(await h.sync.startSync()).toEqual({
            successCount: 0,
            failCount: 0,
            changedItems: [],
            syncedLibraryIDs: [],
        });
        expect(
            h.host.logsAt("warn").some((l) => /No libraries configured/i.test(l.message)),
        ).toBe(true);
        expect(h.server.requests).toHaveLength(0);
    });

    test("empty librariesConfig syncs nothing but still reports success", async () => {
        h = await createSyncHarness({ omitLibraryConfig: true });

        const result = await h.sync.startSync();
        expect(result.syncedLibraryIDs).toEqual([]);
        expect(result.successCount).toBe(0);
        expect(result.failCount).toBe(0);
        expect(h.server.requests).toHaveLength(0);
    });
});

describe("library selection", () => {
    test("syncs the personal library and all configured groups", async () => {
        h = await createSyncHarness({ groups: [{ id: GROUP_ID }] });
        h.server.library(USER_ID).addItem({ key: "USERITEM" });
        h.server.library(GROUP_ID, "group").addItem({ key: "GRUPITEM" });

        const result = await h.sync.startSync();

        expect(result.syncedLibraryIDs.sort()).toEqual([USER_ID, GROUP_ID]);
        expect(result.successCount).toBe(2);
        // Group libraries live under /groups/{id}, not /users/{id}.
        expect(h.server.requestsFor("/groups/777").length).toBeGreaterThan(0);
        expect(
            (await db.items.toArray()).map((i) => `${i.libraryID}:${i.key}`).sort(),
        ).toEqual(["1:USERITEM", "777:GRUPITEM"]);
    });

    test("an ignored library is skipped in a multi-library run", async () => {
        h = await createSyncHarness({
            groups: [{ id: GROUP_ID, mode: "ignored" }],
        });
        h.server.library(GROUP_ID, "group").addItem({ key: "GRUPITEM" });

        const result = await h.sync.startSync();

        expect(result.syncedLibraryIDs).toEqual([USER_ID]);
        expect(h.server.requestsFor("/groups/777")).toHaveLength(0);
    });

    test("an explicit libraryId restricts the run to that library", async () => {
        h = await createSyncHarness({ groups: [{ id: GROUP_ID }] });
        h.server.library(USER_ID).addItem({ key: "USERITEM" });
        h.server.library(GROUP_ID, "group").addItem({ key: "GRUPITEM" });

        const result = await h.sync.startSync(undefined, undefined, GROUP_ID);

        expect(result.syncedLibraryIDs).toEqual([GROUP_ID]);
        expect(h.server.requestsFor("/users/1")).toHaveLength(0);
        expect((await db.items.toArray()).map((i) => i.key)).toEqual(["GRUPITEM"]);
    });

    test("an explicit libraryId that is ignored warns and does nothing", async () => {
        h = await createSyncHarness({
            groups: [{ id: GROUP_ID, mode: "ignored" }],
        });

        const result = await h.sync.startSync(undefined, undefined, GROUP_ID);

        expect(result.syncedLibraryIDs).toEqual([]);
        expect(
            h.host.logsAt("warn").some((l) => /ignored or not found/i.test(l.message)),
        ).toBe(true);
        expect(h.server.requests).toHaveLength(0);
    });

    test("an explicit libraryId that does not exist warns and does nothing", async () => {
        h = await createSyncHarness();
        const result = await h.sync.startSync(undefined, undefined, 999);

        expect(result.syncedLibraryIDs).toEqual([]);
        expect(h.server.requests).toHaveLength(0);
    });
});

describe("progress and notices", () => {
    test("progress is reported per library and once at the end", async () => {
        h = await createSyncHarness({ groups: [{ id: GROUP_ID }] });
        const calls: [number, number, string][] = [];

        await h.sync.startSync(undefined, (done, total, message) =>
            calls.push([done, total, message]),
        );

        expect(calls[0]).toEqual([0, 2, "Syncing library: My Library"]);
        expect(calls[1]).toEqual([1, 2, "Syncing library: Group 777"]);
        expect(calls.at(-1)).toEqual([2, 2, "Sync completed"]);
    });

    test("a clean run notifies success once", async () => {
        h = await createSyncHarness();
        await h.sync.startSync();

        expect(h.host.notices).toContainEqual({
            type: "success",
            message: "Sync completed successfully!",
        });
    });

    test("a failing library is counted, notified, and does not stop the others", async () => {
        h = await createSyncHarness({ groups: [{ id: GROUP_ID }] });
        h.server.library(GROUP_ID, "group").addItem({ key: "GRUPITEM" });
        // Fail the very first request, which belongs to the personal library.
        h.server.failNext({ status: 500, pathIncludes: "/users/1" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(1);
        expect(result.successCount).toBe(1);
        expect(
            h.host.notices.some(
                (n) => n.type === "error" && /Library 1 Sync Failed/.test(n.message),
            ),
        ).toBe(true);
        expect(h.host.notices).toContainEqual({
            type: "info",
            message: "Sync finished with 1 errors.",
        });
        // The group still synced.
        expect((await db.items.toArray()).map((i) => i.key)).toEqual(["GRUPITEM"]);
    });

    test("syncedAt is stamped on the libraries that succeeded", async () => {
        h = await createSyncHarness();
        const before = (await db.libraries.get(USER_ID))!.syncedAt;

        await h.sync.startSync();

        const after = (await db.libraries.get(USER_ID))!.syncedAt;
        expect(after).not.toBe(before);
        expect(after).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    test("aborting mid-run rethrows and still logs the finally block", async () => {
        // The per-library try/catch swallows anything a single library throws,
        // so the catastrophic path is only reachable from the loop body itself.
        // The abort check is the one statement that lives there.
        h = await createSyncHarness({ groups: [{ id: GROUP_ID }] });
        h.server.library(USER_ID).addItem({ key: "USERITEM" });
        h.server.library(GROUP_ID, "group").addItem({ key: "GRUPITEM" });

        const controller = new AbortController();
        // Fires before the first library syncs; the second iteration then sees
        // an aborted signal and throws out of the loop.
        await expect(
            h.sync.startSync(controller.signal, () => controller.abort()),
        ).rejects.toThrow(/Aborted/);

        expect(
            h.host.notices.some(
                (n) => n.type === "error" && /Critical Sync Failure/.test(n.message),
            ),
        ).toBe(true);
        expect(
            h.host.logsAt("info").some((l) => l.message === "Sync finished."),
        ).toBe(true);

        // The first library completed before the abort took effect.
        expect((await db.items.toArray()).map((i) => i.key)).toEqual(["USERITEM"]);
    });
});

describe("push retry loop", () => {
    test("a 412 on push triggers a re-pull and a retry", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
        });
        // First write 412s; the retry is allowed through.
        h.server.failNext({ status: 412, pathIncludes: "/items", method: "POST" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(0);
        expect(
            h.host.logsAt("info").some((l) => /Push returned 412 \(attempt 1\/3\)/.test(l.message)),
        ).toBe(true);
        // Two POSTs: the rejected one and the successful retry.
        expect(
            h.server.requests.filter((r) => r.method === "POST"),
        ).toHaveLength(2);
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe(
            "synced",
        );
    });

    test("a persistently conflicting library gives up after MAX_PUSH_RETRIES", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
        });
        for (let i = 0; i < 3; i++) {
            h.server.failNext({
                status: 412,
                pathIncludes: "/items",
                method: "POST",
            });
        }

        const result = await h.sync.startSync();

        // Giving up is not a failure: the item stays dirty for the next run.
        expect(result.failCount).toBe(0);
        expect(
            h.server.requests.filter((r) => r.method === "POST"),
        ).toHaveLength(3);
        expect(
            h.host.logsAt("warn").some((l) => /Push failed after 3 retries/.test(l.message)),
        ).toBe(true);
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe(
            "created",
        );
    });

    test("readonly libraries never push", async () => {
        h = await createSyncHarness({ mode: "readonly" });
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });

        await h.sync.startSync();

        expect(h.server.requests.filter((r) => r.method === "POST")).toHaveLength(
            0,
        );
        expect(h.server.library(USER_ID).items.has("NEWITEM1")).toBe(false);
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe(
            "created",
        );
    });
});

describe("credentials", () => {
    test("requests carry the configured API key", async () => {
        h = await createSyncHarness();
        await h.sync.startSync();

        expect(h.server.requests.length).toBeGreaterThan(0);
        for (const r of h.server.requests) {
            expect(r.headers.get("Zotero-API-Key")).toBe(API_KEY);
        }
    });
});
