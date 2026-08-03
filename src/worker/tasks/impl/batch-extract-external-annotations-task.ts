import { BaseTask } from "../base";
import { db } from "db/db";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import SparkMD5 from "spark-md5";

import type { IParentProxy } from "bridge/types";
import type { AttachmentService } from "worker/services/attachment";
import type { PDFProcessWorker } from "worker/services/pdf-processor";
import type { TaskStatus } from "types/tasks";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData, AnnotationData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";

export interface AttachmentIdentifier {
    libraryID: number;
    itemKey: string;
    precomputedMD5?: string;
}

/**
 * Input descriptor for batch external annotation extraction.
 */
export interface BatchExtractExternalAnnotationsInput {
    /** Attachment items to extract from, identified by libraryID + itemKey. */
    items: AttachmentIdentifier[];
}

/**
 * BatchExtractExternalAnnotationsTask — extracts external (embedded PDF)
 * annotations via `PDFProcessWorker.import()`.
 *
 * For each attachment item:
 *   1. Skip non-PDF items
 *   2. Check MD5 to skip items already extracted
 *   3. Delete old external annotations from IDB
 *   4. Download the PDF blob
 *   5. Call `pdfProcessWorker.import()` to extract annotations
 *   6. Store extracted annotations in IDB (syncStatus = "ignore")
 *   7. Update the extraction MD5 on the attachment record
 *
 * The resulting `AnnotationJSON[]` are cached and can be retrieved via
 * `getExtractedAnnotations()` after the task completes.
 */
export class BatchExtractExternalAnnotationsTask extends BaseTask {
    private extractedAnnotations: AnnotationJSON[] = [];

    constructor(
        parentHost: IParentProxy,
        private attachmentService: AttachmentService,
        private pdfProcessor: PDFProcessWorker,
        private input: BatchExtractExternalAnnotationsInput,
    ) {
        super("batch-extract-external-annotations", parentHost);
        const count = input.items.length;
        this.displayText = `Extracting External Annotations (${count} file${count !== 1 ? "s" : ""})`;
        this.taskInput = { attachments: count };
    }

    protected async run(signal: AbortSignal): Promise<void> {
        // Resolve items from DB
        const resolvedItems: IDBZoteroItem<AttachmentData>[] = [];
        for (const { libraryID, itemKey } of this.input.items) {
            const item = await db.items.get([libraryID, itemKey]);
            if (item && item.itemType === "attachment") {
                resolvedItems.push(item);
            }
        }

        const items = resolvedItems.filter(
            (a) => a.raw.data.contentType === "application/pdf",
        );

        if (items.length === 0) {
            this.reportProgress(0, 0, "No PDF attachments to process");
            return;
        }

        const total = items.length;
        let successCount = 0;
        let failCount = 0;

        // Build a lookup for precomputed MD5 values
        const precomputedMD5Map = new Map<string, string>();
        for (const { libraryID, itemKey, precomputedMD5 } of this.input.items) {
            if (precomputedMD5) {
                precomputedMD5Map.set(
                    `${libraryID}:${itemKey}`,
                    precomputedMD5,
                );
            }
        }

        for (let i = 0; i < items.length; i++) {
            if (signal.aborted) throw new Error("Aborted");

            const item = items[i]!;
            const label = item.raw.data.filename || item.key;
            this.reportProgress(
                i,
                total,
                `Extracting ${i + 1}/${total}: ${label}`,
            );

            try {
                const preMD5 = precomputedMD5Map.get(
                    `${item.libraryID}:${item.key}`,
                );
                const annotations = await this.extractForAttachment(
                    item,
                    preMD5,
                );
                this.extractedAnnotations.push(...annotations);
                successCount++;
            } catch (e) {
                failCount++;
                this.log(
                    "error",
                    `Failed to extract external annotations for ${item.key}: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                    "BatchExtractExternalAnnotationsTask",
                );
            }
        }

        this.result = {
            successCount,
            failCount,
            details: {
                attachments: total,
                annotations: this.extractedAnnotations.length,
                failed: failCount,
            },
        };
        this.reportProgress(
            total,
            total,
            failCount > 0
                ? `Done: ${successCount} success, ${failCount} failed`
                : `Extracted ${this.extractedAnnotations.length} annotations`,
        );
    }

    protected getTerminalDisplayText(status: TaskStatus): string {
        if (status === "cancelled")
            return "Extract External Annotations — Cancelled";
        if (status === "failed") return "Extract External Annotations — Failed";
        const r = this.result;
        const count = (r?.details?.["annotations"] as number | undefined) ?? 0;
        if (r && r.failCount > 0) {
            return `Extracted ${count} annotations (${r.failCount} failed)`;
        }
        return `Extracted ${count} external annotations`;
    }

    /**
     * Extract external annotations from a single PDF attachment.
     * Returns AnnotationJSON[] for use by the reader bridge.
     */
    private async extractForAttachment(
        attachment: IDBZoteroItem<AttachmentData>,
        precomputedMD5?: string,
    ): Promise<AnnotationJSON[]> {
        const serverMD5 = attachment.raw.data.md5;
        const lastExtractionMD5 =
            attachment.externalAnnotationExtractionFileMD5;

        // Fast path: server MD5 available and matches last extraction
        if (serverMD5 && serverMD5 === lastExtractionMD5) {
            this.log(
                "debug",
                `Skipping ${attachment.key} — server MD5 match`,
                "BatchExtractExternalAnnotationsTask",
            );
            return [];
        }

        // Fast path for linked files: use precomputed MD5 from already-loaded
        // blob (avoids a redundant file read).
        if (
            !serverMD5 &&
            precomputedMD5 &&
            precomputedMD5 === lastExtractionMD5
        ) {
            this.log(
                "debug",
                `Skipping ${attachment.key} — precomputed MD5 match`,
                "BatchExtractExternalAnnotationsTask",
            );
            return [];
        }

        // Download the PDF
        const fileBlob = await this.attachmentService.getFileBlob(attachment);
        if (!fileBlob) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "BatchExtractExternalAnnotationsTask",
                `File blob not available for ${attachment.key}`,
            );
        }

        const buffer = await fileBlob.arrayBuffer();

        // Determine effective MD5: prefer precomputed, then server, then compute from content
        const effectiveMD5 =
            precomputedMD5 || serverMD5 || SparkMD5.ArrayBuffer.hash(buffer);

        // Slow path: check computed/precomputed MD5 against last extraction
        if (effectiveMD5 === lastExtractionMD5) {
            this.log(
                "debug",
                `Skipping ${attachment.key} — computed MD5 match`,
                "BatchExtractExternalAnnotationsTask",
            );
            return [];
        }

        // Delete existing external annotations before re-extraction
        const existingExternal = await db.items
            .where({
                libraryID: attachment.libraryID,
                parentItem: attachment.key,
            })
            .filter(
                (i) =>
                    (i as IDBZoteroItem<AnnotationData>).raw.data
                        .annotationIsExternal === true,
            )
            .primaryKeys();

        if (existingExternal.length > 0) {
            await db.items.bulkDelete(existingExternal);
        }

        // Extract via PDF worker
        const rawAnnotations = await this.pdfProcessor.import(buffer, true);

        // Build AnnotationJSON for the reader
        const annotationJsonResults: AnnotationJSON[] = rawAnnotations.map(
            (raw: any) => {
                const key =
                    raw.key || raw.id || crypto.randomUUID().slice(0, 8);

                return {
                    id: key,
                    type: raw.annotationType,
                    isExternal: true,
                    authorName: raw.annotationAuthorName,
                    readOnly: true,
                    text: raw.annotationText,
                    comment: raw.annotationComment,
                    pageLabel: raw.annotationPageLabel,
                    color: raw.annotationColor,
                    sortIndex: raw.annotationSortIndex,
                    position: JSON.parse(raw.annotationPosition),
                    tags: raw.tags || [],
                    dateModified: raw.dateModified,
                    dateAdded: raw.dateAdded,
                };
            },
        );

        // Update extraction MD5 on the attachment
        await db.items.update([attachment.libraryID, attachment.key], {
            externalAnnotationExtractionFileMD5: effectiveMD5,
        });

        this.log(
            "debug",
            `Extracted ${annotationJsonResults.length} external annotations for ${attachment.key}`,
            "BatchExtractExternalAnnotationsTask",
        );

        return annotationJsonResults;
    }

    /**
     * Retrieve extracted annotations after task completes.
     * Used by the main thread to push annotations to the reader bridge.
     */
    public getExtractedAnnotations(): AnnotationJSON[] {
        return this.extractedAnnotations;
    }
}
