import { TFile, App } from "obsidian";
import { services } from "services/services";
import type { LogService } from "./log-service";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

/**
 * IndexService is a service that indexes all markdown files in the vault.
 * It uses the metadataCache to get the zotero-key from the frontmatter.
 * It uses the vault to get the markdown files.
 */
export class IndexService {
    private keyToFileMap: Map<string, TFile> = new Map();
    private app: App;

    private _initialized: boolean = false;
    private resolve!: () => void;
    private _initializePromise: Promise<void> = new Promise((resolve) => {
        this.resolve = resolve;
    });

    constructor(
        app: App,
        private _logService: LogService,
    ) {
        this.app = app;
    }

    get initializePromise(): Promise<void> {
        return this._initializePromise;
    }

    // Initialize
    public load() {
        // Wait for Obsidian layout to be ready before the first scan
        this.app.workspace.onLayoutReady(() => {
            this._logService.log(
                "debug",
                "Layout ready, building index...",
                "IndexService",
            );
            this.rebuildIndex();
            this.registerEvents();
            this._initialized = true;
            this.resolve?.();
        });
    }

    // Listen for changes (incremental updates, no need for full rescan)
    private registerEvents() {
        // Listen for metadata changes (including Frontmatter modifications)
        this.app.metadataCache.on("changed", (file) => {
            this.indexFile(file);
        });

        // Listen for file rename/move
        this.app.vault.on("rename", (file, oldPath) => {
            if (file instanceof TFile) this.indexFile(file);
        });

        // Listen for deletion
        this.app.vault.on("delete", (file) => {
            if (file instanceof TFile) this.removeFileIndex(file);
        });
    }

    // Build index
    private rebuildIndex() {
        this.keyToFileMap.clear();
        const files = this.app.vault.getMarkdownFiles();

        files.forEach((file) => {
            this.indexFile(file);
        });

        this._logService.log(
            "info",
            `Index built. Found ${this.keyToFileMap.size} linked files.`,
            "IndexService",
        );
    }

    // Process a single file
    public indexFile(file: TFile) {
        // Get data from cache, do not await read()
        const cache = this.app.metadataCache.getFileCache(file);
        // Frontmatter is whatever the user typed, so the value has to be
        // checked rather than trusted — a numeric key would otherwise be
        // stored under a key nothing can look up.
        const zoteroKey: unknown = cache?.frontmatter?.["zotero-key"];

        if (typeof zoteroKey === "string" && zoteroKey) {
            this.keyToFileMap.set(zoteroKey, file);
        }
    }

    private removeFileIndex(file: TFile) {
        for (const [key, indexedFile] of this.keyToFileMap.entries()) {
            if (indexedFile.path === file.path) {
                this.keyToFileMap.delete(key);
                break;
            }
        }
    }

    // Public query API
    public getFileByKey(key: string): TFile | undefined {
        if (!this._initialized) {
            services.notificationService.notify(
                "warning",
                "Index not initialized. Please wait for the layout to be ready.",
            );

            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "IndexService",
                "Index not initialized. Please wait for the layout to be ready.",
            );
        }
        return this.keyToFileMap.get(key);
    }

    /** Return all indexed zotero-key → TFile entries (for vault-wide operations like repair). */
    public getAllIndexedFiles(): ReadonlyMap<string, TFile> {
        return this.keyToFileMap;
    }
}
