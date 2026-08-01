/**
 * `ViewStateService` — where the reader remembers what page you were on.
 *
 * Small, and it became more load-bearing after the reader-bridge reconnect fix:
 * both views now push every `viewStateChanged` through here *and* into the
 * bridge's replay cache, so this map is the source of truth a reopened or
 * reparented reader is restored from.
 *
 * Its whole shape is a debounce over `plugin.saveData`, so the timer is the
 * thing under test. Timers are faked narrowly — `vi.useFakeTimers()` with no
 * arguments freezes what other parts of the suite need, and the debounce only
 * uses setTimeout/clearTimeout.
 *
 * `stripCredentials` runs for real: what must never reach `data.json` is exactly
 * the point of calling it, and a fake would only assert that a fake was called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewStateService } from "services/view-state-service";
import { DEFAULT_SETTINGS } from "settings/types";

import type { ZotFlowSettings } from "settings/types";

const DEBOUNCE_MS = 1_000;

interface SaveCall {
    settings: Record<string, unknown>;
    customThemes: unknown[];
    viewStates: Record<string, unknown>;
}

let saves: SaveCall[];
let saveRejects: boolean;
let warns: { message: string; context?: string }[];
let settings: ZotFlowSettings;
let service: ViewStateService;

function build() {
    const plugin = {
        saveData: (data: SaveCall) => {
            saves.push(data);
            return saveRejects
                ? Promise.reject(new Error("data.json is read-only"))
                : Promise.resolve();
        },
    };
    const logService = {
        warn: (message: string, context?: string) =>
            warns.push({ message, context }),
    };
    return new ViewStateService(
        plugin as never,
        logService as never,
        () => settings,
    );
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    saves = [];
    saveRejects = false;
    warns = [];
    settings = { ...DEFAULT_SETTINGS };
    service = build();
});

afterEach(() => {
    vi.useRealTimers();
});

/** Let the debounce fire and the save promise settle. */
async function flushDebounce() {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
}

/* ================================================================ */
/*  Keys                                                            */
/* ================================================================ */

describe("keys", () => {
    it("namespaces remote attachments by library so they cannot collide with paths", () => {
        // A vault file could be literally named "ABCD1234"; the library prefix
        // is what keeps the two kinds of key apart in one map.
        expect(ViewStateService.remoteKey(1, "ABCD1234")).toBe("1:ABCD1234");
        expect(ViewStateService.remoteKey(777, "ABCD1234")).toBe(
            "777:ABCD1234",
        );
    });

    it("keeps local and remote entries for the same name separate", () => {
        service.saveViewState("ABCD1234", true, { page: 1 });
        service.saveViewState(ViewStateService.remoteKey(1, "ABCD1234"), true, {
            page: 2,
        });

        expect(service.getViewState("ABCD1234")).toEqual({
            primaryViewState: { page: 1 },
        });
        expect(service.getViewState("1:ABCD1234")).toEqual({
            primaryViewState: { page: 2 },
        });
    });
});

/* ================================================================ */
/*  Reads and writes                                                */
/* ================================================================ */

describe("view state", () => {
    it("returns undefined for a key it has never seen", () => {
        expect(service.getViewState("nope")).toBeUndefined();
    });

    it("stores the primary and secondary panes independently", () => {
        // A split reader has two panes and each remembers its own position.
        service.saveViewState("a.pdf", true, { page: 1 });
        service.saveViewState("a.pdf", false, { page: 9 });

        expect(service.getViewState("a.pdf")).toEqual({
            primaryViewState: { page: 1 },
            secondaryViewState: { page: 9 },
        });
    });

    it("overwrites the same pane rather than accumulating", () => {
        service.saveViewState("a.pdf", true, { page: 1 });
        service.saveViewState("a.pdf", true, { page: 2 });

        expect(service.getViewState("a.pdf")).toEqual({
            primaryViewState: { page: 2 },
        });
    });

    it("keeps a theme choice alongside the pane state", () => {
        service.saveViewState("a.pdf", true, { page: 1 });
        service.saveTheme("a.pdf", "dark", "sepia");

        expect(service.getViewState("a.pdf")).toEqual({
            primaryViewState: { page: 1 },
            darkTheme: "sepia",
        });
    });

    it("stores light and dark themes independently", () => {
        service.saveTheme("a.pdf", "light", "paper");
        service.saveTheme("a.pdf", "dark", "sepia");

        expect(service.getViewState("a.pdf")).toEqual({
            lightTheme: "paper",
            darkTheme: "sepia",
        });
    });

    it("bulk-loads the map at plugin start", () => {
        service.setViewStates({ "a.pdf": { primaryViewState: { page: 3 } } });

        expect(service.getViewState("a.pdf")).toEqual({
            primaryViewState: { page: 3 },
        });
        expect(service.getViewStatesMap()).toHaveProperty("a.pdf");
    });
});

describe("custom themes", () => {
    it("starts empty and round-trips what it is given", () => {
        expect(service.getCustomThemes()).toEqual([]);

        const themes = [
            { id: "t1", label: "Mine", background: "#fff", foreground: "#000" },
        ];
        service.setCustomThemes(themes);

        expect(service.getCustomThemes()).toEqual(themes);
    });
});

/* ================================================================ */
/*  Rename and delete                                               */
/* ================================================================ */

describe("rename and delete", () => {
    it("moves the entry when a local file is renamed", () => {
        // Local attachments are keyed by path, so a rename would otherwise
        // orphan the reading position.
        service.saveViewState("old.pdf", true, { page: 5 });

        service.renameViewState("old.pdf", "new.pdf");

        expect(service.getViewState("old.pdf")).toBeUndefined();
        expect(service.getViewState("new.pdf")).toEqual({
            primaryViewState: { page: 5 },
        });
    });

    it("does nothing when renaming a key it does not hold", async () => {
        service.renameViewState("ghost.pdf", "new.pdf");
        await flushDebounce();

        expect(service.getViewState("new.pdf")).toBeUndefined();
        // And schedules no write for a no-op.
        expect(saves).toEqual([]);
    });

    it("drops the entry when the attachment is deleted", () => {
        service.saveViewState("a.pdf", true, { page: 5 });

        service.deleteViewState("a.pdf");

        expect(service.getViewState("a.pdf")).toBeUndefined();
    });

    it("does nothing when deleting a key it does not hold", async () => {
        service.deleteViewState("ghost.pdf");
        await flushDebounce();

        expect(saves).toEqual([]);
    });
});

/* ================================================================ */
/*  The debounce                                                    */
/* ================================================================ */

describe("persistence", () => {
    it("does not write on every change", async () => {
        // The reader emits viewStateChanged on every scroll; writing data.json
        // that often would be pathological.
        service.saveViewState("a.pdf", true, { page: 1 });
        service.saveViewState("a.pdf", true, { page: 2 });
        service.saveViewState("a.pdf", true, { page: 3 });

        expect(saves).toEqual([]);
    });

    it("writes once after the burst settles", async () => {
        service.saveViewState("a.pdf", true, { page: 1 });
        service.saveViewState("a.pdf", true, { page: 2 });

        await flushDebounce();

        expect(saves).toHaveLength(1);
        expect(saves[0]!.viewStates).toEqual({
            "a.pdf": { primaryViewState: { page: 2 } },
        });
    });

    it("restarts the timer on each change rather than writing on a fixed cadence", async () => {
        service.saveViewState("a.pdf", true, { page: 1 });
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
        service.saveViewState("a.pdf", true, { page: 2 });
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);

        // 1.8s elapsed but the last change was only 0.9s ago.
        expect(saves).toEqual([]);

        await vi.advanceTimersByTimeAsync(200);
        expect(saves).toHaveLength(1);
    });

    it.each([
        ["saveViewState", () => service.saveViewState("a.pdf", true, {})],
        ["saveTheme", () => service.saveTheme("a.pdf", "dark", "x")],
        ["saveCustomThemes", () => service.saveCustomThemes([])],
        [
            "renameViewState",
            () => {
                service.setViewStates({ "a.pdf": {} });
                service.renameViewState("a.pdf", "b.pdf");
            },
        ],
        [
            "deleteViewState",
            () => {
                service.setViewStates({ "a.pdf": {} });
                service.deleteViewState("a.pdf");
            },
        ],
    ])("%s schedules a write", async (_label, mutate) => {
        mutate();
        await flushDebounce();

        expect(saves).toHaveLength(1);
    });

    it("writes settings, themes and states together", async () => {
        service.setCustomThemes([
            { id: "t1", label: "Mine", background: "#fff", foreground: "#000" },
        ]);
        service.saveViewState("a.pdf", true, { page: 1 });

        await flushDebounce();

        expect(saves[0]).toMatchObject({
            customThemes: [expect.objectContaining({ id: "t1" })],
            viewStates: { "a.pdf": { primaryViewState: { page: 1 } } },
        });
        expect(saves[0]!.settings).toBeTruthy();
    });

    it("never writes credentials into data.json", async () => {
        // data.json is synced between devices; secrets live in SecretStorage.
        settings = {
            ...DEFAULT_SETTINGS,
            zoteroapikey: "SECRET-API-KEY",
            webdavpassword: "SECRET-PASSWORD",
        };
        service.saveViewState("a.pdf", true, { page: 1 });

        await flushDebounce();

        const written = JSON.stringify(saves[0]!.settings);
        expect(written).not.toContain("SECRET-API-KEY");
        expect(written).not.toContain("SECRET-PASSWORD");
    });

    it("reads the settings at write time, not at construction", async () => {
        // The service is built once at plugin load and the user edits settings
        // afterwards; a snapshot taken in the constructor would go stale.
        settings = { ...DEFAULT_SETTINGS, readerColorScheme: "dark" };
        service.saveViewState("a.pdf", true, {});

        await flushDebounce();

        expect(saves[0]!.settings).toMatchObject({ readerColorScheme: "dark" });
    });

    it("warns instead of throwing when the write fails", async () => {
        // Called from a timer with nobody to catch it.
        saveRejects = true;
        service.saveViewState("a.pdf", true, {});

        await flushDebounce();

        expect(warns).toEqual([
            {
                message: "Failed to persist view states to data.json",
                context: "ViewStateService",
            },
        ]);
    });
});

/* ================================================================ */
/*  Flush on unload                                                 */
/* ================================================================ */

describe("flushViewStateSave", () => {
    it("writes a pending change immediately", () => {
        // onunload cannot wait a second for the debounce.
        service.saveViewState("a.pdf", true, { page: 7 });

        service.flushViewStateSave();

        expect(saves).toHaveLength(1);
        expect(saves[0]!.viewStates).toEqual({
            "a.pdf": { primaryViewState: { page: 7 } },
        });
    });

    it("cancels the pending timer so the write does not happen twice", async () => {
        service.saveViewState("a.pdf", true, { page: 7 });

        service.flushViewStateSave();
        await flushDebounce();

        expect(saves).toHaveLength(1);
    });

    it("does nothing when there is no pending change", () => {
        service.flushViewStateSave();

        expect(saves).toEqual([]);
    });

    it("does nothing on a second call", () => {
        service.saveViewState("a.pdf", true, {});
        service.flushViewStateSave();

        service.flushViewStateSave();

        expect(saves).toHaveLength(1);
    });
});
