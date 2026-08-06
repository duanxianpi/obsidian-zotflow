/*
 * Ported from Zotero's `chrome/content/zotero/xpcom/pdfWorker/manager.js`
 * (AGPL-3.0). The transport protocol and queue semantics follow the worker
 * bundled from zotero/document-worker commit fd642b3.
 */
import * as Comlink from "comlink";
import { db } from "db/db";
import type { ZotFlowSettings } from "settings/types";
import type { IParentProxy } from "bridge/types";
import type { IDBZoteroItem } from "types/db-schema";
import type { AnnotationData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

interface PDFWorkerConfig {
    pdfWorkerURL: string;
}

interface WorkerMessage {
    id?: number;
    responseID?: number;
    action?: string;
    data?: unknown;
    error?: unknown;
}

type PromiseResolvers = {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
};

type QueueItem = () => Promise<void>;

interface SaveRenderedAnnotationRequest {
    libraryID: number;
    annotationKey: string;
    buf: ArrayBuffer;
}

interface BufferResponse {
    buf: ArrayBuffer;
}

interface ExportAnnotation {
    id: string;
    type: string;
    authorName: string;
    comment: string;
    color: string;
    position: unknown;
    dateModified: string;
    tags: string[];
}

type ImportedAnnotation = Omit<
    AnnotationJSON,
    "id" | "isExternal" | "tags" | "dateModified" | "dateAdded"
> &
    Partial<
        Pick<
            AnnotationJSON,
            "id" | "isExternal" | "tags" | "dateModified" | "dateAdded"
        >
    >;

interface ImportResponse {
    imported: ImportedAnnotation[];
    deleted: string[];
    buf?: ArrayBuffer;
}

export interface PDFRecognizerData {
    metadata: Record<string, string>;
    totalPages: number;
    pages: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (isRecord(error) && typeof error.message === "string") {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return JSON.stringify(error) || "Unknown worker error";
}

function getWorkerErrorName(error: unknown): string {
    return isRecord(error) && typeof error.name === "string"
        ? error.name
        : "WorkerError";
}

function isSaveRenderedAnnotationRequest(
    data: unknown,
): data is SaveRenderedAnnotationRequest {
    return (
        isRecord(data) &&
        typeof data.libraryID === "number" &&
        typeof data.annotationKey === "string" &&
        data.buf instanceof ArrayBuffer
    );
}

function getOriginalFetch(): typeof fetch {
    const workerGlobal = self as typeof self & {
        originalFetch?: unknown;
    };
    if (typeof workerGlobal.originalFetch !== "function") {
        throw new Error("Native worker fetch is unavailable");
    }
    return workerGlobal.originalFetch as typeof fetch;
}

function parseJson(text: string): unknown {
    return JSON.parse(text) as unknown;
}

/** Manages a nested PDF.js Web Worker for PDF operations (export, import, annotation rendering). */
export class PDFProcessWorker {
    config: PDFWorkerConfig;
    private _worker: Worker | null;
    private _lastPromiseID: number;
    private _waitingPromises: { [key: number]: PromiseResolvers };
    private _queue: QueueItem[];
    private _processingQueue: boolean;
    private _blobUrls: Record<string, string>;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        blobUrls: Record<string, string>,
    ) {
        this._worker = null;
        this._lastPromiseID = 0;
        this._waitingPromises = {};
        this._queue = [];
        this._processingQueue = false;
        this._blobUrls = blobUrls;

        try {
            const workerUrl = this._blobUrls["pdf/zotero-pdf-worker.js"];
            if (!workerUrl) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.RESOURCE_MISSING,
                    "PDFProcessWorker",
                    "Worker URL not found in blobUrls",
                );
            }

            this.config = {
                pdfWorkerURL: workerUrl,
            };
            this.parentHost.log(
                "debug",
                "PdfWorkerService initialized",
                "PDFProcessWorker",
            );
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.RESOURCE_MISSING,
                "PDFProcessWorker",
                "Failed to initialize PdfWorkerService",
            );
        }
    }

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    async _processQueue() {
        this._init();
        if (this._processingQueue) {
            return;
        }
        this._processingQueue = true;
        let queuedOperation: QueueItem | undefined;
        while ((queuedOperation = this._queue.shift())) {
            await queuedOperation();
        }
        this._processingQueue = false;
    }

    async _enqueue<T>(fn: () => Promise<T>, isPriority?: boolean): Promise<T> {
        return new Promise((resolve, reject) => {
            const queuedOperation = async () => {
                try {
                    resolve(await fn());
                } catch (error) {
                    reject(
                        error instanceof Error
                            ? error
                            : new Error(getErrorMessage(error)),
                    );
                }
            };
            if (isPriority) {
                this._queue.unshift(queuedOperation);
            } else {
                this._queue.push(queuedOperation);
            }
            void this._processQueue();
        });
    }

    async _query<T>(
        action: string,
        data: unknown,
        transfer?: Transferable[],
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            if (!this._worker) {
                reject(
                    new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "PDFProcessWorker",
                        "PDF Worker not initialized",
                    ),
                );
                return;
            }
            this._lastPromiseID++;
            this._waitingPromises[this._lastPromiseID] = {
                resolve: (value) => resolve(value as T),
                reject,
            };
            this._worker.postMessage(
                { id: this._lastPromiseID, action, data },
                transfer || [],
            );
        });
    }

    _init() {
        if (this._worker) return;
        if (!this.config.pdfWorkerURL) {
            this.parentHost.log(
                "error",
                "PDF Worker URL not configured",
                "PDFProcessWorker",
            );
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "PDFProcessWorker",
                "PDF Worker URL not configured",
            );
        }
        const worker = new Worker(this.config.pdfWorkerURL);
        this._worker = worker;
        worker.addEventListener(
            "message",
            (event: MessageEvent<WorkerMessage>) => {
                // The listener contract is void; the handler reports its own
                // failures, so the promise is marked rather than returned.
                void (async () => {
                    const message = event.data;
    
                    // Handle Response (Worker -> Main Request)
                    if (message.responseID !== undefined) {
                        const resolver =
                            this._waitingPromises[message.responseID];
                        if (resolver) {
                            const { resolve, reject } = resolver;
                            delete this._waitingPromises[message.responseID];
                            if (
                                message.error !== undefined &&
                                message.error !== null
                            ) {
                                const errorMessage = getErrorMessage(
                                    message.error,
                                );
                                const errorName = getWorkerErrorName(
                                    message.error,
                                );
                                reject(
                                    new ZotFlowError(
                                        ZotFlowErrorCode.PARSE_ERROR,
                                        "PDFProcessWorker",
                                        `PDF Worker Error (${errorName}): ${errorMessage}`,
                                    ),
                                );
                            } else {
                                resolve(message.data);
                            }
                        }
                        return;
                    }
    
                    // Handle Request (Worker -> Main Request)
                    if (message.id !== undefined) {
                        let responseData: unknown = null;
                        let responseError: { message: string } | null = null;
    
                        try {
                            if (message.action === "FetchBuiltInCMap") {
                                if (typeof message.data !== "string") {
                                    throw new Error(
                                        "Invalid CMap request payload",
                                    );
                                }
                                const cMapUrl =
                                    this._blobUrls[
                                        `pdf/web/cmaps/${message.data}.bcmap`
                                    ];
                                if (cMapUrl) {
                                    const response =
                                        await getOriginalFetch()(cMapUrl);
                                    const arrayBuffer =
                                        await response.arrayBuffer();
                                    responseData = {
                                        isCompressed: true,
                                        cMapData: new Uint8Array(arrayBuffer),
                                    };
                                } else {
                                    this.parentHost.log(
                                        "warn",
                                        `CMap not found: ${message.data}`,
                                        "PDFProcessWorker",
                                    );
                                    throw new Error(
                                        `CMap not found: ${message.data}`,
                                    );
                                }
                            }
                        } catch (e) {
                            this.parentHost.log(
                                "error",
                                "Failed to fetch CMap data:",
                                "PDFProcessWorker",
                                e,
                            );
                            responseError = { message: getErrorMessage(e) };
                        }
    
                        try {
                            if (message.action === "FetchStandardFontData") {
                                if (typeof message.data !== "string") {
                                    throw new Error(
                                        "Invalid standard font request payload",
                                    );
                                }
                                const fontUrl =
                                    this._blobUrls[
                                        `pdf/web/standard_fonts/${message.data}`
                                    ];
                                if (fontUrl) {
                                    const response =
                                        await getOriginalFetch()(fontUrl);
                                    const arrayBuffer =
                                        await response.arrayBuffer();
                                    responseData = new Uint8Array(arrayBuffer);
                                } else {
                                    this.parentHost.log(
                                        "warn",
                                        `Standard font not found: ${message.data}`,
                                        "PDFProcessWorker",
                                    );
                                    throw new Error(
                                        `Standard font not found: ${message.data}`,
                                    );
                                }
                            }
                        } catch (e) {
                            this.parentHost.log(
                                "error",
                                "Failed to fetch standard font data:",
                                "PDFProcessWorker",
                                e,
                            );
                            responseError = { message: getErrorMessage(e) };
                        }
    
                        try {
                            if (message.action === "SaveRenderedAnnotation") {
                                if (
                                    !isSaveRenderedAnnotationRequest(
                                        message.data,
                                    )
                                ) {
                                    throw new Error(
                                        "Invalid rendered annotation payload",
                                    );
                                }
                                const { libraryID, annotationKey, buf } =
                                    message.data;
    
                                await db.items
                                    .where({ libraryID, key: annotationKey })
                                    .modify((item) => {
                                        item.annotationImageVersion = item.version;
                                    });
                                const folder =
                                    this.settings.annotationImageFolder.replace(
                                        /\/$/,
                                        "",
                                    );
                                const path = `${folder}/${annotationKey}.png`;
    
                                await this.parentHost.writeBinaryFile(
                                    path,
                                    Comlink.transfer(buf, [buf]),
                                );
    
                                responseData = true;
                            }
                        } catch (e) {
                            this.parentHost.log(
                                "error",
                                "Failed to render annotations:",
                                "PDFProcessWorker",
                                e,
                            );
                            responseError = { message: getErrorMessage(e) };
                        }

                        worker.postMessage({
                            responseID: message.id,
                            data: responseData,
                            error: responseError,
                        });
                    }
                })();
            },
        );
        worker.addEventListener("error", (event) => {
            this.parentHost.log(
                "error",
                `PDF Web Worker error (${event.filename}:${event.lineno}): ${event.message}`,
                "PDFProcessWorker",
                event,
            );
        });
    }

    /**
     * Export PDF file with annotations.
     *
     * @param buf The PDF file buffer
     * @param items Annotation items to embed
     * @param isPriority Whether to prioritize this export
     * @returns The exported PDF buffer
     */
    async export(
        buf: ArrayBuffer,
        items: IDBZoteroItem<AnnotationData>[],
        isPriority?: boolean,
    ): Promise<ArrayBuffer> {
        return this._enqueue(async () => {
            // ... (Logic extracted from original file, largely database independent logic)
            // Need to verify if `items` are raw objects or Dexie objects depending on worker
            // But they are passed as arguments.

            const internalItems = items.filter(
                (item) => !item.raw.data.annotationIsExternal,
            );
            const annotations: ExportAnnotation[] = [];
            for (const item of internalItems) {
                annotations.push({
                    id: item.key,
                    type: item.raw.data.annotationType,
                    authorName: item.raw.data.annotationAuthorName || "",
                    comment: (item.raw.data.annotationComment || "").replace(
                        /<\/?(i|b|sub|sup)>/g,
                        "",
                    ),
                    color: item.raw.data.annotationColor,
                    position:
                        typeof item.raw.data.annotationPosition === "string"
                            ? parseJson(item.raw.data.annotationPosition)
                            : item.raw.data.annotationPosition,
                    dateModified: item.raw.data.dateModified,
                    tags: item.raw.data.tags.map((x) => x.tag),
                });
            }

            let response: BufferResponse;
            try {
                response = await this._query<BufferResponse>(
                    "export",
                    { buf, annotations },
                    [buf],
                );
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "PDFProcessWorker",
                    "PDF Export failed",
                );
            }
            return response.buf;
        }, isPriority);
    }

    /**
     * Import annotations from PDF file
     */
    async import(
        buf: ArrayBuffer,
        isPriority?: boolean,
    ): Promise<AnnotationJSON[]> {
        return this._enqueue(async () => {
            let imported: ImportedAnnotation[];
            try {
                ({ imported } = await this._query<ImportResponse>(
                    "import",
                    { buf, existingAnnotations: [] },
                    [buf],
                ));
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "PDFProcessWorker",
                    "PDF Import failed",
                );
            }

            // The worker already emits the reader's annotation JSON, so this
            // only supplies the fields a PDF has no source for.
            const annotations: AnnotationJSON[] = [];
            for (const annotation of imported) {
                const dateModified = annotation.dateModified ?? "";
                // A PDF annotation records only a modification stamp.
                const dateAdded = annotation.dateAdded ?? dateModified;
                annotations.push({
                    ...annotation,
                    id: Math.round(Math.random() * 4294967295)
                        .toString()
                        .slice(0, 8),
                    isExternal: true,
                    tags: annotation.tags ?? [],
                    dateModified,
                    dateAdded,
                });
            }
            return annotations;
        }, isPriority);
    }

    /**
     * Rotate pages in PDF attachment
     */
    async rotatePages(
        buf: ArrayBuffer,
        pageIndexes: number[],
        degrees: 90 | 180 | 270,
        isPriority?: boolean,
        password?: string,
    ): Promise<ArrayBuffer> {
        return this._enqueue(async () => {
            let modifiedBuf: ArrayBuffer;
            try {
                ({ buf: modifiedBuf } = await this._query<BufferResponse>(
                    "rotatePages",
                    {
                        buf,
                        pageIndexes,
                        degrees,
                        password,
                    },
                    [buf],
                ));
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "PDFProcessWorker",
                    "Rotate Pages failed",
                );
            }

            return modifiedBuf;
        }, isPriority);
    }

    /**
     * Get data for recognizer-server
     */
    async getRecognizerData(
        buf: ArrayBuffer,
        isPriority?: boolean,
        password?: string,
    ): Promise<PDFRecognizerData> {
        return this._enqueue(async () => {
            let result: PDFRecognizerData;
            try {
                result = await this._query<PDFRecognizerData>(
                    "getRecognizerData",
                    { buf, password },
                    [buf],
                );
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "PDFProcessWorker",
                    "Get Recognizer Data failed",
                );
            }
            return result;
        }, isPriority);
    }

    /**
     * Get rendered annotations
     */
    async renderAnnotations(
        libraryID: number,
        buf: ArrayBuffer,
        annotations: AnnotationJSON[],
        password?: string,
    ): Promise<number> {
        return this._enqueue(async () => {
            let result: number;
            try {
                result = await this._query<number>(
                    "renderAnnotations",
                    { libraryID, buf, annotations, password },
                    [buf],
                );
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "PDFProcessWorker",
                    "Render Annotations failed",
                );
            }
            return result;
        });
    }
}
