/**
 * Harness for `AttachmentService`.
 *
 * Every dependency is either real or injected at the constructor, so almost
 * nothing needs mocking at the module level:
 *
 * - **The DB is real.** The cache lives in the `files` table, keyed by the
 *   compound `[libraryID+key]` with a `lastAccessedAt` index — the LRU is a
 *   query, and querying it for real is the point.
 * - **SparkMD5 and fflate are real.** Both are pure; a fake would only assert
 *   that a fake was called, when what matters is that a corrupted buffer
 *   actually produces a different digest.
 * - **`WebDavService` and `ZoteroAPIService` are injected**, so they get
 *   recording fakes that can be told to fail.
 * - **`fetch` is stubbed**, because the Zotero file endpoint returns bytes
 *   rather than the JSON the shared fake server speaks.
 */
import { AttachmentService } from "worker/services/attachment";
import { DEFAULT_SETTINGS } from "settings/types";

import { db, resetDb, seedItem, seedLibrary } from "./db";
import { createFakeParentHost } from "./parent-host";

import type { FakeParentHost } from "./parent-host";
import type { WebDavService } from "worker/services/webdav";
import type { ZoteroAPIService } from "worker/services/zotero";
import type { ZotFlowSettings } from "settings/types";
import type { AttachmentData } from "types/zotero-item";
import type { IDBZoteroFile, IDBZoteroItem } from "types/db-schema";

export const USER_ID = 1;
export const ISO = "2026-01-01T00:00:00.000Z";

/** Zotero's `linkMode` values that matter to this service. */
export type LinkMode =
    | "imported_file"
    | "imported_url"
    | "linked_file"
    | "linked_url";

export interface FakeWebDav {
    /** Remote paths passed to `downloadFile`, in order. */
    downloads: string[];
    /** Bytes `downloadFile` resolves with. */
    payload: ArrayBuffer;
    /** Make `downloadFile` reject. */
    fails: boolean;
    /** What `getContentLength` reports; null means "unknown". */
    contentLength: number | null;
}

export interface FakeZoteroApi {
    /** Item keys passed to `getItem`, in order. */
    itemLookups: string[];
    /** Raw item payload `getItem` resolves with (for the size probe). */
    itemPayload: unknown;
}

export interface AttachmentHarnessOptions {
    settings?: Partial<ZotFlowSettings>;
    /** Value returned by `parentHost.isAndroidApp()`. */
    isAndroid?: boolean;
    /** Value returned by `parentHost.isDesktopApp()`. */
    isDesktop?: boolean;
}

export interface AttachmentHarness {
    service: AttachmentService;
    host: FakeParentHost;
    webdav: FakeWebDav;
    zotero: FakeZoteroApi;
    settings: ZotFlowSettings;
    /** Bytes the stubbed `fetch` returns for the Zotero file endpoint. */
    setApiPayload: (bytes: ArrayBuffer) => void;
    /** Make the stubbed `fetch` answer with an HTTP error. */
    setApiStatus: (status: number) => void;
    /**
     * Hold every subsequent `fetch` open until `releaseFetch()` is called, so a
     * test can observe the service while a download is genuinely in flight.
     * Without this, the stub resolves instantly and any attempt to catch the
     * in-flight state is a race against the clock.
     */
    blockFetch: () => void;
    releaseFetch: () => void;
    /** Every URL the stubbed `fetch` was asked for, in order. */
    fetches: string[];
    /** Seed an attachment row in `items`. */
    seedAttachment: (
        key: string,
        overrides?: SeedAttachmentOverrides,
    ) => Promise<IDBZoteroItem<AttachmentData>>;
    /** Seed a cache row in `files`. */
    seedCached: (
        key: string,
        overrides?: SeedCachedOverrides,
    ) => Promise<IDBZoteroFile>;
    /** Read a cache row back. */
    getCached: (key: string) => Promise<IDBZoteroFile | undefined>;
    /** Every cache row, oldest access first. */
    cachedKeys: () => Promise<string[]>;
}

export interface SeedAttachmentOverrides {
    linkMode?: LinkMode;
    md5?: string;
    filename?: string;
    contentType?: string;
    path?: string;
    itemType?: "attachment" | "journalArticle" | "book" | "note";
    libraryType?: "user" | "group";
}

export interface SeedCachedOverrides {
    buffer?: ArrayBuffer;
    md5?: string;
    size?: number;
    lastAccessedAt?: string;
    mimeType?: string;
    fileName?: string;
}

/** Deterministic bytes, so MD5s are stable across runs. */
export function bytes(...values: number[]): ArrayBuffer {
    return new Uint8Array(values).buffer;
}

/** `size` bytes of a repeating pattern — for cache-size arithmetic. */
export function bytesOfSize(size: number): ArrayBuffer {
    return new Uint8Array(size).fill(7).buffer;
}

export async function createAttachmentHarness(
    options: AttachmentHarnessOptions = {},
): Promise<AttachmentHarness> {
    await resetDb();
    await seedLibrary({ id: USER_ID, type: "user", name: "My Library" });

    const settings: ZotFlowSettings = {
        ...DEFAULT_SETTINGS,
        zoteroapikey: "TESTKEY",
        useCache: true,
        useWebDav: false,
        ...options.settings,
    };

    const webdav: FakeWebDav = {
        downloads: [],
        payload: bytes(1, 2, 3),
        fails: false,
        contentLength: null,
    };
    const fakeWebdav = {
        downloadFile: (remotePath: string) => {
            webdav.downloads.push(remotePath);
            return webdav.fails
                ? Promise.reject(new Error("webdav download failed"))
                : Promise.resolve(webdav.payload);
        },
        getContentLength: () => Promise.resolve(webdav.contentLength),
        updateSettings: () => {},
        verify: () => Promise.resolve(true),
    } as unknown as WebDavService;

    const zotero: FakeZoteroApi = { itemLookups: [], itemPayload: null };
    const fakeZotero = {
        getItem: (_libraryID: number, key: string) => {
            zotero.itemLookups.push(key);
            return Promise.resolve(zotero.itemPayload);
        },
    } as unknown as ZoteroAPIService;

    const host = createFakeParentHost({
        isAndroid: options.isAndroid ?? false,
        isDesktop: options.isDesktop,
    });

    /* -------- fetch stub for the Zotero file endpoint -------- */
    const fetches: string[] = [];
    let apiPayload: ArrayBuffer = bytes(1, 2, 3);
    let apiStatus = 200;

    let gate: Promise<void> | null = null;
    let openGate: (() => void) | null = null;

    const fetchStub = async (url: string | URL) => {
        fetches.push(String(url));
        if (gate) await gate;
        return {
            ok: apiStatus >= 200 && apiStatus < 300,
            status: apiStatus,
            statusText: `status ${apiStatus}`,
            arrayBuffer: () => Promise.resolve(apiPayload),
            headers: {
                get: (name: string) =>
                    name.toLowerCase() === "content-length"
                        ? String(apiPayload.byteLength)
                        : null,
            },
        };
    };
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const service = new AttachmentService(
        fakeWebdav,
        settings,
        fakeZotero,
        host,
    );

    const seedAttachment = async (
        key: string,
        overrides: SeedAttachmentOverrides = {},
    ) => {
        const libraryType = overrides.libraryType ?? "user";
        const item = await seedItem({
            libraryID: USER_ID,
            key,
            itemType: overrides.itemType ?? "attachment",
            parentItem: "PAPER001",
            raw: {
                key,
                version: 1,
                library: { type: libraryType, id: USER_ID, name: "Library" },
                links: {},
                meta: { numChildren: 0 },
                data: {
                    key,
                    version: 1,
                    itemType: "attachment",
                    linkMode: overrides.linkMode ?? "imported_file",
                    contentType: overrides.contentType ?? "application/pdf",
                    filename: overrides.filename ?? `${key}.pdf`,
                    title: `${key} title`,
                    ...(overrides.md5 !== undefined ? { md5: overrides.md5 } : {}),
                    ...(overrides.path !== undefined
                        ? { path: overrides.path }
                        : {}),
                },
            } as never,
        });
        return item as unknown as IDBZoteroItem<AttachmentData>;
    };

    const seedCached = async (
        key: string,
        overrides: SeedCachedOverrides = {},
    ) => {
        const buffer = overrides.buffer ?? bytes(9, 9, 9);
        const record: IDBZoteroFile = {
            libraryID: USER_ID,
            key,
            buffer,
            mimeType: overrides.mimeType ?? "application/pdf",
            fileName: overrides.fileName ?? `${key}.pdf`,
            md5: overrides.md5 ?? "cachedmd5",
            size: overrides.size ?? buffer.byteLength,
            lastAccessedAt: overrides.lastAccessedAt ?? ISO,
        };
        await db.files.put(record);
        return record;
    };

    return {
        service,
        host,
        webdav,
        zotero,
        settings,
        fetches,
        setApiPayload: (b) => {
            apiPayload = b;
        },
        setApiStatus: (s) => {
            apiStatus = s;
        },
        blockFetch: () => {
            gate = new Promise<void>((resolve) => {
                openGate = resolve;
            });
        },
        releaseFetch: () => {
            openGate?.();
            gate = null;
            openGate = null;
        },
        seedAttachment,
        seedCached,
        getCached: (key) => db.files.get([USER_ID, key]),
        cachedKeys: async () => {
            const all = await db.files.toArray();
            return all
                .sort((a, b) =>
                    (a.lastAccessedAt || "").localeCompare(b.lastAccessedAt || ""),
                )
                .map((f) => f.key);
        },
    };
}

export { db };
