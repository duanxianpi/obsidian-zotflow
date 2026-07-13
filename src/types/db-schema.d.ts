import {
    ZoteroCollection,
    ZoteroGroup,
    ZoteroItem,
    ZoteroKey,
    ZoteroLibrary,
} from "./zotero";
import { ZoteroItemData, ZoteroItemDataTypeMap } from "./zotero-item";

/** Key-value cache entry for the CSL renderer (styles, locales, index). */
export interface IDBCslCacheEntry {
    key: string;
    value: string;
}

/** Stored Zotero API key with associated group membership. */
export interface IDBZoteroKey extends ZoteroKey {
    joinedGroups: number[]; // Array of Group IDs the key has access to
}

/** Stored Zotero group library metadata. */
export interface IDBZoteroGroup extends ZoteroGroup {}

/** Stored Zotero library with sync version tracking. */
export interface IDBZoteroLibrary extends ZoteroLibrary {
    collectionVersion?: number; // For collection sync, indicates the global version of the library
    itemVersion?: number; // For item sync, indicates the global version of the library

    syncedAt: string; // ISO String of last successful sync
}

/** Stored Zotero collection with sync state and raw API payload. */
export interface IDBZoteroCollection {
    libraryID: number;
    key: string;
    version: number;
    name: string;
    parentCollection: string;
    trashed: 0 | 1; // Whether the collection is trashed

    // Sync State
    syncStatus: "synced" | "created" | "updated" | "deleted" | "conflict";
    syncedAt: string;
    syncError: string;

    // Raw Payload
    raw: ZoteroCollection;
    serverCopyRaw?: ZoteroCollection;
}

/** Internal stored Zotero item with indexed fields and sync state. */
interface _IDBZoteroItem<T extends ZoteroItemData> {
    // Core Zotero Data
    libraryID: number; // Library ID (User or Group ID)
    key: string; // Zotero Item Key (8 chars)

    // Core Indexed Fields
    itemType: T["itemType"]; // 'journalArticle', 'attachment', 'annotation', etc.
    parentItem: string; // Parent Item Key
    trashed: 0 | 1; // Whether the item is trashed

    // Sorting & Versioning
    title: string; // Title (normalized for sorting)
    collections: string[]; // Collection Key Array
    dateAdded: string; // ISO String
    dateModified: string; // ISO String (Zotero Cloud's last modified time)
    version: number; // Zotero Cloud Version (for optimistic locking)

    // Derived Fields for Search
    searchCreators: string[];
    searchTags: string[];

    // Sync State
    syncStatus:
        | "synced"
        | "created"
        | "updated"
        | "deleted"
        | "ignore"
        | "conflict";
    syncError: string;
    syncedAt: string;

    // External Annotation Extraction Tracking
    externalAnnotationExtractionFileMD5?: string;

    // Annotation Image Version Tracking
    annotationImageVersion?: number;

    // Reader View State (persisted so the reader reopens at the same position)
    primaryViewState?: Record<string, unknown>;
    secondaryViewState?: Record<string, unknown>;

    // Citation Key
    citationKey?: string;

    // CSL-JSON payload from the Zotero API (include=data,csljson), consumed
    // by the citation/bibliography template filters. Non-indexed.
    csljson?: Record<string, unknown>;

    // lastAccessedAt
    lastAccessedAt?: string;

    // Raw Payload
    raw: ZoteroItem<T>;
    serverCopyRaw?: ZoteroItem<T>;
}

/** Stored Zotero item, parameterized by item data type. */
export type IDBZoteroItem<T extends ZoteroItemData> = _IDBZoteroItem<T>;

/** Union of all possible `IDBZoteroItem<T>` instantiations. */
export type AnyIDBZoteroItem = {
    [K in keyof ZoteroItemDataTypeMap]: IDBZoteroItem<ZoteroItemDataTypeMap[K]>;
}[keyof ZoteroItemDataTypeMap];

/** Cached attachment file bytes with metadata for LRU eviction. */
export interface IDBZoteroFile {
    libraryID: number; // Library ID (User or Group ID)
    key: string; // Zotero Item Key (itemType='attachment')
    buffer: ArrayBuffer; // File bytes (stored inline as ArrayBuffer, not Blob — see AttachmentService for the WebKit/iPadOS rationale)
    mimeType: string;
    fileName: string;
    md5: string; // File MD5 (API returned), used to determine if re-download is needed
    lastAccessedAt: string;
    size: number;
}
