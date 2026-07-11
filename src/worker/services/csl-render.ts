import { db } from "db/db";
import { CslRenderService } from "worker/csl";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type {
    BibliographyContext,
    CiteProps,
    CSLItem,
    KVStore,
    ResourceFetcher,
    Availability,
    RenderOptions,
    StyleInfo,
} from "worker/csl";
import type { LocaleInfo, StyleIndexEntry } from "worker/csl";
import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";

/** KVStore adapter over the worker-only Dexie `cslCache` table. */
class DexieKVStore implements KVStore {
    async get(key: string): Promise<string | null> {
        const entry = await db.cslCache.get(key);
        return entry ? entry.value : null;
    }

    async set(key: string, value: string): Promise<void> {
        await db.cslCache.put({ key, value });
    }

    async list(prefix: string): Promise<string[]> {
        return db.cslCache.where("key").startsWith(prefix).primaryKeys();
    }

    async delete(key: string): Promise<void> {
        await db.cslCache.delete(key);
    }
}

/**
 * ResourceFetcher over the worker's global fetch (transparently proxied
 * through ParentHost.request, so it bypasses CORS and works on mobile).
 * Only ever fetches data (XML/JSON) — never code.
 */
class WorkerFetcher implements ResourceFetcher {
    async fetchText(url: string): Promise<string> {
        // Worker code cannot use requestUrl (main-thread Obsidian API); the
        // worker's global fetch is patched in worker.ts to proxy through
        // ParentHost.request, which uses requestUrl under the hood.
        // eslint-disable-next-line no-restricted-globals
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`);
        }
        return res.text();
    }
}

/**
 * Worker-side CSL rendering service. Wraps the vendored csl-render core with
 * ZotFlow's storage (Dexie) and network (proxied fetch), and flattens the
 * stateful BibliographyContext API into id-keyed methods so it can cross the
 * Comlink boundary.
 */
export class CslRenderWorkerService {
    private core: CslRenderService;
    private ready: Promise<void>;
    private contexts = new Map<string, BibliographyContext>();

    constructor(
        settings: ZotFlowSettings,
        private parentHost: IParentProxy,
    ) {
        this.core = new CslRenderService({
            fetcher: new WorkerFetcher(),
            store: new DexieKVStore(),
            defaultLocale: settings.cslDefaultLocale,
            defaultFormat: settings.cslDefaultFormat,
            styleUrlTemplate: settings.cslStyleUrlTemplate,
            localeUrlTemplate: settings.cslLocaleUrlTemplate,
        });
        this.ready = this.core.init().catch((e: unknown) => {
            void this.parentHost.log(
                "error",
                "CSL core init failed",
                "CslRenderWorkerService",
                e,
            );
        });
    }

    updateSettings(settings: ZotFlowSettings): void {
        this.core.setDefaults({
            locale: settings.cslDefaultLocale,
            format: settings.cslDefaultFormat,
        });
        this.core.setSources({
            styleUrlTemplate: settings.cslStyleUrlTemplate,
            localeUrlTemplate: settings.cslLocaleUrlTemplate,
        });
    }

    dispose(): void {
        for (const ctx of this.contexts.values()) {
            ctx.dispose();
        }
        this.contexts.clear();
    }

    /* ------------------------------ rendering ------------------------- */

    async renderBibliography(
        items: CSLItem[],
        opts: RenderOptions,
    ): Promise<string[]> {
        await this.ready;
        return this.core.renderBibliography(items, opts);
    }

    async renderCitation(
        items: CSLItem[],
        opts: RenderOptions,
    ): Promise<string> {
        await this.ready;
        return this.core.renderCitation(items, opts);
    }

    /* --------------------- id-keyed context API ------------------------ */

    async createContext(opts: RenderOptions): Promise<string> {
        await this.ready;
        const ctx = await this.core.createContext(opts);
        const id = crypto.randomUUID();
        this.contexts.set(id, ctx);
        return id;
    }

    private getContext(id: string): BibliographyContext {
        const ctx = this.contexts.get(id);
        if (!ctx) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "CslRenderWorkerService",
                `Unknown CSL context "${id}" (already disposed?)`,
            );
        }
        return ctx;
    }

    contextRegisterItems(id: string, items: CSLItem[]): void {
        this.getContext(id).registerItems(items);
    }

    contextAddCitation(
        id: string,
        itemIds: string[],
        props?: CiteProps,
    ): string {
        return this.getContext(id).addCitation(itemIds, props);
    }

    contextMakeBibliography(id: string): string[] {
        return this.getContext(id).makeBibliography();
    }

    contextRebuild(id: string): void {
        this.getContext(id).rebuild();
    }

    disposeContext(id: string): void {
        this.contexts.get(id)?.dispose();
        this.contexts.delete(id);
    }

    /* --------------------- style / locale management ------------------- */

    async ensureStyle(id: string): Promise<Availability> {
        await this.ready;
        return this.core.ensureStyle(id);
    }

    async resolveDeps(id: string): Promise<Availability> {
        await this.ready;
        return this.core.resolveDeps(id);
    }

    async listStyles(): Promise<StyleInfo[]> {
        await this.ready;
        return this.core.listStyles();
    }

    async registerCustomStyle(
        key: string,
        xml: string,
        source: "folder" | "paste",
    ): Promise<Availability> {
        await this.ready;
        return this.core.registerCustomStyle(key, xml, { source });
    }

    async unregisterCustomStyle(key: string): Promise<void> {
        await this.ready;
        await this.core.unregisterCustomStyle(key);
    }

    async clearFolderStyles(): Promise<void> {
        await this.ready;
        this.core.clearFolderStyles();
    }

    async removeStyle(id: string): Promise<void> {
        await this.ready;
        await this.core.removeStyle(id);
    }

    async registerCustomLocale(lang: string, xml: string): Promise<void> {
        await this.ready;
        this.core.registerCustomLocale(lang, xml);
    }

    async unregisterCustomLocale(lang: string): Promise<void> {
        await this.ready;
        this.core.unregisterCustomLocale(lang);
    }

    async listLocales(): Promise<LocaleInfo[]> {
        await this.ready;
        return this.core.listLocales();
    }

    async ensureLocale(lang: string): Promise<boolean> {
        await this.ready;
        return this.core.ensureLocale(lang);
    }

    async removeLocale(lang: string): Promise<void> {
        await this.ready;
        await this.core.removeLocale(lang);
    }

    async searchStyleIndex(
        query: string,
        limit?: number,
    ): Promise<StyleIndexEntry[]> {
        await this.ready;
        return this.core.searchStyleIndex(query, limit);
    }

    async clearCache(): Promise<void> {
        await this.ready;
        await this.core.clearCache();
    }
}
