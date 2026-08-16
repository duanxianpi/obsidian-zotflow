import { BaseTask } from "../base";
import SparkMD5 from "spark-md5";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { IParentProxy } from "bridge/types";
import type { AttachmentService } from "worker/services/attachment";
import type { DownloadedAttachment, TaskStatus } from "types/tasks";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";

/**
 * Input for download attachment task.
 */
export interface DownloadAttachmentInput {
    libraryID: number;
    itemKey: string;
}

/**
 * DownloadAttachmentTask — wraps AttachmentService.getFileBlob() as a tracked background task.
 *
 * Progress is reported as a 3-step flow: validating → downloading → complete.
 * The resulting Blob is stored only until TaskManager takes the completed
 * result, so task history never pins attachment bytes.
 */
export class DownloadAttachmentTask extends BaseTask {
    private downloadedAttachment: DownloadedAttachment | null = null;

    constructor(
        parentHost: IParentProxy,
        private attachmentService: AttachmentService,
        private attachmentItem: IDBZoteroItem<AttachmentData>,
    ) {
        super("download-attachment", parentHost);
        this.displayText = `Downloading Attachment`;
        this.taskInput = {
            libraryID: this.attachmentItem.libraryID,
            item: this.attachmentItem.key,
        };
    }

    protected async run(signal: AbortSignal): Promise<void> {
        const filename =
            this.attachmentItem.raw.data.filename || this.attachmentItem.key;

        this.reportProgress(0, 1, `Downloading ${filename}...`);

        if (signal.aborted) throw new Error("Aborted");

        try {
            const blob = await this.attachmentService.getFileBlob(
                this.attachmentItem,
            );

            if (signal.aborted) throw new Error("Aborted");

            if (!blob) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.RESOURCE_MISSING,
                    "DownloadAttachmentTask",
                    `Failed to download ${filename}`,
                );
            }

            const contentMD5 =
                this.attachmentItem.raw.data.contentType === "application/pdf" &&
                !this.attachmentItem.raw.data.md5
                    ? await this.hashBlob(blob, signal)
                    : undefined;

            if (signal.aborted) throw new Error("Aborted");

            this.downloadedAttachment = {
                blob,
                ...(contentMD5 ? { contentMD5 } : {}),
            };
            const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
            this.reportProgress(1, 1, `Downloaded ${filename}`);
            this.result = {
                successCount: 1,
                failCount: 0,
                details: { file: filename, size: `${sizeMB} MB` },
            };
        } catch (e) {
            if (signal.aborted) throw new Error("Aborted");
            this.result = {
                successCount: 0,
                failCount: 1,
                details: { file: filename, downloaded: 0 },
            };
            throw e;
        }
    }

    protected getTerminalDisplayText(status: TaskStatus): string {
        const filename =
            this.attachmentItem.raw.data.filename || this.attachmentItem.key;
        if (status === "cancelled") return `Download — Cancelled: ${filename}`;
        if (status === "failed") return `Download — Failed: ${filename}`;
        return `Downloaded: ${filename}`;
    }

    /** Hand the bytes to the caller without retaining them in task history. */
    public takeResult(): DownloadedAttachment | null {
        const result = this.downloadedAttachment;
        this.downloadedAttachment = null;
        return result;
    }

    /** Hash a PDF incrementally so no second full-size ArrayBuffer is created. */
    private async hashBlob(blob: Blob, signal: AbortSignal): Promise<string> {
        const streamReader = blob.stream().getReader();
        const hasher = new SparkMD5.ArrayBuffer();

        try {
            while (true) {
                if (signal.aborted) {
                    await streamReader.cancel();
                    throw new Error("Aborted");
                }

                const { done, value } = await streamReader.read();
                if (signal.aborted) {
                    await streamReader.cancel();
                    throw new Error("Aborted");
                }
                if (done) break;

                // Respect a view into a larger backing buffer. Blob streams use
                // small chunks, so the slice remains bounded even in this case.
                const chunk =
                    value.byteOffset === 0 &&
                    value.byteLength === value.buffer.byteLength
                        ? value.buffer
                        : value.buffer.slice(
                              value.byteOffset,
                              value.byteOffset + value.byteLength,
                          );
                hasher.append(chunk);
            }

            return hasher.end();
        } finally {
            streamReader.releaseLock();
        }
    }
}
