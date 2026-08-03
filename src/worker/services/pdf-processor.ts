/*
 * Ported from Zotero's `chrome/content/zotero/xpcom/pdfWorker/manager.js`
 * (AGPL-3.0). The transport protocol, the request/response bookkeeping and the
 * queue semantics are kept structurally identical to upstream so the port can
 * be followed forward when Zotero changes; the message payloads it exchanges
 * with the worker are untyped JSON on both sides.
 *
 * Typing that boundary would mean diverging from the shape being tracked, for
 * no runtime benefit, so the `any` family is switched off for the file rather
 * than worked around inside it.
 */
import * as Comlink from "comlink";
import { db } from "db/db";
import type { ZotFlowSettings } from "settings/types";
import type { IParentProxy } from "bridge/types";
import type { IDBZoteroItem } from "types/db-schema";
import type { AnnotationData } from "types/zotero-item";
import { annotationItemFromJSON } from "db/annotation";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

interface PDFWorkerConfig {
    pdfWorkerURL: string;
}

interface WorkerMessage {
    id?: number;
    responseID?: number;
    action?: string;
    data?: any;
    error?: any;
}

type PromiseResolvers = {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
};

type QueueItem = [
    () => Promise<any>,
    (value: any) => void,
    (reason?: any) => void,
];

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
        let item;
        while ((item = this._queue.shift())) {
            if (item) {
                let [fn, resolve, reject] = item;
                try {
                    resolve(await fn());
                } catch (e) {
                    reject(e);
                }
            }
        }
        this._processingQueue = false;
    }

    async _enqueue<T>(fn: () => Promise<T>, isPriority?: boolean): Promise<T> {
        return new Promise((resolve, reject) => {
            if (isPriority) {
                this._queue.unshift([fn, resolve, reject]);
            } else {
                this._queue.push([fn, resolve, reject]);
            }
            void this._processQueue();
        });
    }

    async _query(
        action: string,
        data: any,
        transfer?: Transferable[],
    ): Promise<any> {
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
            this._waitingPromises[this._lastPromiseID] = { resolve, reject };
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
        this._worker = new Worker(this.config.pdfWorkerURL);
        this._worker.addEventListener(
            "message",
            (event: MessageEvent<WorkerMessage>) => {
                // The listener contract is void; the handler reports its own
                // failures, so the promise is marked rather than returned.
                void (async () => {
                    let message = event.data;
    
                    // Handle Response (Worker -> Main Request)
                    if (message.responseID) {
                        let resolver = this._waitingPromises[message.responseID];
                        if (resolver) {
                            let { resolve, reject } = resolver;
                            delete this._waitingPromises[message.responseID];
                            if (message.data) {
                                resolve(message.data);
                            } else {
                                // Extract error details safely
                                const rawErr = message.error || {};
                                const errMsg =
                                    rawErr.message || JSON.stringify(rawErr);
                                const errName = rawErr.name || "WorkerError";
    
                                // Convert to ZotFlowError
                                // Check specific names if we need to distinguish (e.g. PasswordException)
                                reject(
                                    new ZotFlowError(
                                        ZotFlowErrorCode.PARSE_ERROR,
                                        "PDFProcessWorker",
                                        `PDF Worker Error (${errName}): ${errMsg}`,
                                    ),
                                );
                            }
                        }
                        return;
                    }
    
                    // Handle Request (Worker -> Main Request)
                    if (message.id) {
                        let respData: any = null;
                        let respError: any = null;
    
                        try {
                            if (message.action === "FetchBuiltInCMap") {
                                const cMapUrl =
                                    this._blobUrls[
                                        `pdf/web/cmaps/${message.data}.bcmap`
                                    ];
                                if (cMapUrl) {
                                    const response = await (
                                        globalThis as any
                                    ).originalFetch(cMapUrl);
                                    const arrayBuffer =
                                        await response.arrayBuffer();
                                    respData = {
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
                            respError = { message: (e as Error).message };
                        }
    
                        try {
                            if (message.action === "FetchStandardFontData") {
                                const fontUrl =
                                    this._blobUrls[
                                        `pdf/web/standard_fonts/${message.data}`
                                    ];
                                if (fontUrl) {
                                    const response = await (
                                        globalThis as any
                                    ).originalFetch(fontUrl);
                                    const arrayBuffer =
                                        await response.arrayBuffer();
                                    respData = new Uint8Array(arrayBuffer);
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
                            respError = { message: (e as Error).message };
                        }
    
                        try {
                            if (message.action === "SaveRenderedAnnotation") {
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
    
                                respData = true;
                            }
                        } catch (e) {
                            this.parentHost.log(
                                "error",
                                "Failed to render annotations:",
                                "PDFProcessWorker",
                                e,
                            );
                            respError = { message: (e as Error).message };
                        }
    
                        this._worker!.postMessage({
                            responseID: message.id,
                            data: respData,
                            error: respError, // Explicitly send error back
                        });
                    }
                })();
            },
        );
        this._worker.addEventListener("error", (event) => {
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
    ): Promise<Uint8Array> {
        return this._enqueue(async () => {
            // ... (Logic extracted from original file, largely database independent logic)
            // Need to verify if `items` are raw objects or Dexie objects depending on worker
            // But they are passed as arguments.

            items = items.filter((x) => !x.raw.data.annotationIsExternal);
            let annotations: any[] = [];
            for (let item of items) {
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
                            ? JSON.parse(item.raw.data.annotationPosition)
                            : item.raw.data.annotationPosition,
                    dateModified: item.raw.data.dateModified,
                    tags: item.raw.data.tags.map((x) => x.tag),
                });
            }

            let res: any;
            try {
                res = await this._query("export", { buf, annotations }, [buf]);
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "PDFProcessWorker",
                    "PDF Export failed",
                );
            }
            return res.buf;
        }, isPriority);
    }

    /**
     * Import annotations from PDF file
     */
    async import(buf: ArrayBuffer, isPriority?: boolean): Promise<any[]> {
        return this._enqueue(async () => {
            let imported: any[];
            try {
                ({ imported } = await this._query(
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

            let annotations: any[] = [];
            for (let annotation of imported) {
                annotation.id = Math.round(Math.random() * 4294967295)
                    .toString()
                    .slice(0, 8);
                annotation.isExternal = true;
                annotations.push(annotationItemFromJSON(annotation));
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
                ({ buf: modifiedBuf } = await this._query(
                    "rotatePages",
                    {
                        buf,
                        pageIndexes,
                        degrees,
                        password,
                    },
                    [buf],
                ));
            } catch (e: any) {
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
    ): Promise<any> {
        return this._enqueue(async () => {
            let result: any;
            try {
                result = await this._query(
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
        annotations: any[],
        password?: string,
    ): Promise<any> {
        return this._enqueue(async () => {
            let result: any;
            try {
                result = await this._query(
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
