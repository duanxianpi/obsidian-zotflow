import { db } from "db/db";
import { ZoteroAPIService } from "./zotero";
import { LibraryService } from "./library";
import { normalizeItem, normalizeCollection, toZoteroDate } from "db/normalize";
import pLimit from "p-limit";
import {
    errorMessage,
    errorStatus,
    ZotFlowError,
    ZotFlowErrorCode,
} from "utils/error";

import type { ZotFlowSettings } from "settings/types";
import type { IParentProxy } from "bridge/types";
import type { ItemIdentifier } from "worker/tasks/impl/batch-extract-images-task";
import type { AnyZoteroItem, ZoteroCollection } from "types/zotero";
import type {
    AnyIDBZoteroItem,
    IDBZoteroCollection,
} from "types/db-schema";

const PULL_BULK_SIZE = 100;
const UPDATE_BULK_SIZE = 50;
const MAX_PUSH_RETRIES = 3;

/**
 * An item envelope prepared for Zotero's multi-write endpoint. Only the fields
 * the payload builder rewrites are named; the rest of the item's own data is
 * passed through untouched, which is why `data` stays open.
 */
interface WritePayload {
    key?: string;
    version?: number;
    data: {
        key?: string;
        version?: number;
        dateAdded?: string;
        dateModified?: string;
        /** ZotFlow-only; stripped before the item is sent. */
        annotationIsExternal?: boolean;
        [field: string]: unknown;
    };
}

/**
 * What the server echoes back for one item in a multi-write response: either
 * the stored item, or — for an item Zotero reports as unchanged — a marker the
 * push loop synthesises so both cases can be handled together.
 */
type WriteEcho = AnyZoteroItem | { key: string; version: number; isUnchanged: true };

/** Zotero's multi-write response body, keyed by the item's index in the chunk. */
interface WriteResponse {
    successful?: Record<string, AnyZoteroItem>;
    unchanged?: Record<string, unknown>;
    failed?: Record<string, { code?: number; message?: string }>;
}

/** Bidirectional sync engine — pulls items/collections from Zotero and pushes local changes. */
export class SyncService {
    constructor(
        private zotero: ZoteroAPIService,
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private library: LibraryService,
    ) {}

    public updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /**
     * Start the synchronization process.
     * This is the main entry point for the worker sync task.
     */
    async startSync(
        signal?: AbortSignal,
        onProgress?: (
            completed: number,
            total: number,
            message: string,
        ) => void,
        libraryId?: number,
    ): Promise<{
        successCount: number;
        failCount: number;
        changedItems: ItemIdentifier[];
        syncedLibraryIDs: number[];
    }> {
        if (signal?.aborted) {
            return {
                successCount: 0,
                failCount: 0,
                changedItems: [],
                syncedLibraryIDs: [],
            };
        }

        if (!navigator.onLine) {
            throw new ZotFlowError(
                ZotFlowErrorCode.NETWORK_ERROR,
                "SyncService",
                "Device is offline",
            );
        }

        const apiKey = this.settings.zoteroapikey;
        const librariesConfig = this.settings.librariesConfig;

        if (!apiKey) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "SyncService",
                "API Key missing",
            );
        }

        let keyInfo;
        try {
            keyInfo = await db.keys.get(apiKey);
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.DB_OPEN_FAILED,
                "SyncService",
                "Failed to query Key DB",
            );
        }

        if (!keyInfo) {
            throw new ZotFlowError(
                ZotFlowErrorCode.AUTH_INVALID,
                "SyncService",
                "API Key not found in local DB",
            );
        }

        const libraries = keyInfo.joinedGroups || [];
        libraries.unshift(keyInfo.userID);

        if (!librariesConfig) {
            this.parentHost.log(
                "warn",
                "No libraries configured for sync.",
                "SyncService",
            );
            return {
                successCount: 0,
                failCount: 0,
                changedItems: [],
                syncedLibraryIDs: [],
            };
        }

        // Build the active library list for progress reporting
        const activeLibraries: number[] = [];

        if (libraryId !== undefined) {
            // Sync a specific library — still validate it exists and isn't ignored
            const libConfig = librariesConfig[libraryId];
            const lib = await db.libraries.get(libraryId);
            if (lib && libConfig && libConfig.mode !== "ignored") {
                activeLibraries.push(libraryId);
            } else {
                this.parentHost.log(
                    "warn",
                    `Library ${libraryId} is ignored or not found.`,
                    "SyncService",
                );
                return {
                    successCount: 0,
                    failCount: 0,
                    changedItems: [],
                    syncedLibraryIDs: [],
                };
            }
        } else {
            for (const libKey of libraries) {
                const libConfig = librariesConfig[libKey];
                const lib = await db.libraries.get(libKey);
                if (lib && libConfig && libConfig.mode !== "ignored") {
                    activeLibraries.push(libKey);
                }
            }
        }

        let successCount = 0;
        let failCount = 0;
        const changedItems: ItemIdentifier[] = [];

        this.parentHost.log("debug", "Starting sync", "SyncService");

        try {
            const totalLibs = activeLibraries.length;

            for (let i = 0; i < activeLibraries.length; i++) {
                const libKey = activeLibraries[i]!;
                if (signal?.aborted) throw new Error("Aborted");
                const libConfig = librariesConfig[libKey];
                const lib = await db.libraries.get(libKey);

                // Skip ignored or missing libraries (defensive, already filtered)
                if (!lib || !libConfig || libConfig.mode === "ignored")
                    continue;

                onProgress?.(i, totalLibs, `Syncing library: ${lib.name}`);

                try {
                    // Logic: Pull Collections -> Pull Items -> Push Changes (if bidirectional)
                    await this.pullCollections(lib.type, libKey);
                    await this.pullItems(lib.type, libKey, changedItems);

                    if (libConfig.mode === "bidirectional") {
                        for (
                            let attempt = 0;
                            attempt < MAX_PUSH_RETRIES;
                            attempt++
                        ) {
                            const { retryNeeded } = await this.pushDirtyItems(
                                lib.type,
                                libKey,
                            );
                            if (!retryNeeded) break;

                            this.parentHost.log(
                                "info",
                                `Push returned 412 (attempt ${attempt + 1}/${MAX_PUSH_RETRIES}). Re-pulling before retry...`,
                                "SyncService",
                            );
                            await this.pullItems(
                                lib.type,
                                libKey,
                                changedItems,
                            );

                            if (attempt === MAX_PUSH_RETRIES - 1) {
                                this.parentHost.log(
                                    "warn",
                                    `Push failed after ${MAX_PUSH_RETRIES} retries for library ${libKey}. Remaining dirty items will sync next time.`,
                                    "SyncService",
                                );
                            }
                        }
                    }

                    // Stamp the library's last-sync timestamp on success so
                    // the Activity Center reflects the most recent run.
                    await db.libraries.update(libKey, {
                        syncedAt: new Date().toISOString().split(".")[0] + "Z",
                    });

                    successCount++;
                } catch (error: unknown) {
                    failCount++;
                    const msg =
                        error instanceof Error ? error.message : String(error);
                    this.parentHost.log("error", msg, "SyncService", error);

                    // Specific notification for sub-tasks, but don't abort other libraries
                    this.parentHost.notify(
                        "error",
                        `Library ${libKey} Sync Failed: ${msg}`,
                    );
                }
            }

            onProgress?.(totalLibs, totalLibs, "Sync completed");

            if (failCount === 0) {
                this.parentHost.notify(
                    "success",
                    "Sync completed successfully!",
                );
            } else {
                this.parentHost.notify(
                    "info",
                    `Sync finished with ${failCount} errors.`,
                );
            }

            return {
                successCount,
                failCount,
                changedItems,
                syncedLibraryIDs: activeLibraries,
            };
        } catch (error) {
            // Catastrophic failure (e.g., DB crash)
            this.parentHost.log(
                "error",
                errorMessage(error),
                "SyncService",
                error,
            );

            this.parentHost.notify(
                "error",
                `Critical Sync Failure: ${errorMessage(error)}`,
            );
            throw error; // Re-throw so TaskLayer can track it as failed
        } finally {
            this.parentHost.log("info", "Sync finished.", "SyncService");
        }
    }

    /* ================================================================ */
    /*  Collection Pull                                                */
    /* ================================================================ */
    private async pullCollections(
        libraryType: "user" | "group",
        libraryID: number,
    ) {
        if (!this.zotero) {
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "SyncService",
                "Zotero Service not initialized",
            );
        }

        try {
            const libHandle = this.zotero.client.library(
                libraryType,
                libraryID,
            );

            // Get Local Version
            const libState = await db.libraries.get(libraryID);
            const localVersion = libState?.collectionVersion || 0;

            this.parentHost.log(
                "debug",
                `Pulling collections from v${localVersion}...`,
                "SyncService",
            );

            // Get Changed Versions
            const response = await libHandle.collections().get({
                format: "versions",
                since: localVersion,
                includeTrashed: true,
            });

            const versionsMap = (await (response.raw as Response).json()) as Record<
                string,
                number
            >;
            const serverHeaderVersion = response.getVersion() || 0;

            // Early Return
            if (serverHeaderVersion <= localVersion) {
                this.parentHost.log(
                    "debug",
                    "Collections are up to date.",
                    "SyncService",
                );
                return;
            }

            const keysToFetch = Object.keys(versionsMap);

            // Batch Fetch Data
            if (keysToFetch.length > 0) {
                const slices = this.chunkArray(keysToFetch, PULL_BULK_SIZE);
                let processedCount = 0;

                for (const slice of slices) {
                    const batchRes = await libHandle.collections().get({
                        collectionKey: slice.join(","),
                        includeTrashed: true,
                    });
                    const newCollections = batchRes.raw as ZoteroCollection[];

                    if (newCollections.length > 0) {
                        // Collections are pull-only: nothing in the plugin
                        // edits one locally, so the server copy always wins and
                        // there is no local state to read first.
                        await db.transaction("rw", db.collections, async () => {
                            await db.collections.bulkPut(
                                newCollections.map((remoteRaw) =>
                                    normalizeCollection(remoteRaw, libraryID),
                                ),
                            );
                        });
                    }

                    processedCount += newCollections.length;

                    this.parentHost.log(
                        "debug",
                        `Updated ${processedCount} collections in Library ${libraryID}...`,
                        "SyncService",
                    );
                }

                this.parentHost.log(
                    "debug",
                    `Updated ${keysToFetch.length} collections.`,
                    "SyncService",
                );
            }

            // Handle Deletions (Safe Cascade)
            if (localVersion > 0) {
                const delResponse = await libHandle.deleted(localVersion).get();
                const deletedKeys = (
                    delResponse.getData() as { collections: string[] }
                ).collections;

                if (deletedKeys.length > 0) {
                    await this.handlePullCollectionDeletions(
                        libraryID,
                        deletedKeys,
                    );
                }
            }

            // Update Version
            await db.libraries.update(libraryID, {
                collectionVersion: serverHeaderVersion,
            });
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "SyncService",
                "Pull Collections failed",
            );
        }
    }

    /* ================================================================ */
    /*  Helper: Safe Cascade Collection Delete                          */
    /* ================================================================ */
    private async handlePullCollectionDeletions(
        libraryID: number,
        keysToDelete: string[],
    ) {
        if (keysToDelete.length === 0) return;

        await db.transaction("rw", db.collections, async () => {
            for (const targetKey of keysToDelete) {
                const targetCol = await db.collections.get([
                    libraryID,
                    targetKey,
                ]);
                if (!targetCol) continue;

                // Recursively get all descendants
                const descendants = await this.getAllCollectionDescendants(
                    libraryID,
                    targetKey,
                );
                // Collections are pull-only, so there are never local changes
                // to weigh against a remote deletion — unlike items, which get
                // a dirty-family check before the cascade runs.
                const family = [targetCol, ...descendants];

                await db.collections.bulkDelete(
                    family.map((c) => [libraryID, c.key]),
                );

                this.parentHost.log(
                    "debug",
                    `Deleted Collection ${targetKey} and ${descendants.length} sub-collections.`,
                    "SyncService",
                );
            }
        });
    }

    // Recursively get Collection descendants
    private async getAllCollectionDescendants(
        libraryID: number,
        parentKey: string,
        visited: Set<string> = new Set(),
    ): Promise<IDBZoteroCollection[]> {
        // Guard: empty parentKey would match ALL top-level collections
        if (!parentKey) return [];

        // Guard: a cyclic parentCollection would otherwise recurse forever,
        // and it would do so inside the caller's open Dexie transaction.
        if (visited.has(parentKey)) return [];
        visited.add(parentKey);

        const children = await db.collections
            .where({
                libraryID: libraryID,
                parentCollection: parentKey,
            })
            .toArray();

        if (children.length === 0) return [];

        const grandChildPromises = children.map((child) =>
            this.getAllCollectionDescendants(libraryID, child.key, visited),
        );
        const grandChildrenArrays = await Promise.all(grandChildPromises);

        let allDescendants = [...children];
        for (const grandChildren of grandChildrenArrays) {
            allDescendants = allDescendants.concat(grandChildren);
        }
        return allDescendants;
    }

    /* ================================================================ */
    /*  Item Pull                                                      */
    /* ================================================================ */
    private async pullItems(
        libraryType: "user" | "group",
        libraryID: number,
        changedItems?: ItemIdentifier[],
    ) {
        if (!this.zotero) return;

        try {
            const libHandle = this.zotero.client.library(
                libraryType,
                libraryID,
            );
            const libState = await db.libraries.get(libraryID);
            const localVersion = libState?.itemVersion || 0;

            this.parentHost.log(
                "debug",
                `Pulling items from v${localVersion}...`,
                "SyncService",
            );

            const response = await libHandle.items().get({
                format: "versions",
                since: localVersion,
                includeTrashed: true,
            });

            const versionsMap = (await (response.raw as Response).json()) as Record<
                string,
                number
            >;
            const serverHeaderVersion = response.getVersion() || 0;

            if (serverHeaderVersion <= localVersion) {
                this.parentHost.log(
                    "debug",
                    "Items are up to date.",
                    "SyncService",
                );
                return;
            }

            const keysToFetch = Object.keys(versionsMap);
            this.parentHost.log(
                "debug",
                `Found ${keysToFetch.length} items to update.`,
                "SyncService",
            );

            // Batch Fetch Data & Upsert
            if (keysToFetch.length > 0) {
                const slices = this.chunkArray(keysToFetch, PULL_BULK_SIZE);
                let processedCount = 0;

                for (const slice of slices) {
                    const batchRes = await libHandle.items().get({
                        itemKey: slice.join(","),
                        includeTrashed: true,
                        // csljson: server-side canonical item -> CSL-JSON
                        // conversion, stored for the citation template filters.
                        include: "data,csljson",
                    });

                    const newItems = batchRes.raw as AnyZoteroItem[];

                    const collectionUpdate = Promise.all(
                        newItems.map(async (newItem) => {
                            const localItem = await db.items.get([
                                libraryID,
                                newItem.key,
                            ]);

                            // Scenario A: Item exists locally
                            if (localItem) {
                                switch (localItem.syncStatus) {
                                    case "created":
                                    case "updated":
                                    case "deleted":
                                    case "conflict":
                                        await db.items.update(
                                            [libraryID, localItem.key],
                                            {
                                                serverCopyRaw: newItem,
                                                syncStatus: "conflict",
                                                syncError:
                                                    "Remote update conflict",
                                                version: newItem.version,
                                            },
                                        );
                                        return; // Keep local changes
                                    case "synced":
                                    case "ignore":
                                        break; // Continue with overwrite logic
                                }
                            }

                            // Scenario B: Overwrite/Insert
                            const cleanItem = normalizeItem(newItem, libraryID);
                            cleanItem.syncStatus = "synced";
                            await db.items.put(cleanItem);
                            changedItems?.push({
                                libraryID,
                                itemKey: cleanItem.key,
                            });
                        }),
                    );

                    await collectionUpdate;
                    processedCount += newItems.length;
                }
                this.parentHost.log(
                    "debug",
                    `Updated ${processedCount} items in Library ${libraryID}...`,
                    "SyncService",
                );
            }

            // Handle Deletions
            if (localVersion > 0) {
                const delResponse = await libHandle.deleted(localVersion).get();
                const deletedKeys = (
                    delResponse.getData() as { items?: string[] }
                ).items;

                if (deletedKeys && deletedKeys.length > 0) {
                    await this.handlePullDeletions(
                        libraryID,
                        deletedKeys,
                        changedItems,
                    );
                }
            }

            await db.libraries.update(libraryID, {
                itemVersion: serverHeaderVersion,
            });
            this.parentHost.log(
                "debug",
                `Item sync finished. New Version: ${serverHeaderVersion}`,
                "SyncService",
            );
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "SyncService",
                "Pull Items failed",
            );
        }
    }

    /* ================================================================ */
    /*  Helper: Safe Cascade Delete                                    */
    /* ================================================================ */
    private async handlePullDeletions(
        libraryID: number,
        keysToDelete: string[],
        changedItems?: ItemIdentifier[],
    ) {
        if (keysToDelete.length === 0) return;

        // Visual (image/ink) annotation keys whose rendered image files must be
        // removed from disk. Collected inside the transaction, deleted after it
        // commits — file I/O must never run inside a Dexie transaction.
        const imageKeysToDelete: string[] = [];

        await db.transaction("rw", db.items, async () => {
            for (const targetKey of keysToDelete) {
                const targetItem = await db.items.get([libraryID, targetKey]);
                if (!targetItem) continue;

                // Recursively get descendants
                const descendants = await this.getAllDescendants(
                    libraryID,
                    targetKey,
                );
                const family = [targetItem, ...descendants];

                const dirtyNode = family.find((item) =>
                    ["created", "updated", "deleted", "conflict"].includes(
                        item.syncStatus,
                    ),
                );

                if (dirtyNode) {
                    this.parentHost.log(
                        "warn",
                        `Prevented deletion of ${targetKey} due to local changes.`,
                        "SyncService",
                    );
                    await db.items.update([libraryID, targetKey], {
                        syncStatus: "conflict",
                        syncError:
                            "Remote deletion blocked: Contains unsynced local changes.",
                        serverCopyRaw: undefined,
                    });
                } else {
                    // Capture surviving top-level ancestor for post-sync
                    // source-note refresh. Deleted annotations/notes/
                    // attachments do not bump the parent's version, so
                    // without this the parent's note would never refresh.
                    if (changedItems && targetItem.parentItem) {
                        const CHILD_TYPES = new Set([
                            "annotation",
                            "attachment",
                            "note",
                        ]);
                        const MAX_DEPTH = 5;
                        let ancestor = await db.items.get([
                            libraryID,
                            targetItem.parentItem,
                        ]);
                        let depth = 0;
                        while (
                            ancestor &&
                            CHILD_TYPES.has(ancestor.itemType) &&
                            ancestor.parentItem &&
                            depth < MAX_DEPTH
                        ) {
                            ancestor = await db.items.get([
                                libraryID,
                                ancestor.parentItem,
                            ]);
                            depth++;
                        }
                        if (ancestor && !CHILD_TYPES.has(ancestor.itemType)) {
                            changedItems.push({
                                libraryID,
                                itemKey: ancestor.key,
                            });
                        }
                    }

                    const keysToRemove = family.map((i) => i.key);
                    await db.items.bulkDelete(
                        keysToRemove.map((k) => [libraryID, k]),
                    );

                    // Queue rendered images of any deleted image/ink
                    // annotations for removal after the transaction commits.
                    for (const member of family) {
                        if (
                            member.itemType === "annotation" &&
                            (member.raw?.data?.annotationType ===
                                "image" ||
                                member.raw?.data?.annotationType ===
                                    "ink")
                        ) {
                            imageKeysToDelete.push(member.key);
                        }
                    }

                    this.parentHost.log(
                        "debug",
                        `Deleted ${targetKey} and ${descendants.length} descendants.`,
                        "SyncService",
                    );
                }
            }
        });

        // Remove orphaned annotation image files (outside the transaction).
        for (const key of imageKeysToDelete) {
            await this.deleteAnnotationImageFile(key);
        }
    }

    /**
     * Delete a rendered annotation image (`{folder}/{key}.png`) from the vault,
     * if it exists. Best-effort — failures are logged, never thrown.
     */
    private async deleteAnnotationImageFile(annotationKey: string) {
        const folder = this.settings.annotationImageFolder.replace(/\/$/, "");
        const path = `${folder}/${annotationKey}.png`;
        try {
            const exists = await this.parentHost.checkFile(path);
            if (exists.exists) {
                await this.parentHost.deleteFile(path);
                this.parentHost.log(
                    "debug",
                    `Deleted orphaned annotation image: ${path}`,
                    "SyncService",
                );
            }
        } catch (e) {
            this.parentHost.log(
                "warn",
                `Failed to delete annotation image ${annotationKey}`,
                "SyncService",
                e,
            );
        }
    }

    private async getAllDescendants(
        libraryID: number,
        parentKey: string,
        visited: Set<string> = new Set(),
    ): Promise<AnyIDBZoteroItem[]> {
        // Guard: empty parentKey would match ALL top-level items
        if (!parentKey) return [];

        // Guard: a cyclic parentItem would otherwise recurse forever, and it
        // would do so inside the caller's open Dexie transaction.
        if (visited.has(parentKey)) return [];
        visited.add(parentKey);

        const children = await db.items
            .where({ libraryID: libraryID, parentItem: parentKey })
            .toArray();

        if (children.length === 0) return [];

        const grandChildPromises = children.map((child) =>
            this.getAllDescendants(libraryID, child.key, visited),
        );
        const grandChildrenArrays = await Promise.all(grandChildPromises);

        let allDescendants = [...children];
        for (const grandChildren of grandChildrenArrays) {
            allDescendants = allDescendants.concat(grandChildren);
        }
        return allDescendants;
    }

    /* ================================================================ */
    /*  Push Changes                                                   */
    /* ================================================================ */
    public async pushDirtyItems(
        libraryType: "user" | "group",
        libraryID: number,
    ): Promise<{ retryNeeded: boolean }> {
        if (!this.zotero) return { retryNeeded: false };

        const apiKey = this.settings.zoteroapikey;
        if (!apiKey) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "SyncService",
                "No API key found for push.",
            );
        }

        // Get current library version for write checks
        const libState = await db.libraries.get(libraryID);
        let latestVersion = libState?.itemVersion || 0;

        // Step 1: Fetch Dirty Items
        const dirtyParams = [
            [libraryID, "created"],
            [libraryID, "updated"],
            [libraryID, "deleted"],
        ];

        const dirtyItems = await db.items
            .where(["libraryID", "syncStatus"])
            .anyOf(dirtyParams)
            .toArray();

        // When the API key lacks notes write permission for this library,
        // skip note items on push — Zotero would 403 anyway. Locally-modified
        // notes stay dirty so they can sync later if permissions change.
        const hasNotesAccess = await this.library.hasNotesAccess(libraryID);
        let filteredItems = dirtyItems;
        if (!hasNotesAccess) {
            filteredItems = dirtyItems.filter((i) => i.itemType !== "note");
            const skipped = dirtyItems.length - filteredItems.length;
            if (skipped > 0) {
                this.parentHost.log(
                    "warn",
                    `Skipping ${skipped} dirty note item(s) on push for library ${libraryID} (no notes permission).`,
                    "SyncService",
                );
            }
        }

        this.parentHost.log(
            "debug",
            `Dirty items to push: ${filteredItems.length}`,
            "SyncService",
        );

        if (filteredItems.length === 0) return { retryNeeded: false };

        const deletions = filteredItems.filter(
            (i) => i.syncStatus === "deleted",
        );
        const upserts = filteredItems.filter(
            (i) => i.syncStatus === "created" || i.syncStatus === "updated",
        );

        this.parentHost.log(
            "debug",
            `Pushing changes: ${deletions.length} deletions, ${upserts.length} upserts.`,
            "SyncService",
        );

        // Step 2: Handle Deletions
        if (deletions.length > 0) {
            const limit = pLimit(5);
            const deletePromises = deletions.map((item) => {
                return limit(async () => {
                    try {
                        const delResponse = await this.zotero.client
                            .library(libraryType, libraryID)
                            .items(item.key)
                            .delete([], {
                                ifUnmodifiedSinceVersion: item.version,
                            });

                        // Track latest library version from delete response
                        const delVersion = delResponse.getVersion();
                        if (delVersion !== null && delVersion > latestVersion) {
                            latestVersion = delVersion;
                        }

                        await db.items.delete([libraryID, item.key]);
                        this.parentHost.log(
                            "debug",
                            `Successfully deleted: ${item.key}`,
                            "SyncService",
                        );
                    } catch (e) {
                        // Error Handling logic preserved from original business logic
                        const status = errorStatus(e);

                        if (status === 412) {
                            this.parentHost.log(
                                "warn",
                                `Delete Conflict for ${item.key}`,
                                "SyncService",
                            );
                            await db.items.update([libraryID, item.key], {
                                syncStatus: "conflict",
                                syncError:
                                    "Remote item has been modified since you deleted it.",
                            });
                        } else if (status === 404) {
                            await db.items.delete([libraryID, item.key]);
                        } else {
                            this.parentHost.log(
                                "error",
                                `Failed to delete ${item.key}:`,
                                "SyncService",
                                errorMessage(e),
                            );
                            // We don't throw here to avoid stopping the batch
                        }
                    }
                });
            });
            await Promise.all(deletePromises);
        }

        // Step 3: Handle Upserts
        if (upserts.length > 0) {
            const chunks = this.chunkArray(upserts, UPDATE_BULK_SIZE);

            for (const chunk of chunks) {
                // Prepare Payload & Sanitization
                const payload = chunk.map((item) => {
                    const itemRawData = {
                        ...item.raw,
                    } as unknown as WritePayload;

                    if (itemRawData.data.dateAdded)
                        itemRawData.data.dateAdded = toZoteroDate(
                            itemRawData.data.dateAdded,
                        );

                    itemRawData.data.dateModified = toZoteroDate(
                        new Date().toISOString(),
                    );

                    if (item.syncStatus === "created") {
                        // Keep client-provided key so the server adopts it
                        itemRawData.key = item.key;
                        itemRawData.data.key = item.key;
                        delete itemRawData.version;
                        delete itemRawData.data.version;
                    } else {
                        itemRawData.key = item.key;
                        itemRawData.data.key = item.key;
                        itemRawData.version = item.version;
                        itemRawData.data.version = item.version;
                    }

                    // Remove annotationIsExternal
                    delete itemRawData.data.annotationIsExternal;
                    return itemRawData;
                });

                try {
                    const response = await this.zotero.client
                        .library(libraryType, libraryID)
                        .items()
                        .post(payload, {
                            ifUnmodifiedSinceVersion: latestVersion,
                        });

                    // Track latest library version from write response
                    const postVersion = response.getVersion();
                    if (postVersion !== null && postVersion > latestVersion) {
                        latestVersion = postVersion;
                    }

                    const resData = response.raw as WriteResponse;
                    const successful = resData.successful || {};
                    const failed = resData.failed || {};
                    const unchanged = resData.unchanged || {};

                    const validUpdates: AnyIDBZoteroItem[] = [];
                    const idsToDelete: string[] = [];

                    // Process each item in the chunk
                    chunk.forEach((item, index) => {
                        const indexStr = String(index);
                        const itemKey = item.key;
                        let serverResponseItem: WriteEcho | null = null;
                        let failData: { code?: number; message?: string } | null =
                            null;

                        // Handle created items
                        if (item.syncStatus === "created") {
                            // If successful, update item with server response
                            if (successful[indexStr])
                                serverResponseItem = successful[indexStr];
                            // If failed, update item with failure data
                            else if (failed[indexStr])
                                failData = failed[indexStr];
                        } else {
                            // Handle updated items
                            if (successful[indexStr])
                                serverResponseItem = successful[indexStr];
                            // If unchanged, update item with unchanged data
                            else if (unchanged[indexStr])
                                serverResponseItem = {
                                    key: itemKey,
                                    version: item.version,
                                    isUnchanged: true,
                                };
                            // If failed, update item with failure data
                            else if (failed[indexStr])
                                failData = failed[indexStr];
                        }

                        if (serverResponseItem) {
                            const echo = serverResponseItem;
                            const newItem = {
                                ...item,
                                syncStatus: "synced",
                                syncError: undefined,
                                version: echo.version || item.version,
                            } as AnyIDBZoteroItem;

                            if ("data" in echo) {
                                newItem.raw = echo;
                                // For created items the server should echo
                                // back our client-provided key. If it differs
                                // (edge case), fall back to delete-old/insert-new.
                                if (
                                    item.syncStatus === "created" &&
                                    echo.key !== item.key
                                ) {
                                    newItem.key = echo.key;
                                    newItem.raw.key = echo.key;
                                    idsToDelete.push(item.key);
                                }
                            } else if (!echo.isUnchanged) {
                                if (
                                    item.syncStatus === "created" &&
                                    echo.key !== item.key
                                ) {
                                    newItem.key = echo.key;
                                    idsToDelete.push(item.key);
                                }
                            }
                            validUpdates.push(newItem);
                        } else if (failData) {
                            // If failed, update item with failure data
                            this.parentHost.log(
                                "warn",
                                `Item failed ${item.key}:`,
                                "SyncService",
                                failData,
                            );
                            validUpdates.push({
                                ...item,
                                syncStatus: "conflict",
                                syncError: `${failData.code}: ${failData.message}`,
                            });
                        }
                    });

                    if (idsToDelete.length > 0 || validUpdates.length > 0) {
                        await db.transaction("rw", db.items, async () => {
                            if (idsToDelete.length > 0) {
                                await db.items.bulkDelete(
                                    idsToDelete.map((k) => [libraryID, k]),
                                );
                            }
                            if (validUpdates.length > 0) {
                                await db.items.bulkPut(validUpdates);
                            }
                        });
                    }
                } catch (e) {
                    const status = errorStatus(e);
                    if (status === 412) {
                        this.parentHost.log(
                            "warn",
                            "Library modified during push (412). Retry needed.",
                            "SyncService",
                        );
                        return { retryNeeded: true };
                    }

                    // Log but don't stop the whole sync for one batch failure
                    this.parentHost.log(
                        "error",
                        "Batch upload failed:",
                        "SyncService",
                        e,
                    );
                }
            }
        }

        // All writes succeeded — safe to update library version
        if (latestVersion > (libState?.itemVersion || 0)) {
            await db.libraries.update(libraryID, {
                itemVersion: latestVersion,
            });
            this.parentHost.log(
                "debug",
                `Updated library ${libraryID} itemVersion to ${latestVersion} after push.`,
                "SyncService",
            );
        }

        return { retryNeeded: false };
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        const result = [];
        for (let i = 0; i < array.length; i += size) {
            result.push(array.slice(i, i + size));
        }
        return result;
    }
}
