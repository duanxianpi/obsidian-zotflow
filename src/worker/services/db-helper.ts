import { db, getCombinations } from "db/db";
import { Zotero_Item_Types } from "types/zotero-item-const";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { IParentProxy } from "bridge/types";
import type { LibraryService } from "./library";
import type { SearchService, SearchableRecord } from "./search";
import type {
    AnyIDBZoteroItem,
    IDBZoteroItem,
    IDBZoteroCollection,
} from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { ZotFlowSettings } from "settings/types";

/**
 * Worker-side helper service for general-purpose DB operations that
 * don't belong to a domain-specific service.
 */
export class DbHelperService {
    constructor(
        public settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private library: LibraryService,
        private search: SearchService,
    ) {}

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /**
     * Get filtered library IDs based on settings and API key access.
     */
    async getFilteredLibraryIDs(): Promise<number[]> {
        if (!this.settings.zoteroapikey) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "DbHelperService",
                "API Key is missing in settings",
            );
        }
        return this.library.getActiveLibraryIDs();
    }

    /**
     * Get { libraryID, itemKey } for every non-trashed top-level item across
     * the currently active libraries. Used by batch commands that need to
     * enumerate every source-note-bearing item.
     */
    async getAllTopLevelItemIdentifiers(): Promise<
        { libraryID: number; itemKey: string }[]
    > {
        const libraryIDs = await this.getFilteredLibraryIDs();
        if (libraryIDs.length === 0) return [];

        const isValidTopLevel = (type: string) =>
            !(["note", "annotation", "attachment"] as string[]).includes(type);
        const validTopLevelTypeList = Zotero_Item_Types.filter((type) =>
            isValidTopLevel(type),
        );

        const items = await db.items
            .where(["libraryID", "itemType", "trashed"])
            .anyOf(getCombinations([libraryIDs, validTopLevelTypeList, [0]]))
            .filter((item: AnyIDBZoteroItem) => !item.parentItem)
            .toArray();

        return items.map((i) => ({
            libraryID: i.libraryID,
            itemKey: i.key,
        }));
    }

    /**
     * Look up any item by library + key.
     * Returns `undefined` if the item doesn't exist.
     */
    async getItem(
        libraryID: number,
        itemKey: string,
    ): Promise<AnyIDBZoteroItem | undefined> {
        return await db.items.get([libraryID, itemKey]);
    }

    /**
     * Look up an attachment item by library + key.
     * Returns `undefined` if the item doesn't exist or isn't an attachment.
     */
    async getAttachmentItem(
        libraryID: number,
        itemKey: string,
    ): Promise<IDBZoteroItem<AttachmentData> | undefined> {
        const item = await db.items.get([libraryID, itemKey]);
        if (!item || item.itemType !== "attachment") return undefined;
        return item as IDBZoteroItem<AttachmentData>;
    }

    /**
     * Get recently accessed items.
     */
    async getRecentItems(limit: number): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.getFilteredLibraryIDs();
        const isValidTopLevel = (type: string) =>
            !["note", "annotation"].includes(type);

        return await db.items
            .where("lastAccessedAt")
            .above("")
            .reverse()
            .filter(
                (item: AnyIDBZoteroItem) =>
                    libraryIDs.includes(item.libraryID) &&
                    !item.parentItem &&
                    isValidTopLevel(item.itemType) &&
                    !item.trashed,
            )
            .limit(limit)
            .toArray();
    }

    /**
     * Get recently added items (fallback when no recent access exists).
     */
    async getRecentlyAddedItems(limit: number): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.getFilteredLibraryIDs();
        const isValidTopLevel = (type: string) =>
            !["note", "annotation"].includes(type);

        return await db.items
            .orderBy("dateModified")
            .reverse()
            .filter(
                (item: AnyIDBZoteroItem) =>
                    libraryIDs.includes(item.libraryID) &&
                    !item.parentItem &&
                    isValidTopLevel(item.itemType) &&
                    !item.trashed,
            )
            .limit(limit)
            .toArray();
    }

    /**
     * Return all library names for the active libraries, sorted alphabetically.
     * Used for `library:` autocomplete.
     */
    async getLibraryNames(): Promise<string[]> {
        const libraryIDs = await this.getFilteredLibraryIDs();
        if (libraryIDs.length === 0) return [];

        const libs = await db.libraries.where("id").anyOf(libraryIDs).toArray();

        const names = libs
            .map((lib) => lib.name || lib.id.toString())
            .sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: "accent" }),
            );

        return names;
    }

    /**
     * Return all distinct (non-trashed) collection names across the active
     * libraries, sorted alphabetically. Used for `collection:` autocomplete.
     */
    async getCollectionNames(): Promise<string[]> {
        const libraryIDs = await this.getFilteredLibraryIDs();
        if (libraryIDs.length === 0) return [];

        const colls = await db.collections
            .where(["libraryID", "trashed"])
            .anyOf(getCombinations([libraryIDs, [0]]))
            .toArray();

        const names = new Set<string>();
        for (const c of colls) {
            if (c.name) names.add(c.name);
        }
        return Array.from(names).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "accent" }),
        );
    }

    /**
     * Search items by query string.
     *
     * Supports fuzzy free-text matching (title + creators + tags) plus
     * structured operators: `collection:`, `tag:`, `creator:`, `type:`
     * (with `-` negation). Ranking is delegated to the shared SearchService.
     */
    async searchItems(
        query: string,
        limit: number,
    ): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.getFilteredLibraryIDs();
        const parsed = this.search.parse(query);
        const isValidTopLevel = (type: string) =>
            !["note", "annotation"].includes(type);
        const validTopLevelTypeList = Zotero_Item_Types.filter((type) =>
            isValidTopLevel(type),
        );

        const candidates = await db.items
            .where(["libraryID", "itemType", "trashed"])
            .anyOf(getCombinations([libraryIDs, validTopLevelTypeList, [0]]))
            .filter((item: AnyIDBZoteroItem) => !item.parentItem)
            .toArray();

        // Resolve collection names only when a collection filter is present.
        const needsCollections = parsed.filters.some(
            (f) => f.field === "collection",
        );
        const collectionNames = needsCollections
            ? await this.resolveCollectionNames(candidates)
            : null;

        // Resolve library names for library filter.
        const libraryNames = new Map<number, string>();
        if (parsed.filters.some((f) => f.field === "library")) {
            const libs = await db.libraries
                .where("id")
                .anyOf(libraryIDs)
                .toArray();
            for (const lib of libs) {
                libraryNames.set(lib.id, lib.name);
            }
        }

        const byId = new Map<string, AnyIDBZoteroItem>();
        const records: SearchableRecord[] = candidates.map((item) => {
            const id = `${item.libraryID}:${item.key}`;
            byId.set(id, item);
            return {
                id,
                name: item.title || "",
                creators: item.searchCreators,
                tags: item.searchTags,
                itemType: item.itemType,
                libraryName: libraryNames.get(item.libraryID),
                collections: collectionNames
                    ? (item.collections || []).map(
                          (k) =>
                              collectionNames.get(`${item.libraryID}:${k}`) ||
                              "",
                      )
                    : undefined,
            };
        });

        const ranked = this.search.matchAndRank(parsed, records, limit);
        return ranked
            .map((r) => byId.get(r.id))
            .filter((i): i is AnyIDBZoteroItem => i !== undefined);
    }

    /**
     * Build a `${libraryID}:${collectionKey}` → collection name map for every
     * collection referenced by the given items.
     */
    private async resolveCollectionNames(
        items: AnyIDBZoteroItem[],
    ): Promise<Map<string, string>> {
        const keys: [number, string][] = [];
        const seen = new Set<string>();
        for (const item of items) {
            for (const collKey of item.collections || []) {
                const cacheKey = `${item.libraryID}:${collKey}`;
                if (!seen.has(cacheKey)) {
                    seen.add(cacheKey);
                    keys.push([item.libraryID, collKey]);
                }
            }
        }

        const names = new Map<string, string>();
        if (keys.length === 0) return names;

        const colls = await db.collections.bulkGet(keys);
        keys.forEach(([libID, collKey], i) => {
            const coll = colls[i];
            if (coll) names.set(`${libID}:${collKey}`, coll.name);
        });
        return names;
    }

    /**
     * Update an item's access timestamp.
     * If the item is an attachment, also updates the parent item's timestamp.
     */
    async updateLastAccessed(libraryID: number, key: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const item = await db.items.get([libraryID, key]);

        if (item) {
            await db.items.update([libraryID, key], {
                lastAccessedAt: timestamp,
            });

            // If it's a child item (e.g. attachment), also update parent
            if (item.parentItem) {
                await db.items.update([libraryID, item.parentItem], {
                    lastAccessedAt: timestamp,
                });
            }
        }
    }

    /**
     * Get paths (library / collection / ...) for a batch of items.
     * Optimized with Dexie's bulkGet and Level-by-Level Ancestor Resolution.
     */
    async getItemPaths(
        items: { libraryID: number; key: string; collections: string[] }[],
    ): Promise<Record<string, string[]>> {
        const paths: Record<string, string[]> = {};
        if (!items || items.length === 0) return paths;

        // Get unique library IDs and prepare cache
        const uniqueLibIDs = [...new Set(items.map((i) => i.libraryID))];
        const libraryCache: Record<number, string> = {};

        // Dexie bulkGet returns results in the same order as the input array, undefined for missing entries
        const libs = await db.libraries.bulkGet(uniqueLibIDs);
        uniqueLibIDs.forEach((id, index) => {
            libraryCache[id] = libs[index]?.name || `Library ${id}`;
        });

        // Get all collections and prepare cache
        const collectionEntityCache: Record<
            string,
            IDBZoteroCollection | null
        > = {};
        let neededKeysMap = new Map<string, [number, string]>();

        // Collect all lowest-level leaf nodes
        for (const item of items) {
            if (!item.collections) continue;
            for (const collKey of item.collections) {
                if (collKey) {
                    const cacheKey = `${item.libraryID}:${collKey}`;
                    neededKeysMap.set(cacheKey, [item.libraryID, collKey]);
                }
            }
        }

        // BFS: pull parent nodes level by level until all needed nodes are fetched
        while (neededKeysMap.size > 0) {
            // Extract keys to fetch for this round
            const keysToFetch = Array.from(neededKeysMap.values());
            neededKeysMap.clear(); // Clear for next round

            // Fetch all nodes at this level
            const fetchedColls = await db.collections.bulkGet(keysToFetch);

            for (const [i, [libID, collKey]] of keysToFetch.entries()) {
                const cacheKey = `${libID}:${collKey}`;
                const coll = fetchedColls[i];

                // Write to entity cache
                collectionEntityCache[cacheKey] = coll || null;

                // If this node has a parent and it's not in cache, add to next round
                if (coll && coll.parentCollection) {
                    const parentCacheKey = `${libID}:${coll.parentCollection}`;
                    if (
                        collectionEntityCache[parentCacheKey] === undefined &&
                        !neededKeysMap.has(parentCacheKey)
                    ) {
                        neededKeysMap.set(parentCacheKey, [
                            libID,
                            coll.parentCollection,
                        ]);
                    }
                }
            }
        }

        // Build paths in memory
        const collectionPathCache: Record<string, string> = {};

        for (const item of items) {
            const libID = item.libraryID;
            const libName = libraryCache[libID];
            const allCollPaths: string[] = [];

            if (item.collections && item.collections.length > 0) {
                for (const collKey of item.collections) {
                    if (!collKey) continue;

                    const cacheKey = `${libID}:${collKey}`;

                    // If this path has been built by other items, reuse it
                    if (collectionPathCache[cacheKey]) {
                        allCollPaths.push(collectionPathCache[cacheKey]);
                        continue;
                    }

                    // Trace up (all needed nodes are guaranteed to be in collectionEntityCache)
                    const breadcrumbs: string[] = [];
                    let currentKey: string | undefined = collKey;
                    let foundParentPath = "";
                    // A cyclic parentCollection would otherwise loop forever,
                    // and synchronously: nothing in here yields, so the worker
                    // thread would never come back. The path cache cannot stand
                    // in for this — it is only written after the walk finishes.
                    const visitedSteps = new Set<string>();

                    while (currentKey) {
                        const stepCacheKey: string = `${libID}:${currentKey}`;

                        // If we've built this path before, reuse it
                        if (collectionPathCache[stepCacheKey]) {
                            foundParentPath = collectionPathCache[stepCacheKey];
                            break;
                        }

                        if (visitedSteps.has(stepCacheKey)) break;
                        visitedSteps.add(stepCacheKey);

                        const coll: IDBZoteroCollection | null | undefined =
                            collectionEntityCache[stepCacheKey];
                        if (coll) {
                            breadcrumbs.unshift(coll.name);
                            currentKey = coll.parentCollection || undefined;
                        } else {
                            break;
                        }
                    }

                    const resolvedPath = foundParentPath
                        ? breadcrumbs.length > 0
                            ? `${foundParentPath}/${breadcrumbs.join("/")}`
                            : foundParentPath
                        : breadcrumbs.join("/");

                    // Nothing resolved: the collection row is gone while the
                    // item still references it — an interrupted pull, or a
                    // remote deletion whose member items have not come back
                    // down yet. Treat the item as simply not being in that
                    // collection. Keeping the empty string here would append a
                    // blank segment, and `${libName}/${""}/` renders as a
                    // doubled separator that reaches note bodies verbatim
                    // (library-template feeds itemPaths to the note template,
                    // which unlike NotePathService does not collapse slashes).
                    if (!resolvedPath) continue;

                    collectionPathCache[cacheKey] = resolvedPath;
                    allCollPaths.push(resolvedPath);
                }
            }

            // Assemble the final path for this item
            const resultKey = `${libID}:${item.key}`;
            if (allCollPaths.length > 0) {
                paths[resultKey] = allCollPaths.map((p) => `${libName}/${p}/`);
            } else {
                paths[resultKey] = [`${libName}/`];
            }
        }

        return paths;
    }

    /**
     * Get attachments for a parent item.
     */
    async getAttachments(
        libraryID: number,
        parentKey: string,
    ): Promise<AnyIDBZoteroItem[]> {
        return await db.items
            .where(["libraryID", "parentItem", "itemType", "trashed"])
            .equals([libraryID, parentKey, "attachment", 0])
            .toArray();
    }

    /**
     * Get lightweight annotation candidates for the repair view.
     * Returns all annotations under a parent item (across all its attachments),
     * keyed by annotation key.
     *
     * If `libraryID` is omitted, the item is looked up by key alone across all
     * libraries (keys are unique in practice).
     */
    async getAnnotationCandidates(
        libraryID: number | null,
        parentKey: string,
    ): Promise<
        { key: string; pageLabel: string; text: string; type: string }[]
    > {
        // Resolve libraryID if not provided — try each filtered library
        let resolvedLibraryID = libraryID;
        if (resolvedLibraryID == null) {
            const libraryIDs = await this.getFilteredLibraryIDs();
            for (const lid of libraryIDs) {
                const match = await db.items.get([lid, parentKey]);
                if (match) {
                    resolvedLibraryID = lid;
                    break;
                }
            }
            if (resolvedLibraryID == null) return [];
        }

        // Get child attachments
        const attachments = await db.items
            .where(["libraryID", "parentItem", "itemType", "trashed"])
            .equals([resolvedLibraryID, parentKey, "attachment", 0])
            .toArray();

        // Also check if the item itself is a standalone attachment
        const item = await db.items.get([resolvedLibraryID, parentKey]);
        const attachmentKeys = attachments.map((a) => a.key);
        if (item?.itemType === "attachment") {
            attachmentKeys.push(parentKey);
        }

        // Get all annotations under these attachments
        const results: {
            key: string;
            pageLabel: string;
            text: string;
            type: string;
        }[] = [];

        for (const attKey of attachmentKeys) {
            const annotations = await db.items
                .where(["libraryID", "parentItem", "itemType", "trashed"])
                .equals([resolvedLibraryID, attKey, "annotation", 0])
                .toArray();

            for (const ann of annotations) {
                const data = ann.raw?.data as unknown as Record<
                    string,
                    unknown
                >;
                if (!data) continue;
                results.push({
                    key: ann.key,
                    pageLabel: (data.annotationPageLabel as string) ?? "",
                    text: (data.annotationText as string) ?? "",
                    type: (data.annotationType as string) ?? "",
                });
            }
        }

        return results;
    }
}
