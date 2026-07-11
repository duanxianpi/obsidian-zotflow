import CSL from "citeproc";
import { LOCALE_EN_US } from "./assets/locale-en-US";
import type { KVStore, ResourceFetcher } from "./ports";

const KEY_PREFIX = "locale:";

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
 * folder), a persistent KV cache, and a remote fetch fallback â€” in that order.
 */
export class LocaleStore {
	private memory = new Map<string, string>();
	private custom = new Map<string, string>();
	private urlTemplate: string;

	constructor(
		private fetcher: ResourceFetcher,
		private store: KVStore,
		config?: LocaleSourceConfig
	) {
		this.urlTemplate = config?.localeUrlTemplate ?? DEFAULT_LOCALE_URL;
		this.memory.set("en-US", LOCALE_EN_US);
	}

	setUrlTemplate(template: string): void {
		this.urlTemplate = template || DEFAULT_LOCALE_URL;
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

	/**
	 * Ensure the locale is loaded into memory: custom > memory > KV cache >
	 * network. Returns true on success, false if it cannot be obtained.
	 */
	async ensure(lang: string): Promise<boolean> {
		const norm = normalizeLocale(lang);
		if (this.custom.has(norm) || this.memory.has(norm)) return true;

		const cached = await this.store.get(KEY_PREFIX + norm);
		if (cached !== null) {
			this.memory.set(norm, cached);
			return true;
		}

		try {
			const xml = await this.fetcher.fetchText(
				this.urlTemplate.replace("{lang}", norm)
			);
			// Reject obviously-wrong payloads (error pages, empty bodies).
			if (!xml.includes("<locale")) return false;
			this.memory.set(norm, xml);
			await this.store.set(KEY_PREFIX + norm, xml);
			return true;
		} catch {
			return false;
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
		this.memory.delete(norm);
	}

	async clearCache(): Promise<void> {
		for (const key of await this.store.list(KEY_PREFIX)) {
			await this.store.delete(key);
		}
		this.memory.clear();
		this.memory.set("en-US", LOCALE_EN_US);
	}
}
