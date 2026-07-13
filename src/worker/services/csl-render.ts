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
    LocalePreview,
    RenderOptions,
    StyleInfo,
    StylePreview,
    StyleSample,
    StyleUpdateReport,
    UpdateAllReport,
    UpdateStatus,
} from "worker/csl";
import type { LocaleInfo } from "worker/csl";
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
    // Worker code cannot use requestUrl (main-thread Obsidian API); the
    // worker's global fetch is patched in worker.ts to proxy through
    // ParentHost.request, which uses requestUrl under the hood.
    async fetchText(url: string): Promise<string> {
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
    private contexts = new Map<string, BibliographyContext>();

    constructor(settings: ZotFlowSettings) {
        this.core = new CslRenderService({
            fetcher: new WorkerFetcher(),
            store: new DexieKVStore(),
            defaultFormat: settings.cslDefaultFormat,
        });
    }

    updateSettings(settings: ZotFlowSettings): void {
        this.core.setDefaults({ format: settings.cslDefaultFormat });
    }

    dispose(): void {
        for (const ctx of this.contexts.values()) {
            ctx.dispose();
        }
        this.contexts.clear();
    }

    /* ------------------------------ rendering ------------------------- */

    renderBibliography(
        items: CSLItem[],
        opts: RenderOptions,
    ): Promise<string[]> {
        return this.core.renderBibliography(items, opts);
    }

    renderCitation(
        items: CSLItem[],
        opts: RenderOptions,
        props?: CiteProps | (CiteProps | undefined)[],
    ): Promise<string> {
        return this.core.renderCitation(items, opts, props);
    }

    /* --------------------- id-keyed context API ------------------------ */

    async createContext(opts: RenderOptions): Promise<string> {
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

    ensureStyle(id: string): Promise<Availability> {
        return this.core.ensureStyle(id);
    }

    resolveDeps(id: string): Promise<Availability> {
        return this.core.resolveDeps(id);
    }

    listStyles(): Promise<StyleInfo[]> {
        return this.core.listStyles();
    }

    /** Fetch a style by id or URL for preview; nothing is installed yet. */
    previewStyle(input: string): Promise<StylePreview> {
        return this.core.previewStyle(input);
    }

    /** Install a previewed style (dependency chain + default locale included). */
    addStyle(preview: StylePreview): Promise<Availability> {
        return this.core.addStyle(preview);
    }

    /** Refetch a downloaded style and its whole dependency chain. */
    updateStyle(id: string): Promise<StyleUpdateReport> {
        return this.core.updateStyle(id);
    }

    /** Refetch every downloaded style once (shared parents deduplicated). */
    updateAllStyles(): Promise<UpdateAllReport> {
        return this.core.updateAllStyles();
    }

    /** Refetch every downloaded locale. */
    updateAllLocales(): Promise<UpdateAllReport> {
        return this.core.updateAllLocales();
    }

    /** When update-all last ran for styles / locales. */
    getUpdateStatus(): Promise<UpdateStatus> {
        return this.core.getUpdateStatus();
    }

    /** Rendered sample for an installed style (Details modal), best-effort. */
    styleSample(id: string): Promise<StyleSample | undefined> {
        return this.core.styleSample(id);
    }

    /** Register a style from the vault styles folder. */
    registerCustomStyle(key: string, xml: string): Promise<Availability> {
        return this.core.registerCustomStyle(key, xml);
    }

    // Comlink makes every call async on the main-thread side, so these
    // return promises even though the core operations are synchronous.
    unregisterCustomStyle(key: string): Promise<void> {
        this.core.unregisterCustomStyle(key);
        return Promise.resolve();
    }

    clearFolderStyles(): Promise<void> {
        this.core.clearFolderStyles();
        return Promise.resolve();
    }

    removeStyle(id: string): Promise<void> {
        return this.core.removeStyle(id);
    }

    registerCustomLocale(lang: string, xml: string): Promise<void> {
        this.core.registerCustomLocale(lang, xml);
        return Promise.resolve();
    }

    unregisterCustomLocale(lang: string): Promise<void> {
        this.core.unregisterCustomLocale(lang);
        return Promise.resolve();
    }

    listLocales(): Promise<LocaleInfo[]> {
        return this.core.listLocales();
    }

    /** Fetch a locale by tag for preview; nothing is installed yet. */
    previewLocale(lang: string): Promise<LocalePreview> {
        return this.core.previewLocale(lang);
    }

    /** Install a previewed locale. */
    addLocale(preview: LocalePreview): Promise<void> {
        return this.core.addLocale(preview);
    }

    /** Refetch a downloaded locale from its recorded source URL. */
    updateLocale(lang: string): Promise<{ updated: boolean }> {
        return this.core.updateLocale(lang);
    }

    ensureLocale(lang: string): Promise<boolean> {
        return this.core.ensureLocale(lang);
    }

    removeLocale(lang: string): Promise<void> {
        return this.core.removeLocale(lang);
    }

    clearCache(): Promise<void> {
        return this.core.clearCache();
    }
}
