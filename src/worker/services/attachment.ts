// Worker-side File Manager
import { unzip } from "fflate";
import { db } from "db/db";
import SparkMD5 from "spark-md5";
import { WebDavService } from "./webdav";
import { ZoteroAPIService } from "./zotero";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { Unzipped } from "fflate";
import type { ZotFlowSettings } from "settings/types";
import type { AttachmentData } from "types/zotero-item";
import type { IParentProxy } from "bridge/types";
import type { IDBZoteroFile, IDBZoteroItem } from "types/db-schema";

/**
 * Attachment management service for ZotFlow (Worker Side).
 */
export class AttachmentService {
    private downloadLocks: Map<string, Promise<Blob>> = new Map();

    constructor(
        private webdav: WebDavService,
        private settings: ZotFlowSettings,
        private zotero: ZoteroAPIService,
        private parentHost: IParentProxy,
    ) {}

    public updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    private static readonly ATTACHMENTS_PREFIX = "attachments:";

    /**
     * Resolve a Zotero linked-file path.
     * If the path starts with "attachments:" (Zotero Linked Attachment Base
     * Directory / LABD), strip the prefix and prepend the user-configured
     * base directory. Otherwise return the path as-is (absolute OS path).
     */
    private async resolveLinkedFilePath(rawPath: string): Promise<string> {
        if (!rawPath.startsWith(AttachmentService.ATTACHMENTS_PREFIX)) {
            return rawPath;
        }

        const baseDir = this.settings.linkedAttachmentBaseDir;
        if (!baseDir) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "AttachmentService",
                `Attachment path uses "attachments:" prefix but no Linked Attachment Base Directory is configured. ` +
                    `Set it in ZotFlow settings → General → Linked Attachments.`,
            );
        }

        const relativePath = rawPath.slice(
            AttachmentService.ATTACHMENTS_PREFIX.length,
        );
        return this.parentHost.joinPath(baseDir, relativePath);
    }

    /**
     * Get file blob from cache or download from Zotero API
     * (Entry Point)
     */
    async getFileBlob(
        attachmentItem: IDBZoteroItem<AttachmentData>,
    ): Promise<Blob> {
        const { libraryID, key: itemKey } = attachmentItem;
        this.parentHost.log(
            "debug",
            "Attachment retrieval requested.",
            "AttachmentService",
            {
                libraryID,
                itemKey,
                useCache: this.settings.useCache,
                useWebDav: this.settings.useWebDav,
            },
        );

        // Check Lock
        if (this.downloadLocks.has(itemKey)) {
            this.parentHost.log(
                "info",
                `Download already in progress for ${itemKey}, sharing promise.`,
                "AttachmentService",
            );
            return this.downloadLocks.get(itemKey)!;
        }

        // Validate Metadata
        const item = await db.items.get([libraryID, itemKey]);
        if (!item || item.itemType !== "attachment") {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "AttachmentService",
                `Item metadata not found for ${itemKey}`,
            );
        }
        this.parentHost.log(
            "debug",
            "Attachment metadata loaded.",
            "AttachmentService",
            {
                libraryID: item.libraryID,
                itemKey: item.key,
                linkMode: item.raw.data.linkMode,
                contentType: item.raw.data.contentType,
                hasServerMd5: !!item.raw.data.md5,
                fileName: item.raw.data.filename || item.raw.data.title,
            },
        );

        // Check Cache (Fast Path), skip for linked files (read from disk each time)
        const linkMode = item.raw.data.linkMode;
        if (this.settings.useCache && linkMode !== "linked_file") {
            try {
                this.parentHost.log(
                    "debug",
                    "Checking attachment cache.",
                    "AttachmentService",
                    {
                        libraryID,
                        itemKey,
                    },
                );
                const cached = await db.files.get([libraryID, itemKey]);
                if (cached) {
                    const serverMd5 = item.raw.data.md5;
                    // If MD5 matches, or server doesn't provide MD5, consider cache valid
                    if (!serverMd5 || cached.md5 === serverMd5) {
                        this.parentHost.log(
                            "info",
                            `Cache HIT for ${itemKey}`,
                            "AttachmentService",
                        );

                        // The cache stores raw ArrayBuffer (not Blob): on
                        // WebKit/iPadOS an IndexedDB Blob handle detaches
                        // intermittently — when a concurrent write touches the
                        // row, or once the read transaction auto-commits before
                        // an async `blob.arrayBuffer()` resolves — throwing
                        // `NotFoundError: The object can not be found here.` and
                        // forcing needless re-downloads. An ArrayBuffer is
                        // serialized inline, so the copy returned by `.get()` is
                        // always fully in memory; the Blob below is constructed
                        // synchronously and is safe to clone across the
                        // Worker→main boundary.
                        const result = new Blob([cached.buffer], {
                            type: cached.mimeType,
                        });

                        // Fire-and-forget access-time bump — AFTER the bytes are
                        // materialized, keyed by primary key so it can never race
                        // the read above.
                        db.files
                            .update([libraryID, itemKey], {
                                lastAccessedAt: new Date().toISOString(),
                            })
                            .catch((e) =>
                                this.parentHost.log(
                                    "warn",
                                    "Access-time update failed",
                                    "AttachmentService",
                                    e,
                                ),
                            );

                        this.parentHost.log(
                            "debug",
                            "Cache entry accepted.",
                            "AttachmentService",
                            {
                                itemKey,
                                bytes: cached.size,
                                cachedMd5: cached.md5,
                                serverMd5: serverMd5 || null,
                            },
                        );
                        return result;
                    } else {
                        this.parentHost.log(
                            "warn",
                            `Cache STALE for ${itemKey}. Server: ${serverMd5}, Local: ${cached.md5}`,
                            "AttachmentService",
                        );
                        this.parentHost.log(
                            "debug",
                            "Cache entry rejected due to md5 mismatch.",
                            "AttachmentService",
                            {
                                itemKey,
                                cachedMd5: cached.md5,
                                serverMd5,
                            },
                        );
                    }
                } else {
                    this.parentHost.log(
                        "debug",
                        "No cache entry found for attachment.",
                        "AttachmentService",
                        {
                            libraryID,
                            itemKey,
                        },
                    );
                }
            } catch (e) {
                this.parentHost.log(
                    "warn",
                    "Cache lookup failed, proceeding to download",
                    "AttachmentService",
                    e,
                );
                // Don't throw here, just fall through to download
            }
        } else {
            this.parentHost.log(
                "debug",
                "Cache check skipped.",
                "AttachmentService",
                {
                    itemKey,
                    linkMode,
                    useCache: this.settings.useCache,
                },
            );
        }

        const task = this._downloadTask(item).finally(() => {
            this.downloadLocks.delete(item.key);
            this.parentHost.log(
                "debug",
                "Attachment download lock released.",
                "AttachmentService",
                { itemKey: item.key },
            );
        });

        this.downloadLocks.set(item.key, task);
        this.parentHost.log(
            "debug",
            "Attachment download lock acquired.",
            "AttachmentService",
            {
                itemKey: item.key,
                activeLocks: this.downloadLocks.size,
            },
        );

        return task;
    }

    /**
     * Internal Download Task
     * Encapsulates logic for Download -> Verify -> Save -> Prune
     */
    private async _downloadTask(
        item: IDBZoteroItem<AttachmentData>,
    ): Promise<Blob> {
        const startedAt = Date.now();
        let buffer: ArrayBuffer | null = null;
        const linkMode = item.raw.data.linkMode;
        this.parentHost.log(
            "debug",
            "Starting attachment download task.",
            "AttachmentService",
            {
                libraryID: item.libraryID,
                itemKey: item.key,
                linkMode,
                useWebDav: this.settings.useWebDav,
                useCache: this.settings.useCache,
            },
        );

        // Download Strategy
        switch (linkMode) {
            case "linked_file": {
                const rawPath = item.raw.data.path;
                if (!rawPath) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "AttachmentService",
                        `No path for linked_file ${item.key}`,
                    );
                }
                const filePath = await this.resolveLinkedFilePath(rawPath);
                this.parentHost.log(
                    "info",
                    `Reading linked file: ${filePath}`,
                    "AttachmentService",
                );
                buffer = await this.parentHost.readExternalBinaryFile(filePath);
                this.parentHost.log(
                    "debug",
                    "Linked file read complete.",
                    "AttachmentService",
                    {
                        itemKey: item.key,
                        filePath,
                        bytes: buffer.byteLength,
                    },
                );
                break;
            }
            case "imported_file":
            case "imported_url":
                // Start Download Task (with Lock)
                this.parentHost.notify(
                    "info",
                    `Downloading ${item.raw.data.filename || item.raw.data.title || item.key}...`,
                );

                // Try WebDAV first if enabled
                if (this.settings.useWebDav) {
                    try {
                        this.parentHost.log(
                            "info",
                            `Downloading from WebDAV for ${item.key}`,
                            "AttachmentService",
                        );
                        this.parentHost.log(
                            "debug",
                            "Attempting WebDAV attachment download.",
                            "AttachmentService",
                            {
                                itemKey: item.key,
                                zipPath: `${item.key}.zip`,
                            },
                        );
                        buffer = await this.downloadFromWebDAV(item.key);
                        this.parentHost.log(
                            "debug",
                            "WebDAV attachment download succeeded.",
                            "AttachmentService",
                            {
                                itemKey: item.key,
                                bytes: buffer.byteLength,
                            },
                        );
                    } catch (e) {
                        this.parentHost.log(
                            "error",
                            `WebDAV failed for ${item.key}, falling back to API.`,
                            "AttachmentService",
                            e,
                        );
                        this.parentHost.log(
                            "debug",
                            "WebDAV attempt failed, will fallback to Zotero API.",
                            "AttachmentService",
                            {
                                itemKey: item.key,
                                errorMessage:
                                    e instanceof Error ? e.message : String(e),
                            },
                        );
                    }
                }

                // If WebDAV disabled or failed, use API
                if (!buffer) {
                    this.parentHost.log(
                        "info",
                        `Downloading from Zotero API for ${item.key}`,
                        "AttachmentService",
                    );
                    buffer = await this.downloadFromZoteroAPI(item);
                    this.parentHost.log(
                        "debug",
                        "Zotero API attachment download succeeded.",
                        "AttachmentService",
                        {
                            itemKey: item.key,
                            bytes: buffer.byteLength,
                        },
                    );
                }

                this.parentHost.notify(
                    "info",
                    `Downloaded ${item.raw.data.filename || item.raw.data.title || item.key}`,
                );

                break;
            default:
                this.parentHost.log(
                    "debug",
                    "Using direct Zotero API strategy for link mode.",
                    "AttachmentService",
                    {
                        itemKey: item.key,
                        linkMode,
                    },
                );
                buffer = await this.downloadFromZoteroAPI(item);
                this.parentHost.log(
                    "debug",
                    "Direct Zotero API download succeeded.",
                    "AttachmentService",
                    {
                        itemKey: item.key,
                        bytes: buffer.byteLength,
                    },
                );

                this.parentHost.notify(
                    "info",
                    `Downloaded ${item.raw.data.filename || item.raw.data.title || item.key}`,
                );

                break;
        }

        if (!buffer) {
            // Should be unreachable if sub-methods throw correctly, but safe-guard
            throw new ZotFlowError(
                ZotFlowErrorCode.NETWORK_ERROR,
                "AttachmentService",
                "Download resulted in empty buffer",
            );
        }

        this.parentHost.log(
            "debug",
            "Attachment buffer ready for blob conversion.",
            "AttachmentService",
            {
                itemKey: item.key,
                bytes: buffer.byteLength,
                elapsedMs: Date.now() - startedAt,
            },
        );

        const blob = new Blob([buffer], {
            type: item.raw.data.contentType || "application/pdf",
        });
        this.parentHost.log(
            "debug",
            "Blob created from attachment buffer.",
            "AttachmentService",
            {
                itemKey: item.key,
                blobSize: blob.size,
                mimeType: blob.type,
            },
        );

        // B. Integrity Check & Auto-Repair, skip for linked files (no server MD5, no cache)
        if (linkMode !== "linked_file") {
            const serverMd5 = item.raw.data.md5;
            let finalMd5 = serverMd5 || "";

            if (serverMd5) {
                const calculatedMd5 = SparkMD5.ArrayBuffer.hash(buffer);
                this.parentHost.log(
                    "debug",
                    "Attachment MD5 calculated.",
                    "AttachmentService",
                    {
                        itemKey: item.key,
                        serverMd5,
                        calculatedMd5,
                    },
                );

                if (calculatedMd5 !== serverMd5) {
                    const msg = `MD5 Mismatch for ${item.key}! Expected: ${serverMd5}, Got: ${calculatedMd5}`;
                    this.parentHost.log("warn", msg, "AttachmentService");

                    // Smart Repair Strategy
                    if (
                        linkMode === "imported_file" ||
                        !this.settings.useWebDav
                    ) {
                        this.parentHost.log(
                            "info",
                            "Trusting live download. Auto-updating metadata.",
                            "AttachmentService",
                        );
                        finalMd5 = calculatedMd5;
                    } else {
                        // WebDAV might be stale. We warn but allow it (don't throw),
                        // because user might still want to read the (slightly old) file.
                        this.parentHost.log(
                            "warn",
                            "Integrity Warning: WebDAV file might be outdated.",
                            "AttachmentService",
                        );
                    }
                }
            } else {
                finalMd5 = SparkMD5.ArrayBuffer.hash(buffer);
                this.parentHost.log(
                    "debug",
                    "Attachment MD5 generated locally (server MD5 unavailable).",
                    "AttachmentService",
                    {
                        itemKey: item.key,
                        md5: finalMd5,
                    },
                );
            }

            // C. Save to Cache
            if (this.settings.useCache) {
                try {
                    this.parentHost.log(
                        "debug",
                        "Saving attachment to cache.",
                        "AttachmentService",
                        {
                            itemKey: item.key,
                            bytes: buffer.byteLength,
                            md5: finalMd5,
                        },
                    );
                    const fileRecord: IDBZoteroFile = {
                        libraryID: item.libraryID,
                        key: item.key,
                        buffer: buffer,
                        mimeType:
                            item.raw.data.contentType || "application/pdf",
                        fileName: item.raw.data.filename || "file.pdf",
                        md5: finalMd5,
                        lastAccessedAt: new Date().toISOString(),
                        size: buffer.byteLength,
                    };

                    await db.files.put(fileRecord);
                    this.parentHost.log(
                        "debug",
                        "Attachment cache write complete.",
                        "AttachmentService",
                        {
                            itemKey: item.key,
                            bytes: fileRecord.size,
                        },
                    );

                    // Fire & Forget Pruning
                    this.pruneCache().catch((e) =>
                        this.parentHost.log(
                            "error",
                            "Background prune failed",
                            "AttachmentService",
                            e,
                        ),
                    );
                } catch (e) {
                    this.parentHost.log(
                        "error",
                        "Failed to save to cache",
                        "AttachmentService",
                        e,
                    );
                    // Cache failure shouldn't stop the user from viewing the file, so we don't throw.
                }
            }
        }

        this.parentHost.log(
            "debug",
            "Attachment download task finished.",
            "AttachmentService",
            {
                itemKey: item.key,
                linkMode,
                blobSize: blob.size,
                elapsedMs: Date.now() - startedAt,
            },
        );

        return blob;
    }

    /**
     * Download from WebDAV
     */
    private async downloadFromWebDAV(key: string): Promise<ArrayBuffer> {
        const startedAt = Date.now();
        try {
            const zipPath = `${key}.zip`;
            this.parentHost.log(
                "debug",
                "Starting WebDAV zip fetch for attachment.",
                "AttachmentService",
                {
                    itemKey: key,
                    zipPath,
                },
            );
            const buffer = await this.webdav.downloadFile(zipPath);
            this.parentHost.log(
                "debug",
                "WebDAV zip payload received.",
                "AttachmentService",
                {
                    itemKey: key,
                    zipPath,
                    bytes: buffer.byteLength,
                },
            );

            if (!buffer) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.RESOURCE_MISSING,
                    "AttachmentService",
                    `WebDAV file ${zipPath} is empty or missing`,
                );
            }

            const uint8Input = new Uint8Array(buffer);
            this.parentHost.log(
                "debug",
                "Unzipping WebDAV payload.",
                "AttachmentService",
                {
                    itemKey: key,
                    zipPath,
                    inputBytes: uint8Input.byteLength,
                },
            );

            // Wrap unzip in a promise to handle async callback errors
            return await new Promise<ArrayBuffer>((resolve, reject) => {
                unzip(
                    uint8Input,
                    {
                        filter: (file) =>
                            !file.name.endsWith("/") &&
                            !file.name.startsWith(".") &&
                            !file.name.endsWith(".prop"),
                    },
                    (err, unzipped) => {
                        if (err) {
                            this.parentHost.log(
                                "debug",
                                "WebDAV unzip failed.",
                                "AttachmentService",
                                {
                                    itemKey: key,
                                    zipPath,
                                    errorMessage: err.message,
                                },
                            );
                            reject(
                                new ZotFlowError(
                                    ZotFlowErrorCode.PARSE_ERROR,
                                    "AttachmentService",
                                    `Unzip failed: ${err.message}`,
                                ),
                            );
                            return;
                        }

                        const targetFileName = Object.keys(unzipped)[0];
                        if (!targetFileName || !unzipped[targetFileName]) {
                            this.parentHost.log(
                                "debug",
                                "WebDAV unzip returned no valid payload file.",
                                "AttachmentService",
                                {
                                    itemKey: key,
                                    zipPath,
                                    entryCount: Object.keys(unzipped).length,
                                },
                            );
                            reject(
                                new ZotFlowError(
                                    ZotFlowErrorCode.PARSE_ERROR,
                                    "AttachmentService",
                                    "Empty ZIP or only .prop found",
                                ),
                            );
                            return;
                        }

                        this.parentHost.log(
                            "debug",
                            "WebDAV unzip selected payload entry.",
                            "AttachmentService",
                            {
                                itemKey: key,
                                zipPath,
                                entryCount: Object.keys(unzipped).length,
                                targetFileName,
                                payloadBytes:
                                    unzipped[targetFileName]!.byteLength,
                                elapsedMs: Date.now() - startedAt,
                            },
                        );

                        resolve(
                            unzipped[targetFileName]!.buffer as ArrayBuffer,
                        );
                    },
                );
            });
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "AttachmentService",
                `WebDAV Download Error:`,
            );
        }
    }

    /**
     * Zotero API
     * Throws ZotFlowError on failure
     */
    private async downloadFromZoteroAPI(
        item: IDBZoteroItem<AttachmentData>,
    ): Promise<ArrayBuffer> {
        try {
            const response = await fetch(
                `https://api.zotero.org/${item.raw.library.type}s/${item.libraryID}/items/${item.key}/file`,
                {
                    headers: {
                        "Zotero-API-Key": this.settings.zoteroapikey,
                    },
                },
            );

            if (!response.ok) {
                // Translate HTTP Status Codes to ZotFlowErrorCode
                if (response.status === 403 || response.status === 401) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.AUTH_INVALID,
                        "AttachmentService",
                        `Zotero API Auth Failed: ${response.status}`,
                    );
                }
                if (response.status === 404) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "AttachmentService",
                        `File not found on Zotero Server`,
                    );
                }
                if (response.status === 429) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.API_LIMIT,
                        "AttachmentService",
                        `Zotero API Rate Limit Exceeded`,
                    );
                }
                throw new ZotFlowError(
                    ZotFlowErrorCode.NETWORK_ERROR,
                    "AttachmentService",
                    `Zotero API Error: ${response.status} ${response.statusText}`,
                );
            }

            const buffer = await response.arrayBuffer();

            // Handle ZIP response from API (rare but possible for some storage modes)
            if (response.headers.get("content-type") === "application/zip") {
                const uint8Input = new Uint8Array(buffer);
                return await new Promise<ArrayBuffer>((resolve, reject) => {
                    unzip(
                        uint8Input,
                        {
                            filter: (file) =>
                                !file.name.endsWith("/") &&
                                !file.name.startsWith(".") &&
                                !file.name.endsWith(".prop"),
                        },
                        (err, unzipped) => {
                            if (err) {
                                reject(
                                    new ZotFlowError(
                                        ZotFlowErrorCode.PARSE_ERROR,
                                        "AttachmentService",
                                        `API Zip Unzip failed: ${err.message}`,
                                    ),
                                );
                                return;
                            }
                            const targetFileName = Object.keys(unzipped)[0];
                            if (!targetFileName) {
                                reject(
                                    new ZotFlowError(
                                        ZotFlowErrorCode.PARSE_ERROR,
                                        "AttachmentService",
                                        "API ZIP Empty",
                                    ),
                                );
                                return;
                            }
                            resolve(
                                unzipped[targetFileName]!.buffer as ArrayBuffer,
                            );
                        },
                    );
                });
            }

            return buffer;
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "AttachmentService",
                `API Fetch Failed: ${(e as Error).message}`,
            );
        }
    }

    /**
     * Return the total size in bytes of all cached files.
     */
    async getCacheTotalSizeBytes(): Promise<number> {
        const allFiles = await db.files.toArray();
        return allFiles.reduce((acc, file) => acc + (file.size || 0), 0);
    }

    /**
     * Delete all cached files.
     */
    async purgeCache(): Promise<void> {
        await db.files.clear();
    }

    /**
     * LRU Cache Pruning
     */
    private async pruneCache() {
        try {
            const limitMB = this.settings.maxCacheSizeMB;
            const limitBytes = limitMB * 1024 * 1024;

            const allFiles = await db.files.toArray();
            let totalSize = allFiles.reduce(
                (acc, file) => acc + (file.size || 0),
                0,
            );

            if (totalSize <= limitBytes || limitBytes === 0) return;

            this.parentHost.log(
                "info",
                `Cache size (${(totalSize / 1024 / 1024).toFixed(1)}MB) exceeds limit (${limitMB}MB). Pruning...`,
                "AttachmentService",
            );

            const sortedFiles = allFiles.sort((a, b) =>
                (a.lastAccessedAt || "").localeCompare(b.lastAccessedAt || ""),
            );

            const keysToDelete: [number, string][] = [];

            for (const file of sortedFiles) {
                if (totalSize <= limitBytes) break;
                totalSize -= file.size || 0;
                keysToDelete.push([file.libraryID, file.key]);
            }

            if (keysToDelete.length > 0) {
                await db.transaction("rw", db.files, async () => {
                    await db.files.bulkDelete(keysToDelete);
                });
                this.parentHost.log(
                    "info",
                    `Pruned ${keysToDelete.length} files.`,
                    "AttachmentService",
                );
            }
        } catch (e) {
            this.parentHost.log(
                "error",
                `Prune cache failed: ${(e as Error).message}`,
                "AttachmentService",
                e,
            );
        }
    }
}
