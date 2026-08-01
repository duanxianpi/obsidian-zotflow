/**
 * `WebDavService` — downloading Zotero attachments from a user's own server.
 *
 * It read as 2.8% covered, but that was only the class declaration running on
 * import: **no method had ever executed** (0% of functions). For a service whose
 * whole job is talking to an arbitrary third-party server, that meant none of
 * the status-code handling had been exercised.
 *
 * `fetch` is stubbed rather than mocked at the module level — every method calls
 * the global directly, which is where `worker.ts` installs its proxied fetch in
 * production. (`verify()` passes a `throw: false` option that only Obsidian's
 * `requestUrl` understands; plain fetch ignores it, so the status branches below
 * are what actually decide the outcome.)
 */
import { beforeEach, describe, expect, it } from "vitest";

import { WebDavService } from "worker/services/webdav";
import { DEFAULT_SETTINGS } from "settings/types";

import { createFakeParentHost } from "../fakes/parent-host";

import type { FakeParentHost } from "../fakes/parent-host";
import type { ZotFlowSettings } from "settings/types";

const URL_BASE = "https://dav.example.com/zotero";
const USER = "alice";
const PASS = "s3cret";

/** Basic-auth header the service should produce for the configured credentials. */
const EXPECTED_AUTH = `Basic ${btoa(`${USER}:${PASS}`)}`;

interface FetchCall {
    url: string;
    method: string;
    headers: Record<string, string>;
}

let host: FakeParentHost;
let service: WebDavService;
let calls: FetchCall[];
let response: {
    ok: boolean;
    status: number;
    statusText: string;
    body: ArrayBuffer;
    contentLength: string | null;
};
let fetchThrows: Error | null;

function configure(overrides: Partial<ZotFlowSettings> = {}) {
    const settings: ZotFlowSettings = {
        ...DEFAULT_SETTINGS,
        webDavUrl: URL_BASE,
        webDavUser: USER,
        webdavpassword: PASS,
        ...overrides,
    };
    service = new WebDavService(settings, host);
    return settings;
}

beforeEach(() => {
    host = createFakeParentHost();
    calls = [];
    fetchThrows = null;
    response = {
        ok: true,
        status: 200,
        statusText: "OK",
        body: new Uint8Array([1, 2, 3]).buffer,
        contentLength: "3",
    };

    globalThis.fetch = ((url: string, init?: RequestInit) => {
        calls.push({
            url: String(url),
            method: init?.method ?? "GET",
            headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (fetchThrows) return Promise.reject(fetchThrows);
        return Promise.resolve({
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            arrayBuffer: () => Promise.resolve(response.body),
            headers: {
                get: (name: string) =>
                    name.toLowerCase() === "content-length"
                        ? response.contentLength
                        : null,
            },
        });
    }) as unknown as typeof fetch;

    configure();
});

/* ================================================================ */
/*  Configuration guard                                             */
/* ================================================================ */

describe("configuration", () => {
    it.each([
        ["no URL", { webDavUrl: "" }],
        ["no user", { webDavUser: "" }],
        ["no password", { webdavpassword: "" }],
    ])("refuses to download with %s", async (_label, patch) => {
        configure(patch);

        await expect(service.downloadFile("a.zip")).rejects.toThrow(
            /credentials not configured/,
        );
        expect(calls).toEqual([]);
    });

    it("refuses to probe the size with incomplete credentials", async () => {
        configure({ webdavpassword: "" });

        await expect(service.getContentLength("a.zip")).rejects.toThrow(
            /credentials not configured/,
        );
    });

    it("picks up credentials changed after construction", async () => {
        configure({ webDavUrl: "" });
        service.updateSettings({
            ...DEFAULT_SETTINGS,
            webDavUrl: URL_BASE,
            webDavUser: USER,
            webdavpassword: PASS,
        });

        await expect(service.downloadFile("a.zip")).resolves.toBeInstanceOf(
            ArrayBuffer,
        );
    });
});

/* ================================================================ */
/*  URL construction                                                */
/* ================================================================ */

describe("URL construction", () => {
    it("joins base and path with exactly one slash", async () => {
        await service.downloadFile("ABCD1234.zip");

        expect(calls[0]!.url).toBe(`${URL_BASE}/ABCD1234.zip`);
    });

    it("does not double the slash when the base already ends in one", async () => {
        configure({ webDavUrl: `${URL_BASE}/` });

        await service.downloadFile("ABCD1234.zip");

        expect(calls[0]!.url).toBe(`${URL_BASE}/ABCD1234.zip`);
    });

    it("does not double the slash when the path starts with one", async () => {
        await service.downloadFile("/ABCD1234.zip");

        expect(calls[0]!.url).toBe(`${URL_BASE}/ABCD1234.zip`);
    });

    it("sends basic auth built from the configured credentials", async () => {
        await service.downloadFile("a.zip");

        expect(calls[0]!.headers["Authorization"]).toBe(EXPECTED_AUTH);
    });
});

/* ================================================================ */
/*  downloadFile                                                    */
/* ================================================================ */

describe("downloadFile", () => {
    it("returns the body on success", async () => {
        response.body = new Uint8Array([7, 8, 9]).buffer;

        const buffer = await service.downloadFile("a.zip");

        expect([...new Uint8Array(buffer)]).toEqual([7, 8, 9]);
    });

    it.each([401, 403])(
        "reports %s as an auth failure, not a generic one",
        async (status) => {
            // The user needs to know their password is wrong, not that
            // "something went wrong" — the two have different fixes.
            response = { ...response, ok: false, status, statusText: "denied" };

            await expect(service.downloadFile("a.zip")).rejects.toThrow(
                /WebDAV Auth Failed/,
            );
        },
    );

    it("reports 404 as a missing file", async () => {
        // Ordinary when Zotero's index is ahead of what was uploaded.
        response = { ...response, ok: false, status: 404, statusText: "gone" };

        await expect(service.downloadFile("a.zip")).rejects.toThrow(
            /File Not Found/i,
        );
    });

    it("reports any other status with the status in the message", async () => {
        response = { ...response, ok: false, status: 507, statusText: "full" };

        await expect(service.downloadFile("a.zip")).rejects.toThrow(/507/);
    });

    it("wraps a transport failure rather than leaking it", async () => {
        fetchThrows = new Error("ECONNREFUSED");

        await expect(service.downloadFile("a.zip")).rejects.toThrow();
    });

    it("logs the outcome for the activity centre", async () => {
        await service.downloadFile("a.zip");

        expect(
            host.logs.some((l) => l.context === "WebDavService"),
        ).toBe(true);
    });
});

/* ================================================================ */
/*  getContentLength                                                */
/* ================================================================ */

describe("getContentLength", () => {
    it("issues a HEAD, not a GET", async () => {
        // The whole point is to learn the size without pulling the bytes —
        // this is the Android out-of-memory guard's only input.
        await service.getContentLength("a.zip");

        expect(calls[0]!.method).toBe("HEAD");
    });

    it("returns the advertised length", async () => {
        response.contentLength = "1048576";

        expect(await service.getContentLength("a.zip")).toBe(1048576);
    });

    it("returns null when the server omits the header", async () => {
        // Not an error: plenty of WebDAV servers omit Content-Length on HEAD,
        // and the caller must fall back rather than refuse the download.
        response.contentLength = null;

        expect(await service.getContentLength("a.zip")).toBeNull();
    });

    it("returns null when the header is not a number", async () => {
        response.contentLength = "chunked";

        expect(await service.getContentLength("a.zip")).toBeNull();
    });

    it("throws on a non-success status rather than reporting null", async () => {
        // Deliberate, and safe because the only caller —
        // `AttachmentService.enforceMobileDownloadLimit` — catches it and falls
        // back to the Zotero enclosure size. Returning null here would be
        // indistinguishable from "server did not say", which has a different
        // fallback.
        response = { ...response, ok: false, status: 404, statusText: "gone" };

        await expect(service.getContentLength("a.zip")).rejects.toThrow(/404/);
    });

    it("throws when the request fails outright", async () => {
        fetchThrows = new Error("ECONNREFUSED");

        await expect(service.getContentLength("a.zip")).rejects.toThrow();
    });

    it("sends the same auth as a download", async () => {
        await service.getContentLength("a.zip");

        expect(calls[0]!.headers["Authorization"]).toBe(EXPECTED_AUTH);
    });
});

/* ================================================================ */
/*  verify                                                          */
/* ================================================================ */

describe("verify", () => {
    /** `verify` issues a PROPFIND through the global fetch. */
    const respondWith = (status: number) => {
        response = {
            ...response,
            ok: status >= 200 && status < 300,
            status,
            statusText: `status ${status}`,
        };
    };

    it("refuses to verify without complete credentials", async () => {
        await expect(service.verify("", USER, PASS)).rejects.toThrow(
            /Missing WebDAV credentials/,
        );
    });

    it("probes with PROPFIND at depth 0", async () => {
        // A GET would pull a directory listing; PROPFIND Depth:0 asks only
        // whether the root resource is reachable.
        await service.verify(URL_BASE, USER, PASS);

        expect(calls[0]!.method).toBe("PROPFIND");
        expect(calls[0]!.headers["Depth"]).toBe("0");
        expect(calls[0]!.headers["Authorization"]).toBe(EXPECTED_AUTH);
    });

    it("uses the credentials passed in, not the configured ones", async () => {
        // The settings tab verifies what the user just typed, before saving it.
        await service.verify(URL_BASE, "bob", "other");

        expect(calls[0]!.headers["Authorization"]).toBe(
            `Basic ${btoa("bob:other")}`,
        );
    });

    it.each([200, 201, 207])("accepts %s as reachable", async (status) => {
        respondWith(status);

        expect(await service.verify(URL_BASE, USER, PASS)).toBe(true);
    });

    it.each([401, 403])("reports %s as an auth failure", async (status) => {
        respondWith(status);

        await expect(service.verify(URL_BASE, USER, PASS)).rejects.toThrow(
            /Verification 401\/403/,
        );
    });

    it("reports 404 distinctly, since the path may just be wrong", async () => {
        respondWith(404);

        await expect(service.verify(URL_BASE, USER, PASS)).rejects.toThrow(
            /Verification 404/,
        );
    });

    it("reports any other status with the status in the message", async () => {
        respondWith(500);

        await expect(service.verify(URL_BASE, USER, PASS)).rejects.toThrow(
            /500/,
        );
    });

    it("wraps a transport failure", async () => {
        fetchThrows = new Error("ECONNREFUSED");

        await expect(service.verify(URL_BASE, USER, PASS)).rejects.toThrow();
    });
});
