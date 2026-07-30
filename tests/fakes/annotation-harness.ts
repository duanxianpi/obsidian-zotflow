/**
 * Harness for `AnnotationService` — the cloud half of the annotation round trip.
 *
 * Losing or corrupting annotations is the one failure a user cannot undo, so
 * this wires the real pieces wherever the real pieces are cheap:
 *
 * - **The DB is real.** `db/annotation.ts` and `AnnotationService` are two ends
 *   of one conversion, and the interesting bugs live in the compound-index
 *   queries between them, so both run against the actual Dexie schema.
 * - **`ConvertService` is real.** Zero-arg constructor, and `annoMd2html` is a
 *   pure function — faking it would only assert that a fake was called, when
 *   what matters is that Zotero's restricted HTML subset lands in the record.
 * - **`LibraryNoteService` is faked.** It is already 96% covered by its own
 *   suite, its `triggerUpdate` is debounced, and every call `AnnotationService`
 *   makes into it is fire-and-forget. What matters here is *that* it was asked,
 *   with which arguments, and that a rejection is logged rather than swallowed —
 *   so the fake records calls and can be told to reject.
 */
import { AnnotationService } from "worker/services/annotation";
import { ConvertService } from "worker/services/convert";

import { db, resetDb, seedItem, seedKey, seedLibrary } from "./db";
import { createFakeParentHost } from "./parent-host";

import type { FakeParentHost } from "./parent-host";
import type { LibraryNoteService, UpdateOptions } from "worker/services/library-note";
import type { IDBZoteroItem, IDBZoteroKey } from "types/db-schema";
import type { AnnotationData, AttachmentData } from "types/zotero-item";
import type { AnnotationJSON, AnnotationType } from "types/zotero-reader";

export const API_KEY = "TESTKEY";
export const USER_ID = 1;
export const GROUP_ID = 777;

/** ISO second-precision, the shape AnnotationService writes. */
export const ISO = "2026-01-01T00:00:00.000Z";

export interface TriggerUpdateCall {
    libraryID: number;
    key: string;
    options: UpdateOptions;
    debounce: boolean;
}

/** Recording stand-in for the three LibraryNoteService methods used here. */
export interface FakeNoteService {
    triggerUpdateCalls: TriggerUpdateCall[];
    savedImages: { image: string; annotationKey: string }[];
    deletedImages: string[];
    /** Make the corresponding call reject, to exercise the catch paths. */
    failTriggerUpdate: boolean;
    failSaveImage: boolean;
    failDeleteImage: boolean;
}

function createFakeNoteService(): FakeNoteService & LibraryNoteService {
    const fake = {
        triggerUpdateCalls: [] as TriggerUpdateCall[],
        savedImages: [] as { image: string; annotationKey: string }[],
        deletedImages: [] as string[],
        failTriggerUpdate: false,
        failSaveImage: false,
        failDeleteImage: false,

        triggerUpdate(
            libraryID: number,
            key: string,
            options: UpdateOptions = {},
            debounce = false,
        ) {
            fake.triggerUpdateCalls.push({ libraryID, key, options, debounce });
            return fake.failTriggerUpdate
                ? Promise.reject(new Error("note update exploded"))
                : Promise.resolve();
        },

        saveBase64Image(image: string, annotationKey: string) {
            fake.savedImages.push({ image, annotationKey });
            return fake.failSaveImage
                ? Promise.reject(new Error("image write exploded"))
                : Promise.resolve();
        },

        deleteAnnotationImage(annotationKey: string) {
            fake.deletedImages.push(annotationKey);
            return fake.failDeleteImage
                ? Promise.reject(new Error("image delete exploded"))
                : Promise.resolve();
        },
    };
    return fake as unknown as FakeNoteService & LibraryNoteService;
}

export interface AnnotationHarnessOptions {
    /** Seed a group library (777) alongside the personal one. */
    withGroup?: boolean;
}

export interface AnnotationHarness {
    service: AnnotationService;
    host: FakeParentHost;
    noteService: FakeNoteService;
    keyInfo: IDBZoteroKey;
    /** Seed an attachment and return it typed for the service's signatures. */
    seedAttachment: (
        key: string,
        overrides?: {
            libraryID?: number;
            parentItem?: string;
            libraryType?: "user" | "group";
        },
    ) => Promise<IDBZoteroItem<AttachmentData>>;
    /** Seed an annotation row under an attachment. */
    seedAnnotation: (
        key: string,
        parentItem: string,
        overrides?: SeedAnnotationOverrides,
    ) => Promise<void>;
    /** Read an annotation row straight out of the DB. */
    getRow: (
        key: string,
        libraryID?: number,
    ) => Promise<IDBZoteroItem<AnnotationData> | undefined>;
    /** Every annotation row under an attachment, by key. */
    rowsFor: (
        attachmentKey: string,
        libraryID?: number,
    ) => Promise<IDBZoteroItem<AnnotationData>[]>;
}

export interface SeedAnnotationOverrides {
    libraryID?: number;
    syncStatus?: IDBZoteroItem<AnnotationData>["syncStatus"];
    type?: AnnotationType;
    text?: string;
    comment?: string;
    color?: string;
    pageLabel?: string;
    sortIndex?: string;
    position?: object;
    tags?: { tag: string; type?: number }[];
    isExternal?: boolean;
    authorName?: string;
    createdByUser?: {
        id: number;
        name?: string;
        username?: string;
        links?: object;
    };
    dateAdded?: string;
    dateModified?: string;
}

export async function createAnnotationHarness(
    options: AnnotationHarnessOptions = {},
): Promise<AnnotationHarness> {
    await resetDb();

    await seedLibrary({ id: USER_ID, type: "user", name: "My Library" });
    if (options.withGroup) {
        await seedLibrary({ id: GROUP_ID, type: "group", name: "Group" });
    }

    const keyInfo = await seedKey({
        key: API_KEY,
        userID: USER_ID,
        username: "test-user",
        displayName: "Test User",
        joinedGroups: options.withGroup ? [GROUP_ID] : [],
    });

    const host = createFakeParentHost();
    const noteService = createFakeNoteService();
    const service = new AnnotationService(
        noteService,
        host,
        new ConvertService(),
    );

    const seedAttachment = async (
        key: string,
        overrides: {
            libraryID?: number;
            parentItem?: string;
            libraryType?: "user" | "group";
        } = {},
    ) => {
        const libraryID = overrides.libraryID ?? USER_ID;
        const libraryType = overrides.libraryType ?? "user";
        const item = await seedItem({
            libraryID,
            key,
            itemType: "attachment",
            parentItem: overrides.parentItem ?? "PAPER001",
            raw: {
                key,
                version: 1,
                library: { type: libraryType, id: libraryID, name: "Library" },
                links: {},
                meta: { numChildren: 0 },
                data: {
                    key,
                    version: 1,
                    itemType: "attachment",
                    contentType: "application/pdf",
                },
            } as any,
        });
        return item as unknown as IDBZoteroItem<AttachmentData>;
    };

    const seedAnnotation = async (
        key: string,
        parentItem: string,
        overrides: SeedAnnotationOverrides = {},
    ) => {
        const libraryID = overrides.libraryID ?? USER_ID;
        await seedItem({
            libraryID,
            key,
            itemType: "annotation",
            parentItem,
            syncStatus: overrides.syncStatus ?? "synced",
            dateAdded: overrides.dateAdded ?? ISO,
            dateModified: overrides.dateModified ?? ISO,
            raw: {
                key,
                version: 1,
                library: { type: "user", id: libraryID, name: "Library" },
                links: {},
                meta: overrides.createdByUser
                    ? { numChildren: 0, createdByUser: overrides.createdByUser }
                    : { numChildren: 0 },
                data: {
                    key,
                    version: 1,
                    itemType: "annotation",
                    parentItem,
                    annotationType: overrides.type ?? "highlight",
                    annotationText: overrides.text ?? `text of ${key}`,
                    annotationComment: overrides.comment ?? "",
                    annotationColor: overrides.color ?? "#ffd400",
                    annotationPageLabel: overrides.pageLabel ?? "1",
                    annotationSortIndex: overrides.sortIndex ?? "00001|000000|00000",
                    annotationPosition: JSON.stringify(
                        overrides.position ?? { pageIndex: 0, rects: [] },
                    ),
                    annotationAuthorName: overrides.authorName ?? "",
                    annotationIsExternal: overrides.isExternal ?? false,
                    tags: overrides.tags ?? [],
                    relations: {},
                    dateAdded: ISO,
                    dateModified: ISO,
                },
            } as any,
        });
    };

    const getRow = async (key: string, libraryID = USER_ID) =>
        (await db.items.get([libraryID, key])) as unknown as
            | IDBZoteroItem<AnnotationData>
            | undefined;

    const rowsFor = async (attachmentKey: string, libraryID = USER_ID) =>
        (await db.items
            .where({ libraryID, parentItem: attachmentKey, itemType: "annotation" })
            .toArray()) as unknown as IDBZoteroItem<AnnotationData>[];

    return {
        service,
        host,
        noteService,
        keyInfo,
        seedAttachment,
        seedAnnotation,
        getRow,
        rowsFor,
    };
}

/** The reader-side JSON shape, with only the fields a test cares about set. */
export function makeAnnotationJson(
    id: string,
    overrides: Partial<AnnotationJSON> = {},
): AnnotationJSON {
    return {
        id,
        type: "highlight",
        text: `text of ${id}`,
        comment: "",
        color: "#ffd400",
        pageLabel: "1",
        sortIndex: "00001|000000|00000",
        position: { pageIndex: 0, rects: [] },
        tags: [],
        dateAdded: ISO,
        dateModified: ISO,
        ...overrides,
    };
}

export { db };
