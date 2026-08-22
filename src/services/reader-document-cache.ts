/**
 * Reader document cache.
 *
 * Originally this cache existed so multiple reader leaves could share one
 * downloaded/downloaded-from-vault blob for the same immutable document
 * version (for example the same Zotero attachment or local vault file open
 * in two tabs).
 *
 * Since the single-instance guards were added to `ZoteroReaderView` and
 * `LocalReaderView`, a document can no longer be open in more than one leaf
 * at a time. The cross-leaf sharing path is therefore dead. The cache still
 * serves two much smaller purposes today:
 *
 * 1. It coalesces overlapping `loadDocument`/`renderReader` calls inside a
 *    single view, so a rapid re-open does not read the file or create a
 *    second object URL.
 * 2. It owns the object URL lifecycle and revokes every live URL on plugin
 *    unload.
 *
 * If overlapping loads within one view are ever made impossible as well,
 * this class can be removed and the callers can manage their object URLs
 * directly.
 */

import type { TFile } from "obsidian";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { ReaderDocumentRevision } from "types/tasks";

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
    revision?: Extract<ReaderDocumentRevision, { kind: "external" }>,
): string {
    if (revision) {
        return JSON.stringify([
            "library-file",
            item.libraryID,
            item.key,
            revision.path,
            revision.mtime,
            revision.size,
        ]);
    }

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

export interface ReaderDocumentAcquireOptions {
    /** Set false for mutable sources whose current revision is unavailable. */
    reuse?: boolean;
}

/** Shares immutable attachment bytes while at least one Reader references them. */
export class ReaderDocumentCache {
    private readonly entries = new Map<string | symbol, CacheEntry>();
    private disposed = false;

    async acquire(
        key: string,
        load: () => Promise<ReaderDocumentSource>,
        options: ReaderDocumentAcquireOptions = {},
    ): Promise<ReaderDocumentLease> {
        if (this.disposed) {
            throw new Error("Reader document cache is disposed");
        }

        const entryKey = options.reuse === false ? Symbol(key) : key;
        let entry = this.entries.get(entryKey);
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
                            this.entries.get(entryKey) !== newEntry
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
            this.entries.set(entryKey, entry);
        }

        entry.refs++;
        let ready: ReadyDocument;
        try {
            ready = await entry.promise;
        } catch (e) {
            this.releaseEntry(entryKey, entry);
            throw e;
        }
        if (this.disposed || this.entries.get(entryKey) !== entry) {
            this.releaseEntry(entryKey, entry);
            throw new Error("Reader document cache was disposed while loading");
        }

        let released = false;
        return {
            url: ready.url,
            ...(ready.contentMD5 ? { contentMD5: ready.contentMD5 } : {}),
            release: () => {
                if (released) return;
                released = true;
                this.releaseEntry(entryKey, entry);
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

    private releaseEntry(key: string | symbol, entry: CacheEntry): void {
        if (entry.refs > 0) entry.refs--;
        if (entry.refs !== 0 || this.entries.get(key) !== entry) return;

        this.entries.delete(key);
        if (entry.ready) URL.revokeObjectURL(entry.ready.url);
    }
}
