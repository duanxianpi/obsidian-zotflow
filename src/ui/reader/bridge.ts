import type {
    ChildAPI,
    ParentAPI,
    CreateReaderOptions,
    ColorScheme,
    ChildEvents,
    AnnotationJSON,
} from "types/zotero-reader";

import { EditorView } from "@codemirror/view";
import { Component, MarkdownRenderer, Platform } from "obsidian";
import { v4 as uuidv4 } from "uuid";
import { connect, WindowMessenger } from "penpal";
import { getBlobUrls } from "bundle-assets/inline-assets";
import { services } from "services/services";
import { workerBridge } from "bridge";

import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { LocalDataManager } from "./local-data-manager";
import { getLinkedLocalSourceNote } from "utils/file";
import type { TFile } from "obsidian";
import type { CitationFormat } from "settings/types";
import {
    ZOTFLOW_CITATION_MIME,
    stripAnnotationForPayload,
    type ZotFlowCitationPayload,
} from "ui/editor/citation-helper";
import {
    createEmbeddableMarkdownEditor,
    EmbeddableMarkdownEditor,
    type MarkdownEditorProps,
} from "ui/editor/markdown-editor";

type BridgeState =
    | "idle"
    | "connecting"
    | "bridge-ready"
    | "reader-ready"
    | "disposing"
    | "disposed";

// The bootstrap signature we temporarily install on the CHILD window.
type DirectBridgeBootstrap = () => {
    token: string;
    parent: ParentAPI;
    register: (childAPI: ChildAPI, token: string) => Promise<{ ok: boolean }>;
};

/** Penpal-based state machine managing the reader iframe lifecycle and bidirectional RPC. */
export class IframeReaderBridge {
    private iframe: HTMLIFrameElement | null = null;
    private child?: ChildAPI; // Direct reference to Child API (replaces RemoteProxy<ChildAPI>)
    private _state: BridgeState = "idle";
    private afterBridgeReadyQueue: Array<() => Promise<void>> = [];
    private afterReaderReadyQueue: Array<() => Promise<void>> = [];
    private typedListeners = new Map<
        ChildEvents["type"],
        Set<(e: ChildEvents) => void>
    >();
    private connectTimeoutMs = 8000;
    private readyPromiseResolver: (() => void) | null = null;

    private editorList: EmbeddableMarkdownEditor[] = [];
    private rendererList: Component[] = [];
    private _readerOpts: CreateReaderOptions | undefined;

    private token: string | null = null;

    /**
     * Bumped by every `connect()`. A connect whose generation is stale (because
     * `reconnect()` superseded it) unwinds at its next checkpoint instead of
     * driving a child that has already been thrown away.
     */
    private connectGeneration = 0;

    /**
     * `load` events seen on the CURRENT iframe element. Obsidian reparents the
     * DOM when a panel is split or popped out, which reloads the iframe while
     * the element itself survives — so anything past the first load means the
     * child realm was replaced under us. Each `connect()` builds a new element,
     * so this resets naturally and a reconnect's own first load never counts.
     */
    private iframeLoadCount = 0;

    /** De-dupes overlapping reconnects (split, then immediately drag out). */
    private reconnectPromise: Promise<void> | null = null;

    constructor(
        private container: HTMLElement,
        private isLocal: boolean,
        private attachmentItem?: IDBZoteroItem<AttachmentData>,
        private localAttachment?: TFile,
        private localDataManager?: LocalDataManager,
    ) {}

    /**
     * Listen to specific event types from the child iframe with type safety
     */
    onEventType<T extends ChildEvents["type"]>(
        eventType: T,
        cb: (e: Extract<ChildEvents, { type: T }>) => void,
    ) {
        if (!this.typedListeners.has(eventType)) {
            this.typedListeners.set(eventType, new Set());
        }
        const typedCb = cb;
        this.typedListeners.get(eventType)!.add(typedCb);
        return () => {
            const listeners = this.typedListeners.get(eventType);
            if (listeners) {
                listeners.delete(typedCb);
                if (listeners.size === 0) {
                    this.typedListeners.delete(eventType);
                }
            }
        };
    }

    private makeToken() {
        try {
            return uuidv4();
        } catch {
            return `${Math.random()}-${Date.now()}`;
        }
    }

    private getParentItemKey(): string | undefined {
        if (!this.attachmentItem) return undefined;
        return this.attachmentItem.parentItem === ""
            ? this.attachmentItem.key
            : this.attachmentItem.parentItem;
    }

    private getReaderSourceNotePath(): string | undefined {
        if (this.isLocal && this.localAttachment) {
            return getLinkedLocalSourceNote(services.app, this.localAttachment)
                ?.path;
        }
        const parentKey = this.getParentItemKey();
        if (parentKey) {
            return services.indexService.getFileByKey(parentKey)?.path;
        }
        return undefined;
    }

    private buildParentAPI(): ParentAPI {
        return {
            getBlobUrlMap: () => getBlobUrls(),

            isAndroidApp: () => Platform.isAndroidApp,

            isLocalReader: () => this.isLocal,

            handleEvent: (evt) => {
                const ls = this.typedListeners.get(evt.type);
                if (ls) ls.forEach((l) => l(evt));
            },

            getOrigin: () => {
                return window.location.origin;
            },

            getMathJaxConfig: () => {
                return (window as any).MathJax?.config || {};
            },

            getColorScheme: () => {
                return getComputedStyle(document.body)
                    .colorScheme as ColorScheme;
            },

            getStyleSheets: () => {
                return document.styleSheets;
            },

            getPluginSettings: () => {
                return services.settings;
            },

            getLinkToSelection: (text: string, navigationInfo: any) => {
                if (this.isLocal && this.localAttachment) {
                    const note = getLinkedLocalSourceNote(
                        services.app,
                        this.localAttachment,
                    );

                    if (note) {
                        const filePath = this.localAttachment.path;
                        const encodedNavigationInfo = encodeURIComponent(
                            JSON.stringify(navigationInfo),
                        );

                        return `[[${filePath}${navigationInfo.pageLabel ? `#page=${navigationInfo.pageLabel}` : ""}#annotation=${encodedNavigationInfo})|${text}]]`;
                    }

                    return "";
                } else if (!this.isLocal && this.attachmentItem) {
                    const note = services.indexService.getFileByKey(
                        this.attachmentItem.parentItem === ""
                            ? this.attachmentItem.key
                            : this.attachmentItem.parentItem,
                    );
                    if (note) {
                        const libraryID = this.attachmentItem.libraryID;
                        const itemKey = this.attachmentItem.key;
                        const encodedNavigationInfo = encodeURIComponent(
                            JSON.stringify(navigationInfo),
                        );

                        return `[${text}](obsidian://zotflow?type=open-attachment&libraryID=${libraryID}&key=${itemKey}&navigation=${encodedNavigationInfo})`;
                    }
                    return "";
                }
                return "";
            },

            handleSetDataTransferAnnotations: (
                dataTransfer: DataTransfer,
                annotations: AnnotationJSON[],
                fromText?: boolean,
            ) => {
                if (fromText) {
                    dataTransfer.setData(
                        "text/plain",
                        annotations
                            .map((a) => a.text || "")
                            .join("\n")
                            .trim(),
                    );
                    return;
                }

                // Annotation drag: set citation MIME for Zotero items
                if (
                    !this.isLocal &&
                    this.attachmentItem &&
                    annotations.length
                ) {
                    const parentKey = this.getParentItemKey()!;
                    const libraryID = this.attachmentItem.libraryID;
                    const payload: ZotFlowCitationPayload = {
                        type: "zotflow-citation",
                        libraryID,
                        key: parentKey,
                        // The reader strips `libraryID`/`parentItem` from
                        // annotations during drag, so restore them from the
                        // attachment for annotation-link generation and the
                        // CSL citation filter (page locator resolution).
                        annotations: annotations.map((a) => ({
                            ...stripAnnotationForPayload(a),
                            libraryID,
                            parentItem: this.attachmentItem!.key,
                        })),
                    };
                    dataTransfer.setData(
                        ZOTFLOW_CITATION_MIME,
                        JSON.stringify(payload),
                    );
                }

                // text/plain fallback: embed links if source note exists
                const notePath = this.getReaderSourceNotePath();
                if (notePath) {
                    const content = annotations.reduce(
                        (acc, anno) => acc + `![[${notePath}#^${anno.id}]]\n\n`,
                        "",
                    );
                    dataTransfer.setData("text/plain", content.trim());
                } else {
                    dataTransfer.setData("text/plain", " ");
                }
            },

            copyAnnotationCitation: (
                annotations: AnnotationJSON[],
                format: string,
            ) => {
                // Fire-and-forget: async resolution + clipboard write
                void (async () => {
                    try {
                        if (format === "text") {
                            const text = annotations
                                .map((a) => a.text)
                                .filter(Boolean)
                                .join("\n");
                            await navigator.clipboard.writeText(text.trim());
                            return;
                        }
                        if (format === "embed") {
                            const notePath = this.getReaderSourceNotePath();
                            if (notePath) {
                                const text = annotations
                                    .map((a) => `![[${notePath}#^${a.id}]]`)
                                    .join("\n");
                                await navigator.clipboard.writeText(text);
                            }
                            return;
                        }
                        // Citation formats: resolve via CitationService
                        const parentKey = this.getParentItemKey();
                        if (!this.attachmentItem || !parentKey) return;
                        const citationFormat =
                            format === "default"
                                ? services.settings.defaultCitationFormat
                                : (format as CitationFormat);
                        const result = await services.citationService.resolve(
                            {
                                libraryID: this.attachmentItem.libraryID,
                                key: parentKey,
                                annotations: annotations.map((a) => ({
                                    ...stripAnnotationForPayload(a),
                                    libraryID: this.attachmentItem!.libraryID,
                                    parentItem: this.attachmentItem!.key,
                                })),
                            },
                            citationFormat,
                        );
                        if (result) {
                            let text = result.citation;
                            if (result.footnoteDef) {
                                text += "\n" + result.footnoteDef;
                            }
                            await navigator.clipboard.writeText(text);
                        }
                    } catch (e) {
                        services.logService.error(
                            "Failed to copy annotation citation",
                            "IframeReaderBridge",
                            e,
                        );
                    }
                })();
            },

            createAnnotationEditor: (
                container: HTMLElement,
                options: Partial<MarkdownEditorProps>,
            ) => {
                const editor = createEmbeddableMarkdownEditor(
                    (window as any).app,
                    container,
                    {
                        ...options,
                        onBlur: (editor) => {
                            editor.activeCM.dispatch({
                                effects: EditorView.scrollIntoView(0, {
                                    y: "start",
                                }),
                            });
                        },
                        showLineNumbers: false,
                    },
                );
                this.editorList.push(editor);
                const originalOnunload = editor.onunload.bind(editor);
                editor.onunload = () => {
                    originalOnunload();
                    const idx = this.editorList.indexOf(editor);
                    if (idx !== -1) this.editorList.splice(idx, 1);
                };
                return editor;
            },

            renderMarkdownToContainer: (
                container: HTMLElement,
                text: string,
            ) => {
                const comp = new Component();
                comp.load();
                container.empty();
                container.addClass("content");
                void MarkdownRenderer.render(
                    services.app,
                    text,
                    container,
                    "",
                    comp,
                );
                this.rendererList.push(comp);
                return {
                    unload: () => {
                        comp.unload();
                        const idx = this.rendererList.indexOf(comp);
                        if (idx !== -1) this.rendererList.splice(idx, 1);
                    },
                };
            },
        };
    }

    async connect() {
        if (this._state !== "idle" && this._state !== "disposed") return;
        this._state = "connecting";

        const generation = ++this.connectGeneration;
        /** True once `reconnect()` has started a newer attempt. */
        const superseded = () => generation !== this.connectGeneration;

        const readyPromise = new Promise<void>((resolve) => {
            this.readyPromiseResolver = resolve;
        });

        // Create iframe. A fresh element per connect, so `iframeLoadCount`
        // counts loads of THIS element only.
        this.iframeLoadCount = 0;
        const doc = this.container.ownerDocument; // Get the document of the container
        this.iframe = doc.createElement("iframe");
        this.iframe.id = "zotero-reader-iframe";
        this.iframe.setCssStyles({
            width: "100%",
            height: "100%",
            border: "none",
        });
        const src = getBlobUrls()["reader.html"]!;

        if (Platform.isAndroidApp) {
            const srcdoc = await fetch(src).then((res) => res.text());
            this.iframe.srcdoc = srcdoc;
        } else {
            this.iframe.src = src;
        }

        // Sandbox as before (same-origin required for direct access)
        this.iframe.sandbox.add("allow-scripts");
        this.iframe.sandbox.add("allow-same-origin");
        this.iframe.sandbox.add("allow-forms");

        this.iframe.onload = () => {
            this.iframeLoadCount++;

            // Apply Obsidian color-scheme classes based on setting
            const scheme = services.settings.readerColorScheme;
            const iframeDoc = this.iframe?.contentDocument;
            if (iframeDoc) {
                let isDark = false;
                if (scheme === "light") {
                    isDark = false;
                } else if (scheme === "dark") {
                    isDark = true;
                } else {
                    // "obsidian" or "obsidian-theme", detect from parent
                    const parentBody =
                        this.iframe?.contentWindow?.parent?.document.body;
                    if (parentBody) {
                        isDark =
                            getComputedStyle(parentBody).colorScheme === "dark";
                    }
                }
                iframeDoc.documentElement.classList.toggle(
                    "obsidian-theme-dark",
                    isDark,
                );
                iframeDoc.documentElement.classList.toggle(
                    "obsidian-theme-light",
                    !isDark,
                );
                if (scheme === "obsidian-theme") {
                    iframeDoc.documentElement.setAttribute(
                        "data-obsidian-theme",
                        "",
                    );
                }
            }

            // A second load on the same element means Obsidian reparented the
            // panel (split / pop-out) and the browser replaced the child realm.
            // The old `child` reference and, crucially, penpal's WindowMessenger
            // are both bound to a Window that no longer exists — penpal drops
            // any message whose source is not the exact `remoteWindow` it was
            // constructed with, so the connection cannot be re-pointed. Tearing
            // down and rebuilding is the only recovery.
            //
            // Counting loads rather than inspecting `_state`/`_readerOpts` makes
            // this independent of whether the child's handshake happened to beat
            // the `load` event, and it recovers reloads that land before the
            // first `initReader` too.
            if (this.iframeLoadCount > 1 && !superseded()) {
                services.logService.warn(
                    "Iframe reloaded unexpectedly, triggering reconnection",
                    "IframeReaderBridge",
                );
                // Deferred so the reconnect never runs inside the load handler.
                setTimeout(() => {
                    void this.reconnect().catch((e: unknown) => {
                        services.logService.error(
                            "Reconnection after iframe reload failed",
                            "IframeReaderBridge",
                            e,
                        );
                    });
                }, 0);
            }
        };

        // Attach first to get a contentWindow
        this.container.replaceChildren(this.iframe);

        const messenger = new WindowMessenger({
            remoteWindow: this.iframe.contentWindow!,
            allowedOrigins: ["*"],
        });

        const conn = connect({
            messenger,
            methods: {
                shakehand: async () => {
                    if (this.iframe?.contentWindow) {
                        this.token = this.makeToken();
                        const parentAPI = this.buildParentAPI();

                        const register = async (
                            childAPI: ChildAPI,
                            t: string,
                        ) => {
                            if (t !== this.token)
                                throw new Error("Bridge token mismatch");
                            this.child = childAPI;
                            this._state = "bridge-ready";

                            // Drain after bridge ready queued calls
                            const tasks = [...this.afterBridgeReadyQueue];
                            this.afterBridgeReadyQueue.length = 0;
                            for (const t of tasks) await t();
                            if (this.readyPromiseResolver)
                                this.readyPromiseResolver();
                            return { ok: true };
                        };

                        const _bridge: DirectBridgeBootstrap = () => ({
                            token: this.token!,
                            parent: parentAPI,
                            register,
                        });
                        // Make it non-enumerable & configurable (child can delete after use)
                        Object.defineProperty(
                            this.iframe.contentWindow as any,
                            "__OBSIDIAN_BRIDGE__",
                            {
                                value: _bridge,
                                enumerable: false,
                                writable: false,
                                configurable: true,
                            },
                        );
                    }
                },
            },
        });

        // Wait for child to setup penpal connection
        const remotePromise = conn.promise;
        await Promise.race([
            remotePromise,
            new Promise<never>((_, rej) =>
                setTimeout(
                    () => rej(new Error("Child connect timeout")),
                    this.connectTimeoutMs,
                ),
            ),
        ]);
        if (superseded()) return;

        // Wait until the child calls register() (state becomes "ready") or timeout
        await Promise.race([
            readyPromise,
            new Promise<never>((_, rej) =>
                setTimeout(
                    () => rej(new Error("Child connect timeout")),
                    this.connectTimeoutMs,
                ),
            ),
        ]);
        // `dispose()` resolves the ready promise so a superseded connect unwinds
        // here immediately, instead of hanging until its timeout rejects.
        if (superseded()) return;

        // Replay the document into the fresh iframe. Only reachable on a
        // reconnect: on a first connect `_readerOpts` is still unset, because
        // both views await `connect()` before calling `initReader`.
        //
        // The `reader-ready` check covers the other order — if a caller does
        // call `initReader` while we are still connecting, the bridge-ready
        // queue has already served it by now, and replaying would load the
        // document a second time.
        //
        // Read through the getter: control-flow analysis still has `_state`
        // narrowed to the `"connecting"` assigned at the top of this method,
        // because the mutation happens inside the `register` callback.
        if (this._readerOpts && this.state !== "reader-ready") {
            // Update annotation json
            let newAnnotationJson: AnnotationJSON[] = [];

            if (!this.isLocal && this.attachmentItem) {
                newAnnotationJson =
                    await workerBridge.annotation.getAnnotations(
                        this.attachmentItem,
                        services.settings.zoteroapikey,
                    );
            } else if (this.isLocal && this.localDataManager) {
                newAnnotationJson = this.localDataManager.getAllAnnotations();
            }
            if (superseded()) return;

            // `_readerOpts` carries the view state as of the last
            // `updateReaderOpts()` — the owning view refreshes it on every
            // `viewStateChanged`, so the reader comes back where the user left
            // it rather than where the file was first opened.
            const newReaderOpts: CreateReaderOptions = {
                ...this._readerOpts,
                annotations: newAnnotationJson,
            };

            await this.initReader(newReaderOpts);
        }
    }

    /**
     * Merge a patch into the cached reader options used to replay the document
     * after an unexpected iframe reload.
     *
     * The views call this from their `viewStateChanged` handler. Without it the
     * cache keeps the snapshot taken when the file was opened, and a panel split
     * or pop-out would scroll the reader back to that position.
     *
     * A no-op before the first `initReader` — there is nothing to replay yet,
     * and the view reads the live state from `ViewStateService` in that window
     * anyway.
     */
    updateReaderOpts(patch: Partial<CreateReaderOptions>) {
        if (!this._readerOpts) return;
        this._readerOpts = { ...this._readerOpts, ...patch };
    }

    private runAfterBridgeReady(fn: () => Promise<void>) {
        if (this._state === "bridge-ready" || this._state === "reader-ready")
            return fn();
        if (this._state === "connecting") {
            this.afterBridgeReadyQueue.push(fn);
            return Promise.resolve();
        }
        return Promise.reject(
            new Error(`Bridge not ready (state=${this._state})`),
        );
    }

    private runAfterReaderReady(fn: () => Promise<void>) {
        if (this._state === "reader-ready") return fn();
        if (this._state === "connecting" || this._state === "bridge-ready") {
            this.afterReaderReadyQueue.push(fn);
            return Promise.resolve();
        }
        return Promise.reject(
            new Error(`Bridge not ready (state=${this._state})`),
        );
    }

    initReader(opts: CreateReaderOptions) {
        this._readerOpts = opts;
        return this.runAfterBridgeReady(async () => {
            await this.child!.initReader(opts);
            this._state = "reader-ready";

            // Drain after reader ready queued calls
            const tasks = [...this.afterReaderReadyQueue];
            this.afterReaderReadyQueue.length = 0;
            for (const t of tasks) await t();
        });
    }

    setColorScheme(colorScheme: ColorScheme) {
        return this.runAfterBridgeReady(async () => {
            await this.child!.setColorScheme(colorScheme);
        });
    }

    addAnnotation(annotation: AnnotationJSON) {
        return this.runAfterReaderReady(async () => {
            await this.child!.addAnnotation(annotation);
        });
    }

    refreshAnnotations(annotations: AnnotationJSON[]) {
        return this.runAfterReaderReady(async () => {
            await this.child!.refreshAnnotations(annotations);
        });
    }

    navigate(navigationInfo: any) {
        return this.runAfterReaderReady(async () => {
            await this.child!.navigate(navigationInfo);
        });
    }

    async dispose(clearListeners = true) {
        if (this._state === "disposed") return;
        this.editorList.forEach((editor) => editor.onunload());
        this.editorList.length = 0;
        this.rendererList.forEach((comp) => comp.unload());
        this.rendererList.length = 0;
        this._state = "disposing";

        // Release a `connect()` still waiting on the child to register. It
        // checks its generation right after and unwinds without touching the
        // torn-down child; leaving it parked would stall it until its own 8 s
        // timeout rejected, long after a reconnect had taken over.
        const releasePendingConnect = this.readyPromiseResolver;
        this.readyPromiseResolver = null;
        releasePendingConnect?.();

        try {
            if (this.iframe?.contentWindow) {
                delete (this.iframe.contentWindow as any).__OBSIDIAN_BRIDGE__;
            }
        } catch {}
        this.child = undefined;
        this.iframe?.remove();
        this.iframe = null;
        this.token = null;
        // Nothing queued can run against a child that no longer exists.
        this.afterBridgeReadyQueue.length = 0;
        this.afterReaderReadyQueue.length = 0;
        if (clearListeners) this.typedListeners.clear();
        this._state = "disposed";
    }

    /**
     * Rebuild the iframe and the penpal connection from scratch, keeping the
     * cached reader options so the document is replayed.
     *
     * Concurrent callers share one attempt: a split immediately followed by a
     * drag-out fires two `load` events, and starting two `connect()`s would
     * leave the first orphaned on a detached iframe.
     */
    reconnect(): Promise<void> {
        if (this.reconnectPromise) return this.reconnectPromise;
        this.reconnectPromise = (async () => {
            try {
                await this.dispose(false);
                await this.connect();
            } finally {
                this.reconnectPromise = null;
            }
        })();
        return this.reconnectPromise;
    }

    public get state(): BridgeState {
        return this._state;
    }
}
