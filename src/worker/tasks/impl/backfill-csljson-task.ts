import Dexie from "dexie";
import { BaseTask } from "../base";
import { db } from "db/db";
import type { IParentProxy } from "bridge/types";
import type { ZoteroAPIService } from "worker/services/zotero";
import type { TaskStatus } from "types/tasks";

// Mirrors sync's PULL_BULK_SIZE — same endpoint, same batching contract.
const BULK_SIZE = 100;

// Child types carry no useful CSL data and are skipped by normalizeItem too.
const NON_CITABLE = new Set(["attachment", "note", "annotation"]);

/**
 * Refetches the CSL-JSON payload for every citable item in every library
 * (include=csljson) and stores it on the IDB items. Manual companion to the
 * per-sync storage: covers items synced before csljson was pulled, and
 * refreshes stale conversions after Zotero-side mapping changes.
 */
export class BackfillCslJsonTask extends BaseTask {
    private updated = 0;
    private failedItems = 0;

    constructor(
        parentHost: IParentProxy,
        private zotero: ZoteroAPIService,
    ) {
        super("backfill-csljson", parentHost);
        this.displayText = "Updating CSL data";
    }

    protected async run(signal: AbortSignal): Promise<void> {
        this.reportProgress(0, 1, "Collecting items...");

        const libraries = await db.libraries.toArray();
        const work: {
            libraryID: number;
            type: "user" | "group";
            name: string;
            keys: string[];
        }[] = [];
        for (const lib of libraries) {
            const keys: string[] = [];
            // Stream over the primary index instead of toArray(): items carry
            // full raw payloads, so materializing a library at once is heavy.
            await db.items
                .where("[libraryID+key]")
                .between([lib.id, Dexie.minKey], [lib.id, Dexie.maxKey])
                .each((item) => {
                    if (!NON_CITABLE.has(item.itemType)) keys.push(item.key);
                });
            if (keys.length > 0) {
                work.push({
                    libraryID: lib.id,
                    type: lib.type === "group" ? "group" : "user",
                    name: lib.name,
                    keys,
                });
            }
        }

        const total = work.reduce((n, w) => n + w.keys.length, 0);
        this.taskInput = { items: total, libraries: work.length };
        if (total === 0) {
            this.reportProgress(0, 0, "No citable items found");
            return;
        }

        let processed = 0;
        for (const lib of work) {
            const libHandle = this.zotero.client.library(
                lib.type,
                lib.libraryID,
            );
            for (const slice of this.chunkArray(lib.keys, BULK_SIZE)) {
                if (signal.aborted) throw new Error("Aborted");
                try {
                    const res = await libHandle.items().get({
                        itemKey: slice.join(","),
                        include: "csljson",
                        includeTrashed: true,
                    });
                    const rows = res.raw as {
                        key?: string;
                        csljson?: Record<string, unknown>;
                    }[];
                    for (const row of rows) {
                        if (!row.key || !row.csljson) continue;
                        await db.items.update([lib.libraryID, row.key], {
                            csljson: row.csljson,
                        });
                        this.updated++;
                    }
                } catch (e) {
                    // Keep going: one failed chunk must not lose the rest.
                    this.failedItems += slice.length;
                    this.log(
                        "warn",
                        `CSL data chunk failed for library ${lib.libraryID} (${slice.length} items)`,
                        "BackfillCslJsonTask",
                        e,
                    );
                }
                processed += slice.length;
                this.reportProgress(
                    processed,
                    total,
                    `Updating CSL data — ${lib.name}`,
                );
            }
        }

        this.result = {
            successCount: this.updated,
            failCount: this.failedItems,
            details: {
                items: total,
                updated: this.updated,
                failed: this.failedItems,
            },
        };

        // Nothing succeeded at all: surface it as a failure (offline etc.).
        if (this.updated === 0 && this.failedItems > 0) {
            throw new Error(
                "No CSL data could be fetched — check your connection",
            );
        }
    }

    protected getTerminalDisplayText(status: TaskStatus): string {
        if (status === "cancelled") return "CSL data update — Cancelled";
        if (status === "failed") return "CSL data update — Failed";
        if (this.failedItems > 0) {
            return `CSL data updated for ${this.updated} items (${this.failedItems} failed)`;
        }
        return `CSL data updated for ${this.updated} items`;
    }

    private chunkArray<T>(arr: T[], size: number): T[][] {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) {
            out.push(arr.slice(i, i + size));
        }
        return out;
    }
}
