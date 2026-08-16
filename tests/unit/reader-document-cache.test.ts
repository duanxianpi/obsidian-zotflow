import { afterEach, describe, expect, test, vi } from "vitest";
import {
    getLibraryReaderDocumentKey,
    getLocalReaderDocumentFormat,
    getLocalReaderDocumentKey,
    ReaderDocumentCache,
} from "services/reader-document-cache";

afterEach(() => vi.restoreAllMocks());

function mockObjectUrls(...urls: string[]) {
    const create = vi.spyOn(URL, "createObjectURL");
    for (const url of urls) create.mockReturnValueOnce(url);
    const revoke = vi
        .spyOn(URL, "revokeObjectURL")
        .mockImplementation(() => undefined);
    return { create, revoke };
}

describe("reader document metadata", () => {
    test.each([
        ["pdf", { mimeType: "application/pdf", readerType: "pdf" }],
        [
            "EPUB",
            { mimeType: "application/epub+zip", readerType: "epub" },
        ],
        ["Html", { mimeType: "text/html", readerType: "snapshot" }],
    ])("maps %s to its Blob and Reader types", (extension, expected) => {
        expect(getLocalReaderDocumentFormat(extension)).toEqual(expected);
    });

    test("rejects an extension the view registry does not support", () => {
        expect(() => getLocalReaderDocumentFormat("docx")).toThrow(
            "Unsupported reader extension",
        );
    });

    test("local keys change with path or file version", () => {
        const key = (path: string, mtime: number, size: number) =>
            getLocalReaderDocumentKey({
                path,
                stat: { mtime, size },
            } as never);

        expect(key("Books/a.pdf", 10, 20)).toBe(
            key("Books/a.pdf", 10, 20),
        );
        expect(key("Books/a.pdf", 10, 20)).not.toBe(
            key("Books/a.pdf", 11, 20),
        );
        expect(key("Books/a.pdf", 10, 20)).not.toBe(
            key("Books/b.pdf", 10, 20),
        );
    });

    test("library keys prefer MD5 and otherwise use item version", () => {
        const key = (md5: string | undefined, version: number) =>
            getLibraryReaderDocumentKey({
                libraryID: 7,
                key: "ATTACH01",
                version,
                raw: { data: { md5 } },
            } as never);

        expect(key("same-md5", 1)).toBe(key("same-md5", 2));
        expect(key(undefined, 1)).not.toBe(key(undefined, 2));
    });

    test("external library keys follow path and filesystem revision", () => {
        const item = {
            libraryID: 7,
            key: "ATTACH01",
            version: 1,
            raw: { data: { md5: "stale-server-md5" } },
        } as never;
        const key = (path: string, mtime: number, size: number) =>
            getLibraryReaderDocumentKey(item, {
                kind: "external",
                path,
                mtime,
                size,
            });

        expect(key("C:/zotero/a.pdf", 10, 20)).toBe(
            key("C:/zotero/a.pdf", 10, 20),
        );
        expect(key("C:/zotero/a.pdf", 10, 20)).not.toBe(
            key("C:/zotero/a.pdf", 11, 20),
        );
        expect(key("C:/zotero/a.pdf", 10, 20)).not.toBe(
            key("C:/zotero/b.pdf", 10, 20),
        );
    });
});

describe("ReaderDocumentCache", () => {
    test("shares one load and URL until the final lease is released", async () => {
        const { create, revoke } = mockObjectUrls("blob:first", "blob:second");
        const blob = new Blob(["document"]);
        const load = vi.fn().mockResolvedValue({
            blob,
            contentMD5: "content-md5",
        });
        const cache = new ReaderDocumentCache();

        const [first, second] = await Promise.all([
            cache.acquire("same", load),
            cache.acquire("same", load),
        ]);

        expect(load).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledTimes(1);
        expect(first.url).toBe("blob:first");
        expect(second.url).toBe("blob:first");
        expect(second.contentMD5).toBe("content-md5");

        first.release();
        first.release();
        expect(revoke).not.toHaveBeenCalled();

        second.release();
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledWith("blob:first");

        const third = await cache.acquire("same", load);
        expect(load).toHaveBeenCalledTimes(2);
        expect(third.url).toBe("blob:second");
        third.release();
    });

    test("removes a failed load so the next acquire can retry", async () => {
        mockObjectUrls("blob:retry");
        const load = vi
            .fn()
            .mockRejectedValueOnce(new Error("read failed"))
            .mockResolvedValueOnce({ blob: new Blob(["retry"]) });
        const cache = new ReaderDocumentCache();

        const first = cache.acquire("same", load);
        const second = cache.acquire("same", load);
        const results = await Promise.allSettled([first, second]);

        expect(results.every((result) => result.status === "rejected")).toBe(
            true,
        );
        expect(load).toHaveBeenCalledTimes(1);

        const lease = await cache.acquire("same", load);
        expect(load).toHaveBeenCalledTimes(2);
        lease.release();
    });

    test("does not share a volatile source with the same logical key", async () => {
        const { create, revoke } = mockObjectUrls("blob:first", "blob:second");
        const load = vi
            .fn()
            .mockResolvedValue({ blob: new Blob(["volatile"]) });
        const cache = new ReaderDocumentCache();

        const [first, second] = await Promise.all([
            cache.acquire("same", load, { reuse: false }),
            cache.acquire("same", load, { reuse: false }),
        ]);

        expect(load).toHaveBeenCalledTimes(2);
        expect(create).toHaveBeenCalledTimes(2);
        expect(first.url).toBe("blob:first");
        expect(second.url).toBe("blob:second");

        first.release();
        second.release();
        expect(revoke).toHaveBeenCalledTimes(2);
    });

    test("dispose revokes ready entries and rejects future acquires", async () => {
        const { revoke } = mockObjectUrls("blob:ready");
        const cache = new ReaderDocumentCache();
        const lease = await cache.acquire("same", async () => ({
            blob: new Blob(["ready"]),
        }));

        cache.dispose();
        cache.dispose();
        lease.release();

        expect(revoke).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledWith("blob:ready");
        await expect(
            cache.acquire("other", async () => ({
                blob: new Blob(["other"]),
            })),
        ).rejects.toThrow("disposed");
    });

    test("dispose during a load revokes the URL when that load finishes", async () => {
        const { revoke } = mockObjectUrls("blob:late");
        let resolveSource!: (source: { blob: Blob }) => void;
        const source = new Promise<{ blob: Blob }>((resolve) => {
            resolveSource = resolve;
        });
        const cache = new ReaderDocumentCache();
        const acquire = cache.acquire("same", () => source);

        await Promise.resolve();
        cache.dispose();
        resolveSource({ blob: new Blob(["late"]) });

        await expect(acquire).rejects.toThrow("disposed while loading");
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledWith("blob:late");
    });
});
