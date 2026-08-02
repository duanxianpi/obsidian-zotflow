import { db } from "db/db";
import type { IDBZoteroItem } from "types/db-schema";
import type {
    AnnotationData,
    AttachmentData,
    ZoteroItemDataTypeMap,
} from "types/zotero-item";
import type {
    AnnotationJSON,
    AnnotationType,
    ZoteroPosition,
} from "types/zotero-reader";

/**
 * Convert reader-compatible annotation JSON into a Zotero annotation item.
 *
 * @param json The reader annotation data
 * @returns A partial Zotero annotation item
 */
export function annotationItemFromJSON(
    json: AnnotationJSON,
): Partial<ZoteroItemDataTypeMap["annotation"]> {
    return {
        itemType: "annotation",
        key: json.id,
        annotationType: json.type,
        annotationAuthorName: json.authorName || "",
        ...(json.type === "highlight" || json.type === "underline"
            ? { annotationText: json.text }
            : {}),
        annotationComment: json.comment,
        annotationColor: json.color,
        annotationPageLabel: json.pageLabel,
        annotationSortIndex: json.sortIndex,
        annotationIsExternal: json.isExternal,
        // The copy is what turns an absent position into `{}` rather than
        // letting `JSON.stringify` return `undefined`.
        annotationPosition: JSON.stringify(Object.assign({}, json.position)),
        tags: (json.tags || []).map((t) => ({ tag: t.name })),
    };
}

/**
 * Get all annotations for a given item from the local database.
 *
 * @param libraryID The ID of the Zotero library (user or group ID).
 * @param itemKey The key of the parent item (e.g., journal article) to fetch annotations for.
 * @returns A promise that resolves to an array of annotation items.
 */
export async function getAnnotationJson(
    item: IDBZoteroItem<AttachmentData>,
    apiKey: string,
    filter?: (annotation: IDBZoteroItem<AnnotationData>) => boolean,
): Promise<AnnotationJSON[]> {
    // Get current user from settings/DB

    if (item.itemType !== "attachment") {
        return [];
    }

    const currentUserKey = await db.keys.get(apiKey);
    const currentUser = currentUserKey
        ? {
              id: currentUserKey.userID,
              username: currentUserKey.username,
              displayName: currentUserKey.displayName,
          }
        : null;

    // Get Library Info
    const library = await db.libraries.get(item.libraryID);
    const isGroup = library?.type === "group";

    // Get User info (for creator/modifier)
    // lastModifiedByUser is not readily available in standard Zotero item API response
    // We will assume it's createdByUser if not present.

    // Zotero Annotations
    let annotations = (await db.items
        .where({
            libraryID: item.libraryID,
            parentItem: item.key,
            itemType: "annotation",
        })
        .toArray()) as IDBZoteroItem<AnnotationData>[];

    if (filter) {
        annotations = annotations.filter(filter);
    }

    // External Annotations
    const annotationJson: AnnotationJSON[] = [];
    for (const annotation of annotations) {
        const data = annotation.raw.data;
        const createdByUser = annotation.raw.meta.createdByUser;
        const type = data.annotationType as AnnotationType;
        const isExternal = data.annotationIsExternal || false; // Default to false

        const isAuthor =
            !createdByUser?.id || createdByUser?.id === currentUser?.id;

        // Colours are not wired up yet, so every tag sorts by name today. The
        // shape mirrors Zotero's `toJSONSync` — including its unreachable
        // second branch — so tag colours can be dropped in without redesigning
        // the comparator.
        const processedTags: AnnotationJSON["tags"] = (data.tags || []).map(
            (t) => ({ name: t.tag }),
        );

        processedTags.sort((a, b) => {
            if (!a.color && !b.color) {
                return a.name.localeCompare(b.name, undefined, {
                    sensitivity: "accent",
                });
            }
            if (!a.color && !b.color) {
                return -1;
            }
            if (!a.color && b.color) {
                return 1;
            }
            return (a.position ?? 0) - (b.position ?? 0);
        });

        processedTags.forEach((t) => delete t.position);

        const o: AnnotationJSON = {
            libraryID: annotation.libraryID,
            parentItem: item.key,
            id: annotation.key,
            type,
            isExternal,
            readOnly: isExternal || !isAuthor,
            ...(type === "highlight" || type === "underline"
                ? { text: data.annotationText }
                : {}),
            comment: data.annotationComment,
            pageLabel: data.annotationPageLabel,
            color: data.annotationColor,
            sortIndex: data.annotationSortIndex,
            position: JSON.parse(data.annotationPosition) as ZoteroPosition,
            tags: processedTags,
            dateAdded: annotation.dateAdded,
            dateCreated: annotation.dateAdded,
            dateModified: annotation.dateModified,
        };

        if (data.annotationAuthorName) {
            o.authorName = data.annotationAuthorName;
        } else if (!isExternal && isGroup && createdByUser) {
            o.authorName = createdByUser.username || createdByUser.name;
            o.isAuthorNameAuthoritative = true;
        }

        annotationJson.push(o);
    }

    // Sort by document position (sortIndex is zero-padded: pageIndex|yOffset|xOffset)
    annotationJson.sort((a, b) =>
        (a.sortIndex ?? "").localeCompare(b.sortIndex ?? ""),
    );

    return annotationJson;
}
