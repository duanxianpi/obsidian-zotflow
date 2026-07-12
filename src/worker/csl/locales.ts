import CSL from "citeproc";
import { LOCALE_EN_US } from "./assets/locale-en-US";
import { bustCache } from "./styles";
import type { KVStore, ResourceFetcher } from "./ports";
import type { RemoteMeta } from "./types";

const KEY_PREFIX = "locale:";
const META_PREFIX = "locale-meta:"; // JSON-serialized RemoteMeta

/**
 * Normalize a requested language tag to the canonical locale file name used by
 * the CSL locales repository ("de" -> "de-DE", "en" -> "en-US", ...).
 */
export function normalizeLocale(lang: string): string {
	const trimmed = lang.trim().replace(/_/g, "-");
	if (!trimmed) return "en-US";
	const parts = trimmed.split("-");
	const base = (parts[0] as string).toLowerCase();
	if (parts.length >= 2) {
		return `${base}-${(parts[1] as string).toUpperCase()}`;
	}
	const mapped = CSL.LANG_BASES[base];
	if (mapped) return mapped.replace(/_/g, "-");
	return trimmed;
}

export interface LocaleSourceConfig {
	/**
	 * URL template for fetching locales; `{lang}` is replaced with the
	 * normalized tag. Default: raw.githubusercontent.com CSL locales repo.
	 */
	localeUrlTemplate?: string;
}

const DEFAULT_LOCALE_URL =
	"https://raw.githubusercontent.com/citation-style-language/locales/master/locales-{lang}.xml";

/**
 * Locale registry: bundled en-US, custom-registered locales (from the vault
 * folder), a persistent KV cache, and a remote fetch fallback — in that order.
 */
export class LocaleStore {
	private memory = new Map<string, string>();
	private custom = new Map<string, string>();
	private urlTemplate: string;
	private enUsOverrideChecked = false;

	constructor(
		private fetcher: ResourceFetcher,
		private store: KVStore,
		config?: LocaleSourceConfig
	) {
		this.urlTemplate = config?.localeUrlTemplate ?? DEFAULT_LOCALE_URL;
		this.memory.set("en-US", LOCALE_EN_US);
	}

	/**
	 * The bundled en-US is seeded into memory synchronously, but the user
	 * may have updated it — the KV copy then overrides the bundled asset.
	 * Loaded lazily on the first ensure()/update() of a session, which
	 * always happens before any engine's synchronous getSync() lookup.
	 */
	private async loadEnUsOverride(): Promise<void> {
		if (this.enUsOverrideChecked) return;
		this.enUsOverrideChecked = true;
		const cached = await this.store.get(KEY_PREFIX + "en-US");
		if (cached !== null) this.memory.set("en-US", cached);
	}

	localeUrl(lang: string): string {
		return this.urlTemplate.replace("{lang}", normalizeLocale(lang));
	}

	/** Register a locale XML provided by the platform (e.g. vault folder). */
	registerCustom(lang: string, xml: string): void {
		this.custom.set(normalizeLocale(lang), xml);
	}

	unregisterCustom(lang: string): void {
		this.custom.delete(normalizeLocale(lang));
	}

	/** Synchronous lookup of already-loaded locales (for CSL.Engine's sys). */
	getSync(lang: string): string | null {
		const norm = normalizeLocale(lang);
		return this.custom.get(norm) ?? this.memory.get(norm) ?? null;
	}

	/** Is this locale available without touching the network? */
	async hasOffline(lang: string): Promise<boolean> {
		const norm = normalizeLocale(lang);
		if (norm === "en-US" || this.custom.has(norm) || this.memory.has(norm)) {
			return true;
		}
		return (await this.store.get(KEY_PREFIX + norm)) !== null;
	}

	/** Persist a fetched locale together with its provenance. */
	async cacheFetched(
		norm: string,
		sourceUrl: string,
		xml: string
	): Promise<void> {
		this.memory.set(norm, xml);
		await this.store.set(KEY_PREFIX + norm, xml);
		const meta: RemoteMeta = { sourceUrl, fetchedAt: Date.now() };
		await this.store.set(META_PREFIX + norm, JSON.stringify(meta));
	}

	/**
	 * Ensure the locale is loaded into memory: custom > memory > KV cache >
	 * network. Returns true on success, false if it cannot be obtained.
	 */
	async ensure(lang: string): Promise<boolean> {
		await this.loadEnUsOverride();
		const norm = normalizeLocale(lang);
		if (this.custom.has(norm) || this.memory.has(norm)) return true;

		const cached = await this.store.get(KEY_PREFIX + norm);
		if (cached !== null) {
			this.memory.set(norm, cached);
			return true;
		}

		try {
			const url = this.localeUrl(norm);
			const xml = await this.fetcher.fetchText(url);
			// Reject obviously-wrong payloads (error pages, empty bodies).
			if (!xml.includes("<locale")) return false;
			await this.cacheFetched(norm, url, xml);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Refetch a cached locale from its recorded source URL. Returns whether
	 * the content changed. Throws when the refetch fails (the cached copy is
	 * kept) or when the locale is not a downloaded one. The bundled en-US
	 * is updatable: the fetched copy overlays the bundled asset.
	 */
	async update(lang: string): Promise<{ updated: boolean }> {
		await this.loadEnUsOverride();
		const norm = normalizeLocale(lang);
		const old =
			(await this.store.get(KEY_PREFIX + norm)) ??
			(norm === "en-US" ? (this.memory.get("en-US") ?? null) : null);
		if (old === null) {
			throw new Error(`locale "${norm}" is not a downloaded locale`);
		}
		const meta = await this.getMeta(norm);
		const url = meta?.sourceUrl ?? this.localeUrl(norm);
		// Bypass the HTTP disk cache: an offline "update" answered from the
		// cache would falsely report the locale as up to date.
		const xml = await this.fetcher.fetchText(bustCache(url));
		if (!xml.includes("<locale")) {
			throw new Error(`response for locale "${norm}" does not look like locale XML`);
		}
		await this.cacheFetched(norm, url, xml);
		return { updated: xml !== old };
	}

	/** Provenance of a downloaded locale, if recorded. */
	async getMeta(lang: string): Promise<RemoteMeta | null> {
		const raw = await this.store.get(META_PREFIX + normalizeLocale(lang));
		if (raw === null) return null;
		try {
			return JSON.parse(raw) as RemoteMeta;
		} catch {
			return null;
		}
	}

	/** Locales cached in the KV store (normalized tags). */
	async listCached(): Promise<string[]> {
		const keys = await this.store.list(KEY_PREFIX);
		return keys.map((k) => k.slice(KEY_PREFIX.length));
	}

	/** Locales registered by the platform (vault folder), normalized tags. */
	listCustomTags(): string[] {
		return [...this.custom.keys()];
	}

	/** Remove a cached locale. The bundled en-US cannot be removed. */
	async remove(lang: string): Promise<void> {
		const norm = normalizeLocale(lang);
		if (norm === "en-US") return;
		await this.store.delete(KEY_PREFIX + norm);
		await this.store.delete(META_PREFIX + norm);
		this.memory.delete(norm);
	}

	async clearCache(): Promise<void> {
		for (const prefix of [KEY_PREFIX, META_PREFIX]) {
			for (const key of await this.store.list(prefix)) {
				await this.store.delete(key);
			}
		}
		this.memory.clear();
		this.memory.set("en-US", LOCALE_EN_US);
	}
}
