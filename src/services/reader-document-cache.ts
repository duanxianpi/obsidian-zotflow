import type { TFile } from "obsidian";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";

export type ReaderDocumentType = "pdf" | "epub" | "snapshot";

export interface LocalReaderDocumentFormat {
    mimeType: string;
    readerType: ReaderDocumentType;
}

/** Map the vault extensions registered by ZotFlow to Reader input metadata. */
export function getLocalReaderDocumentFormat(
    extension: string,
): LocalReaderDocumentFormat {
    switch (extension.toLowerCase()) {
        case "pdf":
            return { mimeType: "application/pdf", readerType: "pdf" };
        case "epub":
            return {
                mimeType: "application/epub+zip",
                readerType: "epub",
            };
        case "html":
            return { mimeType: "text/html", readerType: "snapshot" };
        default:
            throw new Error(`Unsupported reader extension: ${extension}`);
    }
}

/** Cache identity for one immutable snapshot of a vault file. */
export function getLocalReaderDocumentKey(file: TFile): string {
    return JSON.stringify([
        "local",
        file.path,
        file.stat.mtime,
        file.stat.size,
    ]);
}

/** Cache identity for one version of a Zotero attachment. */
export function getLibraryReaderDocumentKey(
    item: IDBZoteroItem<AttachmentData>,
): string {
    const contentVersion = item.raw.data.md5
        ? `md5:${item.raw.data.md5}`
        : `version:${item.version}`;
    return JSON.stringify([
        "library",
        item.libraryID,
        item.key,
        contentVersion,
    ]);
}

export interface ReaderDocumentSource {
    blob: Blob;
    contentMD5?: string;
}

export interface ReaderDocumentLease {
    readonly url: string;
    readonly contentMD5?: string;
    release(): void;
}

interface ReadyDocument {
    url: string;
    contentMD5?: string;
}

interface CacheEntry {
    refs: number;
    ready?: ReadyDocument;
    promise: Promise<ReadyDocument>;
}

/** Shares immutable attachment bytes while at least one Reader references them. */
export class ReaderDocumentCache {
    private readonly entries = new Map<string, CacheEntry>();
    private disposed = false;

    async acquire(
        key: string,
        load: () => Promise<ReaderDocumentSource>,
    ): Promise<ReaderDocumentLease> {
        if (this.disposed) {
            throw new Error("Reader document cache is disposed");
        }

        let entry = this.entries.get(key);
        if (!entry) {
            const newEntry: CacheEntry = {
                refs: 0,
                promise: Promise.resolve()
                    .then(load)
                    .then((source) => {
                        const ready: ReadyDocument = {
                            url: URL.createObjectURL(source.blob),
                            ...(source.contentMD5
                                ? { contentMD5: source.contentMD5 }
                                : {}),
                        };
                        newEntry.ready = ready;

                        if (
                            this.disposed ||
                            this.entries.get(key) !== newEntry
                        ) {
                            URL.revokeObjectURL(ready.url);
                            throw new Error(
                                "Reader document cache was disposed while loading",
                            );
                        }

                        return ready;
                    }),
            };
            entry = newEntry;
            this.entries.set(key, entry);
        }

        entry.refs++;
        let ready: ReadyDocument;
        try {
            ready = await entry.promise;
        } catch (e) {
            this.releaseEntry(key, entry);
            throw e;
        }
        if (this.disposed || this.entries.get(key) !== entry) {
            this.releaseEntry(key, entry);
            throw new Error("Reader document cache was disposed while loading");
        }

        let released = false;
        return {
            url: ready.url,
            ...(ready.contentMD5 ? { contentMD5: ready.contentMD5 } : {}),
            release: () => {
                if (released) return;
                released = true;
                this.releaseEntry(key, entry);
            },
        };
    }

    /** Revoke every live URL, including loads that finish after plugin unload. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        for (const entry of this.entries.values()) {
            if (entry.ready) URL.revokeObjectURL(entry.ready.url);
        }
        this.entries.clear();
    }

    private releaseEntry(key: string, entry: CacheEntry): void {
        if (entry.refs > 0) entry.refs--;
        if (entry.refs !== 0 || this.entries.get(key) !== entry) return;

        this.entries.delete(key);
        if (entry.ready) URL.revokeObjectURL(entry.ready.url);
    }
}
