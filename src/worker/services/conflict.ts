import { db } from "db/db";
import { normalizeItem } from "db/normalize";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { IParentProxy } from "bridge/types";
import type { AnyIDBZoteroItem } from "types/db-schema";

/* ================================================================ */
/*  Public types                                                   */
/* ================================================================ */

/** Discriminator for conflict resolution strategy. */
export type ConflictAction = "keep-local" | "accept-remote";

/** A single field-level diff entry */
export interface FieldDiff {
    field: string;
    localValue: string;
    remoteValue: string;
}

/** Discriminates the kind of item-level sync conflict. */
export type ItemConflictType =
    | "update" // both sides changed
    | "delete" // remote deleted, local dirty
    | "push"; // push failed (412 or API error)

/** Full detail of a single item-level sync conflict. */
export interface ConflictItemInfo {
    libraryID: number;
    key: string;
    itemType: string;
    title: string;
    conflictType: ItemConflictType;
    syncError: string;
    fields: FieldDiff[];
}

/* ================================================================ */
/*  Service                                                        */
/* ================================================================ */

/** Worker-side service for querying and resolving sync conflicts. */
export class ConflictService {
    constructor(private parentHost: IParentProxy) {}

    /* ================================================================ */
    /*  Queries                                                        */
    /* ================================================================ */

    /** Return all item-level conflicts across all libraries. */
    async getItemConflicts(): Promise<ConflictItemInfo[]> {
        try {
            const allLibs = await db.libraries.toArray();
            const results: ConflictItemInfo[] = [];

            for (const lib of allLibs) {
                const items = await db.items
                    .where("[libraryID+syncStatus]")
                    .equals([lib.id, "conflict"])
                    .toArray();

                for (const item of items) {
                    results.push(this.buildItemConflictInfo(item));
                }
            }

            return results;
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.DB_OPEN_FAILED,
                "ConflictService",
                "Failed to query item conflicts",
            );
        }
    }

    /* ================================================================ */
    /*  Resolution — Items                                             */
    /* ================================================================ */

    async resolveItemConflict(
        libraryID: number,
        key: string,
        action: ConflictAction,
    ): Promise<void> {
        try {
            const item = await db.items.get([libraryID, key]);
            if (!item) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.RESOURCE_MISSING,
                    "ConflictService",
                    `Item not found: ${libraryID}/${key}`,
                );
            }

            if (item.syncStatus !== "conflict") {
                this.parentHost.log(
                    "warn",
                    `Item ${key} is not in conflict (status=${item.syncStatus}), skipping.`,
                    "ConflictService",
                );
                return;
            }

            if (action === "keep-local") {
                await this.keepLocalItem(item);
            } else {
                await this.acceptRemoteItem(item);
            }

            this.parentHost.log(
                "info",
                `Resolved item conflict ${key} → ${action}`,
                "ConflictService",
            );
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.DB_WRITE_FAILED,
                "ConflictService",
                `Failed to resolve item conflict ${key}`,
            );
        }
    }

    /* ================================================================ */
    /*  Batch resolution                                               */
    /* ================================================================ */

    async resolveAllItemConflicts(action: ConflictAction): Promise<number> {
        const conflicts = await this.getItemConflicts();
        let resolved = 0;

        for (const c of conflicts) {
            await this.resolveItemConflict(c.libraryID, c.key, action);
            resolved++;
        }

        this.parentHost.log(
            "info",
            `Batch-resolved ${resolved} item conflicts → ${action}`,
            "ConflictService",
        );
        return resolved;
    }

    /* ================================================================ */
    /*  Private — keep-local logic                                     */
    /* ================================================================ */

    /**
     * Keep local changes. Mark item as "updated" so the next push uploads it.
     * Update the version in raw/raw.data to match the server's version
     * (already stored in item.version by pullItems), so the next push
     * uses the correct If-Unmodified-Since-Version and avoids a 412.
     * Clear serverCopyRaw and syncError.
     */
    private async keepLocalItem(item: AnyIDBZoteroItem): Promise<void> {
        // item.version was set to the server's latest by pullItems.
        // Propagate it into the raw payload so push uses the right version.
        const updatedRaw = { ...item.raw, version: item.version };
        if (updatedRaw.data) {
            updatedRaw.data = { ...updatedRaw.data, version: item.version };
        }

        await db.items.update([item.libraryID, item.key], {
            syncStatus: "updated",
            syncError: "",
            serverCopyRaw: undefined,
            raw: updatedRaw,
        });
    }

    /* ================================================================ */
    /*  Private — accept-remote logic                                  */
    /* ================================================================ */

    /**
     * Accept the remote version. If `serverCopyRaw` exists, overwrite `raw`
     * and re-normalize derived fields. If remote deleted the item
     * (serverCopyRaw is undefined), delete from IDB.
     */
    private async acceptRemoteItem(item: AnyIDBZoteroItem): Promise<void> {
        if (!item.serverCopyRaw) {
            // Remote deleted this item — remove locally
            await db.items.delete([item.libraryID, item.key]);
            return;
        }

        // Re-normalize from server copy to refresh derived fields
        const normalized = normalizeItem(item.serverCopyRaw, item.libraryID);
        normalized.syncStatus = "synced";
        (normalized as AnyIDBZoteroItem).syncError = "";
        (normalized as AnyIDBZoteroItem).serverCopyRaw = undefined;

        await db.items.put(normalized);
    }

    /* ================================================================ */
    /*  Private — diff helpers                                         */
    /* ================================================================ */

    /**
     * Build a ConflictItemInfo from an IDB item, including field-level diffs.
     */
    private buildItemConflictInfo(item: AnyIDBZoteroItem): ConflictItemInfo {
        const conflictType = this.inferItemConflictType(item);
        const fields = this.diffItemFields(item);

        return {
            libraryID: item.libraryID,
            key: item.key,
            itemType: item.itemType,
            title: item.title || `${item.itemType} (${item.key})`,
            conflictType,
            syncError: item.syncError || "",
            fields,
        };
    }

    /**
     * Infer the conflict type from item state.
     */
    private inferItemConflictType(item: AnyIDBZoteroItem): ItemConflictType {
        if (!item.serverCopyRaw) {
            // No server copy → remote deleted or push-delete 412
            return "delete";
        }

        // If syncError mentions 412 or API error codes, it's a push conflict
        if (
            item.syncError &&
            (item.syncError.includes("412") || item.syncError.match(/^\d+:/))
        ) {
            return "push";
        }

        return "update";
    }

    /**
     * Produce a field-by-field diff between local and remote data.
     * Only includes fields that actually differ.
     */
    private diffItemFields(item: AnyIDBZoteroItem): FieldDiff[] {
        const localData = item.raw?.data;
        const remoteData = item.serverCopyRaw?.data;

        if (!localData && !remoteData) return [];

        if (!localData) {
            return [
                {
                    field: "(entire item)",
                    localValue: "(no local data)",
                    remoteValue: JSON.stringify(remoteData, null, 2),
                },
            ];
        }

        if (!remoteData) {
            return [
                {
                    field: "(entire item)",
                    localValue: JSON.stringify(localData, null, 2),
                    remoteValue: "(deleted on server)",
                },
            ];
        }

        return this.diffObjects(
            localData as unknown as Record<string, unknown>,
            remoteData as unknown as Record<string, unknown>,
        );
    }

    /**
     * Shallow compare two objects and return FieldDiff[] for differing keys.
     * Skips internal fields (key, version) that always differ.
     */
    private diffObjects(
        local: Record<string, unknown>,
        remote: Record<string, unknown>,
    ): FieldDiff[] {
        const skipFields = new Set(["key", "version"]);
        const allKeys = new Set([
            ...Object.keys(local),
            ...Object.keys(remote),
        ]);
        const diffs: FieldDiff[] = [];

        for (const key of allKeys) {
            if (skipFields.has(key)) continue;

            const lv = local[key];
            const rv = remote[key];
            const ls = this.stringify(lv);
            const rs = this.stringify(rv);

            if (ls !== rs) {
                diffs.push({ field: key, localValue: ls, remoteValue: rs });
            }
        }

        return diffs;
    }

    /** Stringify a value for display (handles arrays/objects). */
    private stringify(value: unknown): string {
        if (value === undefined) return "(undefined)";
        if (value === null) return "(null)";
        if (typeof value === "string") return value;
        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
        return JSON.stringify(value, null, 2);
    }
}
