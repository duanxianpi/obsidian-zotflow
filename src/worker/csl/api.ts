import {
	BibliographyContextImpl,
	EnginePool,
	type BibliographyContext,
} from "./context";
import {
	EngineHost,
	renderBibliographyEntries,
	renderCitationCluster,
	type ResolvedResources,
} from "./engine";
import { UnavailableStyleError } from "./errors";
import { LocaleStore } from "./locales";
import type { KVStore, ResourceFetcher } from "./ports";
import { StyleResolver } from "./resolve";
import { StyleRepository } from "./styles";
import type {
	Availability,
	CSLItem,
	OutputFormat,
	RenderOptions,
	StyleInfo,
} from "./types";

const INDEX_KEY = "style-index";
const INDEX_TS_KEY = "style-index-ts";
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INDEX_URL = "https://www.zotero.org/styles-files/styles.json";

export interface CslRenderServiceConfig {
	fetcher: ResourceFetcher;
	store: KVStore;
	defaultLocale?: string;
	defaultFormat?: OutputFormat;
	/** URL template for style download; `{id}` is replaced with the slug. */
	styleUrlTemplate?: string;
	/** URL template for locale download; `{lang}` is replaced with the tag. */
	localeUrlTemplate?: string;
	/** URL of the searchable style index (Zotero styles.json format). */
	styleIndexUrl?: string;
}

export interface StyleIndexEntry {
	name: string;
	title: string;
	dependent: boolean;
}

export interface LocaleInfo {
	/** Normalized BCP-47 tag, e.g. "de-DE". */
	tag: string;
	source: "builtin" | "folder" | "remote-cache";
}

export class CslRenderService {
	private styles: StyleRepository;
	private locales: LocaleStore;
	private resolver: StyleResolver;
	private pool = new EnginePool();
	private fetcher: ResourceFetcher;
	private store: KVStore;
	private defaultLocale: string;
	private defaultFormat: OutputFormat;
	private styleIndexUrl: string;

	constructor(config: CslRenderServiceConfig) {
		this.fetcher = config.fetcher;
		this.store = config.store;
		this.defaultLocale = config.defaultLocale ?? "en-US";
		this.defaultFormat = config.defaultFormat ?? "text";
		this.styleIndexUrl = config.styleIndexUrl ?? DEFAULT_INDEX_URL;
		this.styles = new StyleRepository(config.fetcher, config.store);
		this.locales = new LocaleStore(config.fetcher, config.store, {
			localeUrlTemplate: config.localeUrlTemplate,
		});
		if (config.styleUrlTemplate) {
			this.styles.setUrlTemplate(config.styleUrlTemplate);
		}
		this.resolver = new StyleResolver(
			this.styles,
			this.locales,
			() => this.defaultLocale
		);
	}

	/** Load persisted custom styles. Call once before first use. */
	async init(): Promise<void> {
		await this.styles.init();
	}

	/* ---------------- configuration (Settings tab hooks) ---------------- */

	setDefaults(opts: { locale?: string; format?: OutputFormat }): void {
		if (opts.locale) this.defaultLocale = opts.locale;
		if (opts.format) this.defaultFormat = opts.format;
	}

	getDefaults(): { locale: string; format: OutputFormat } {
		return { locale: this.defaultLocale, format: this.defaultFormat };
	}

	setSources(opts: {
		styleUrlTemplate?: string;
		localeUrlTemplate?: string;
		styleIndexUrl?: string;
	}): void {
		if (opts.styleUrlTemplate !== undefined) {
			this.styles.setUrlTemplate(opts.styleUrlTemplate);
		}
		if (opts.localeUrlTemplate !== undefined) {
			this.locales.setUrlTemplate(opts.localeUrlTemplate);
		}
		if (opts.styleIndexUrl !== undefined && opts.styleIndexUrl) {
			this.styleIndexUrl = opts.styleIndexUrl;
		}
	}

	/* --------------------------- rendering ------------------------------ */

	private async acquireHost(opts: RenderOptions): Promise<{
		host: EngineHost;
		resolved: ResolvedResources;
	}> {
		const resolved = await this.resolver.prepare(opts);
		try {
			return { host: this.pool.acquire(resolved), resolved };
		} catch (e) {
			// XML was well-formed enough to pass introspection but the engine
			// still refused it: report as invalid, never render half-broken.
			throw new UnavailableStyleError(resolved.requestedId, {
				status: "invalid",
				reason: `engine construction failed: ${(e as Error).message}`,
			});
		}
	}

	async renderBibliography(
		items: CSLItem[],
		opts: RenderOptions
	): Promise<string[]> {
		const { host } = await this.acquireHost(opts);
		try {
			host.setItems(items);
			return renderBibliographyEntries(host, {
				format: opts.format ?? this.defaultFormat,
				htmlContainer: opts.htmlContainer ?? "keep",
			});
		} finally {
			this.pool.release(host);
		}
	}

	async renderCitation(items: CSLItem[], opts: RenderOptions): Promise<string> {
		const { host } = await this.acquireHost(opts);
		try {
			host.setItems(items);
			return renderCitationCluster(
				host,
				items.map((i) => String(i.id)),
				opts.format ?? this.defaultFormat
			);
		} finally {
			this.pool.release(host);
		}
	}

	async createContext(opts: RenderOptions): Promise<BibliographyContext> {
		const { host } = await this.acquireHost(opts);
		return new BibliographyContextImpl(host, this.pool, {
			format: opts.format ?? this.defaultFormat,
			htmlContainer: opts.htmlContainer ?? "keep",
		});
	}

	/* ---------------------- style / locale management ------------------- */

	/** Fetch (if needed) a style and its whole dependency chain; report availability. */
	async ensureStyle(id: string): Promise<Availability> {
		return this.resolver.availability(id, { allowNetwork: true });
	}

	/** Alias used by the "download dependencies" button: closes parent + locale. */
	async resolveDeps(id: string): Promise<Availability> {
		return this.ensureStyle(id);
	}

	/** Availability without touching the network (offline judgment). */
	async availabilityOffline(id: string): Promise<Availability> {
		return this.resolver.availability(id, { allowNetwork: false });
	}

	async registerCustomStyle(
		key: string,
		xml: string,
		meta: { source: "folder" | "paste" }
	): Promise<Availability> {
		const entry = await this.styles.registerCustom(key, xml, meta.source);
		this.pool.clear(); // a same-id override may shadow pooled engines
		if (entry.invalidReason) {
			return { status: "invalid", reason: entry.invalidReason };
		}
		const avail = await this.resolver.availability(key, {
			allowNetwork: true,
		});
		if (avail.status !== "ready") return avail;
		// Deep validation: actually build an engine once so a well-formed but
		// broken style is flagged at registration time, not at render time.
		try {
			const resolved = await this.resolver.prepare({ styleId: key });
			this.pool.release(this.pool.acquire(resolved));
			return { status: "ready" };
		} catch (e) {
			const reason =
				e instanceof UnavailableStyleError
					? e.message
					: `engine construction failed: ${(e as Error).message}`;
			return { status: "invalid", reason };
		}
	}

	async unregisterCustomStyle(key: string): Promise<void> {
		await this.styles.unregisterCustom(key);
		this.pool.clear();
	}

	/** Register a locale XML supplied by the platform (vault folder). */
	registerCustomLocale(lang: string, xml: string): void {
		this.locales.registerCustom(lang, xml);
		this.pool.clear();
	}

	unregisterCustomLocale(lang: string): void {
		this.locales.unregisterCustom(lang);
		this.pool.clear();
	}

	/** Drop all folder-registered styles before a re-scan. */
	clearFolderStyles(): void {
		this.styles.clearFolderStyles();
		this.pool.clear();
	}

	/** All locales known locally: bundled en-US, folder-registered, cached. */
	async listLocales(): Promise<LocaleInfo[]> {
		const out: LocaleInfo[] = [{ tag: "en-US", source: "builtin" }];
		const seen = new Set<string>(["en-US"]);
		for (const tag of this.locales.listCustomTags()) {
			if (seen.has(tag)) continue;
			seen.add(tag);
			out.push({ tag, source: "folder" });
		}
		for (const tag of await this.locales.listCached()) {
			if (seen.has(tag)) continue;
			seen.add(tag);
			out.push({ tag, source: "remote-cache" });
		}
		return out.sort((a, b) => a.tag.localeCompare(b.tag));
	}

	/** Download (if needed) and cache a locale. Returns false when unavailable. */
	async ensureLocale(lang: string): Promise<boolean> {
		return this.locales.ensure(lang);
	}

	/** Remove a cached locale (bundled en-US and folder locales are kept). */
	async removeLocale(lang: string): Promise<void> {
		await this.locales.remove(lang);
		this.pool.clear();
	}

	async removeStyle(id: string): Promise<void> {
		await this.styles.remove(id);
		this.pool.clear();
	}

	/**
	 * Known styles (custom + cached), each with its offline availability.
	 * Never touches the network.
	 */
	async listStyles(): Promise<StyleInfo[]> {
		const out: StyleInfo[] = [];
		const seen = new Set<string>();

		for (const key of this.styles.customKeys()) {
			const entry = this.styles.getCustom(key);
			if (!entry) continue;
			seen.add(key);
			out.push({
				id: key,
				title: entry.meta?.title,
				source: entry.source,
				dependent: entry.meta?.dependent,
				parent: entry.meta?.parent,
				defaultLocale: entry.meta?.defaultLocale,
				availability: entry.invalidReason
					? { status: "invalid", reason: entry.invalidReason }
					: await this.resolver.availability(key, { allowNetwork: false }),
			});
		}

		for (const id of await this.styles.listCachedIds()) {
			if (seen.has(id)) continue; // custom overrides remote with same id
			const local = await this.styles.getLocal(id);
			if (!local) continue;
			out.push({
				id,
				title: local.meta?.title,
				source: "remote-cache",
				dependent: local.meta?.dependent,
				parent: local.meta?.parent,
				defaultLocale: local.meta?.defaultLocale,
				availability: local.invalidReason
					? { status: "invalid", reason: local.invalidReason }
					: await this.resolver.availability(id, { allowNetwork: false }),
			});
		}

		return out.sort((a, b) => a.id.localeCompare(b.id));
	}

	async clearCache(): Promise<void> {
		await this.styles.clearCache();
		await this.locales.clearCache();
		await this.store.delete(INDEX_KEY);
		await this.store.delete(INDEX_TS_KEY);
		this.pool.clear();
	}

	/* -------------------------- style index ------------------------------ */

	/**
	 * Search the remote style index (cached for 7 days). Returns [] when the
	 * index cannot be fetched and no cached copy exists.
	 */
	async searchStyleIndex(
		query: string,
		limit = 50
	): Promise<StyleIndexEntry[]> {
		const index = await this.loadStyleIndex();
		const q = query.trim().toLowerCase();
		const matches = q
			? index.filter(
					(e) =>
						e.name.toLowerCase().includes(q) ||
						e.title.toLowerCase().includes(q)
				)
			: index;
		return matches.slice(0, limit);
	}

	private async loadStyleIndex(): Promise<StyleIndexEntry[]> {
		const ts = await this.store.get(INDEX_TS_KEY);
		const cached = await this.store.get(INDEX_KEY);
		const fresh =
			ts !== null && Date.now() - Number(ts) < INDEX_TTL_MS && cached !== null;

		if (!fresh) {
			try {
				const raw = await this.fetcher.fetchText(this.styleIndexUrl);
				const parsed = JSON.parse(raw) as {
					name?: string;
					title?: string;
					dependent?: number | boolean;
				}[];
				const entries: StyleIndexEntry[] = parsed
					.filter((e) => e.name && e.title)
					.map((e) => ({
						name: e.name as string,
						title: e.title as string,
						dependent: !!e.dependent,
					}));
				await this.store.set(INDEX_KEY, JSON.stringify(entries));
				await this.store.set(INDEX_TS_KEY, String(Date.now()));
				return entries;
			} catch {
				// fall through to stale cache if present
			}
		}
		if (cached !== null) {
			try {
				return JSON.parse(cached) as StyleIndexEntry[];
			} catch {
				return [];
			}
		}
		return [];
	}
}
