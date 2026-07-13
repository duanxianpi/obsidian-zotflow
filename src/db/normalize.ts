import type { ZoteroItemData } from "types/zotero-item";
import type { IDBZoteroCollection, AnyIDBZoteroItem } from "types/db-schema";
import type { ZoteroCollection, AnyZoteroItem } from "types/zotero";

/**
 * Normalize a raw Zotero collection from the API into our IDB schema.
 *
 * @param raw The raw collection object from Zotero API (containing .data, .key, etc.)
 * @param libraryID The library ID this collection belongs to
 * @returns A normalized IDB collection record
 */
export function normalizeCollection(
    raw: ZoteroCollection,
    libraryID: number,
): IDBZoteroCollection {
    const collection: IDBZoteroCollection = {
        key: raw.key,
        libraryID: libraryID,
        version: raw.version,
        name: raw.data.name,
        parentCollection: raw.data.parentCollection || "",
        trashed: raw.data.deleted ? 1 : 0,
        syncStatus: "synced",
        syncError: "",
        syncedAt: new Date().toISOString(),
        raw: raw,
    };
    return collection;
}

function extractCitationKey(extra?: string) {
    const citationKey = extra?.match(/Citation Key: (\w+)/)?.[1];
    return citationKey;
}

/**
 * Normalize a raw Zotero item from the API into our IDB schema.
 *
 * @param raw The raw item object from Zotero API (containing .data, .key, etc.)
 * @param libraryID The library ID this item belongs to
 * @returns A normalized IDB item record
 */
export function normalizeItem(
    raw: AnyZoteroItem,
    libraryID: number,
): AnyIDBZoteroItem {
    // Safety check for title
    let title = "";
    let citationKey;

    // We can access common properties
    const commonData = raw.data as ZoteroItemData;

    // Normalize title
    if (raw.data.itemType === "attachment") {
        title = raw.data.filename || raw.data.title || "";
    } else if (raw.data.itemType === "note") {
        const plainText = raw.data.note
            ? raw.data.note.replace(/<[^>]+>/g, " ")
            : "";
        title =
            (plainText.split("\n")[0] ?? plainText).slice(0, 50).trim() ||
            `Note ${raw.data.key}`;
    } else if (raw.data.itemType !== "annotation") {
        // Exclude annotation which doesn't have title
        // For other types that might have title
        const maybeTitle = (raw.data as any).title;
        if (maybeTitle) title = maybeTitle;
    }

    // Flatten creators for search
    const searchCreators: string[] = [];
    let creators: any[] = [];

    if (
        raw.data.itemType === "attachment" ||
        raw.data.itemType === "note" ||
        raw.data.itemType === "annotation"
    ) {
        creators = [];
    } else {
        creators = raw.data.creators || [];
    }

    creators.forEach((c: any) => {
        if (c.name) {
            searchCreators.push(c.name);
        } else if (c.firstName || c.lastName) {
            searchCreators.push(
                `${c.firstName || ""} ${c.lastName || ""}`.trim(),
            );
        }
    });

    // Flatten tags for search
    const searchTags: string[] = [];
    if (commonData.tags && Array.isArray(commonData.tags)) {
        commonData.tags.forEach((t: any) => {
            if (t.tag) searchTags.push(t.tag);
        });
    }

    const item: AnyIDBZoteroItem = {
        key: raw.data.key,
        libraryID: libraryID,
        itemType: raw.data.itemType,
        citationKey:
            (raw.data as any).citationKey ||
            extractCitationKey((raw.data as any).extra),
        parentItem: raw.data.parentItem || "",
        collections: raw.data.collections ?? [],
        title: title,
        trashed: raw.data.deleted ? 1 : 0,
        dateAdded: raw.data.dateAdded,
        dateModified: raw.data.dateModified,
        version: raw.data.version,
        searchCreators: searchCreators,
        searchTags: searchTags,
        syncError: "",
        syncStatus: "synced",
        syncedAt: new Date().toISOString(),
        raw: raw,
    } as AnyIDBZoteroItem;

    // Only regular items are citable — child types carry no useful CSL data.
    if (
        raw.csljson &&
        raw.data.itemType !== "attachment" &&
        raw.data.itemType !== "note" &&
        raw.data.itemType !== "annotation"
    ) {
        item.csljson = raw.csljson;
    }

    return item;
}

/** Converts a `Date` or ISO string to Zotero's truncated ISO format (`YYYY-MM-DDTHH:MM:SSZ`). */
export function toZoteroDate(dateInput?: string | Date): string {
    const date = dateInput ? new Date(dateInput) : new Date();
    return date.toISOString().split(".")[0] + "Z";
}
