import type { KVStore, ResourceFetcher } from "./ports";
import type { StyleMeta, StyleSource } from "./types";
import { extractStyleMeta, slugFromStyleUri } from "./xml";

const STYLE_PREFIX = "style:"; // cached remote style XML
const STYLE_META_PREFIX = "style-meta:"; // JSON-serialized CachedMeta
const PASTE_PREFIX = "paste:"; // pasted custom style XML (persisted)
const PASTE_META_PREFIX = "paste-meta:";

const MAX_DEPENDENT_DEPTH = 5;

const DEFAULT_STYLE_URL = "https://www.zotero.org/styles/{id}";

interface CachedMeta extends StyleMeta {
	invalidReason?: string;
}

export interface CustomEntry {
	xml: string;
	source: Extract<StyleSource, "folder" | "paste">;
	meta?: StyleMeta;
	invalidReason?: string;
}

export interface LocalStyle {
	xml: string;
	source: StyleSource;
	meta?: StyleMeta;
	invalidReason?: string;
}

/** Successful chain resolution down to an independent style. */
export interface ResolvedChain {
	ok: true;
	independentXml: string;
	independentId: string;
	/** First default-locale declared walking from the leaf towards the parent. */
	defaultLocale?: string;
	/** Slugs visited, leaf first. */
	chain: string[];
}

export interface FailedChain {
	ok: false;
	failure:
		| { status: "missing" }
		| { status: "resolvable" }
		| { status: "unresolved-parent"; parent: string }
		| { status: "invalid"; reason: string };
}

export type ChainResult = ResolvedChain | FailedChain;

/**
 * Style storage and dependent-chain resolution. Custom styles (vault folder,
 * pasted XML) always take precedence over cached remote styles with the same
 * id — that is the point of a user override.
 */
export class StyleRepository {
	private custom = new Map<string, CustomEntry>();
	private styleUrlTemplate = DEFAULT_STYLE_URL;

	constructor(
		private fetcher: ResourceFetcher,
		private store: KVStore
	) {}

	setUrlTemplate(template: string): void {
		this.styleUrlTemplate = template || DEFAULT_STYLE_URL;
	}

	styleUrl(id: string): string {
		return this.styleUrlTemplate.replace("{id}", id);
	}

	/** Load persisted pasted styles into memory. Call once at startup. */
	async init(): Promise<void> {
		for (const key of await this.store.list(PASTE_PREFIX)) {
			const id = key.slice(PASTE_PREFIX.length);
			const xml = await this.store.get(key);
			if (xml === null) continue;
			const metaRaw = await this.store.get(PASTE_META_PREFIX + id);
			const meta = metaRaw
				? (JSON.parse(metaRaw) as CachedMeta)
				: ({} as CachedMeta);
			this.custom.set(id, {
				xml,
				source: "paste",
				meta: meta.invalidReason ? undefined : meta,
				invalidReason: meta.invalidReason,
			});
		}
	}

	/**
	 * Register a custom style under a local key. Invalid XML is still
	 * registered (so panels can surface it as invalid) but flagged.
	 */
	async registerCustom(
		key: string,
		xml: string,
		source: "folder" | "paste"
	): Promise<CustomEntry> {
		let entry: CustomEntry;
		try {
			entry = { xml, source, meta: extractStyleMeta(xml) };
		} catch (e) {
			entry = { xml, source, invalidReason: (e as Error).message };
		}
		this.custom.set(key, entry);
		if (source === "paste") {
			await this.store.set(PASTE_PREFIX + key, xml);
			await this.store.set(
				PASTE_META_PREFIX + key,
				JSON.stringify(
					entry.meta ?? { dependent: false, invalidReason: entry.invalidReason }
				)
			);
		}
		return entry;
	}

	async unregisterCustom(key: string): Promise<void> {
		const entry = this.custom.get(key);
		this.custom.delete(key);
		if (entry?.source === "paste") {
			await this.store.delete(PASTE_PREFIX + key);
			await this.store.delete(PASTE_META_PREFIX + key);
		}
	}

	/** Remove all folder-sourced custom styles (before a folder re-scan). */
	clearFolderStyles(): void {
		for (const [key, entry] of this.custom) {
			if (entry.source === "folder") this.custom.delete(key);
		}
	}

	customKeys(): string[] {
		return [...this.custom.keys()];
	}

	getCustom(key: string): CustomEntry | undefined {
		return this.custom.get(key);
	}

	/** Look up a style locally: custom (folder > paste) first, then remote cache. */
	async getLocal(id: string): Promise<LocalStyle | null> {
		const custom = this.custom.get(id);
		if (custom) return custom;

		const xml = await this.store.get(STYLE_PREFIX + id);
		if (xml === null) return null;
		const metaRaw = await this.store.get(STYLE_META_PREFIX + id);
		const meta = metaRaw
			? (JSON.parse(metaRaw) as CachedMeta)
			: undefined;
		return {
			xml,
			source: "remote-cache",
			meta: meta?.invalidReason ? undefined : meta,
			invalidReason: meta?.invalidReason,
		};
	}

	/** Fetch a style from the remote source and cache it. Throws on failure. */
	async fetchAndCache(id: string): Promise<LocalStyle> {
		const xml = await this.fetcher.fetchText(this.styleUrl(id));
		if (!xml.includes("<style")) {
			throw new Error(`response for style "${id}" does not look like CSL XML`);
		}
		let meta: StyleMeta | undefined;
		let invalidReason: string | undefined;
		try {
			meta = extractStyleMeta(xml);
		} catch (e) {
			invalidReason = (e as Error).message;
		}
		await this.store.set(STYLE_PREFIX + id, xml);
		await this.store.set(
			STYLE_META_PREFIX + id,
			JSON.stringify({ ...(meta ?? { dependent: false }), invalidReason })
		);
		return { xml, source: "remote-cache", meta, invalidReason };
	}

	/** Remove a cached remote or pasted style. Folder styles are files; not removable here. */
	async remove(id: string): Promise<void> {
		const custom = this.custom.get(id);
		if (custom) {
			if (custom.source === "folder") {
				throw new Error(
					`"${id}" comes from the styles folder; delete the file instead`
				);
			}
			await this.unregisterCustom(id);
			return;
		}
		await this.store.delete(STYLE_PREFIX + id);
		await this.store.delete(STYLE_META_PREFIX + id);
	}

	/** Ids of styles cached from the remote source. */
	async listCachedIds(): Promise<string[]> {
		const keys = await this.store.list(STYLE_PREFIX);
		return keys.map((k) => k.slice(STYLE_PREFIX.length));
	}

	async clearCache(): Promise<void> {
		for (const prefix of [STYLE_PREFIX, STYLE_META_PREFIX]) {
			for (const key of await this.store.list(prefix)) {
				await this.store.delete(key);
			}
		}
	}

	/**
	 * Resolve a style down its dependent chain to an independent style.
	 *
	 * `allowNetwork: false` never fetches: a locally-missing parent yields
	 * `resolvable` (it might exist remotely). With `allowNetwork: true` a
	 * fetch failure yields `unresolved-parent`. Cycles and chains deeper than
	 * MAX_DEPENDENT_DEPTH yield `invalid`.
	 */
	async resolveChain(
		id: string,
		opts: { allowNetwork: boolean; xml?: string }
	): Promise<ChainResult> {
		const visited = new Set<string>();
		const chain: string[] = [];
		let defaultLocale: string | undefined;

		let currentId = id;
		let current: LocalStyle | null;

		if (opts.xml !== undefined) {
			let meta: StyleMeta | undefined;
			try {
				meta = extractStyleMeta(opts.xml);
			} catch (e) {
				return {
					ok: false,
					failure: { status: "invalid", reason: (e as Error).message },
				};
			}
			current = { xml: opts.xml, source: "paste", meta };
		} else {
			current = await this.getLocal(currentId);
			if (!current) {
				if (!opts.allowNetwork) {
					return { ok: false, failure: { status: "missing" } };
				}
				try {
					current = await this.fetchAndCache(currentId);
				} catch {
					return { ok: false, failure: { status: "missing" } };
				}
			}
		}

		for (let depth = 0; depth <= MAX_DEPENDENT_DEPTH; depth++) {
			if (current.invalidReason || !current.meta) {
				return {
					ok: false,
					failure: {
						status: "invalid",
						reason: current.invalidReason ?? "missing style metadata",
					},
				};
			}
			chain.push(currentId);
			visited.add(currentId);
			if (defaultLocale === undefined && current.meta.defaultLocale) {
				defaultLocale = current.meta.defaultLocale;
			}

			if (!current.meta.dependent) {
				return {
					ok: true,
					independentXml: current.xml,
					independentId: currentId,
					defaultLocale,
					chain,
				};
			}

			const parent = current.meta.parent
				? slugFromStyleUri(current.meta.parent)
				: undefined;
			if (!parent) {
				return {
					ok: false,
					failure: {
						status: "invalid",
						reason: "dependent style has no independent-parent link",
					},
				};
			}
			if (visited.has(parent)) {
				return {
					ok: false,
					failure: {
						status: "invalid",
						reason: `dependent style chain contains a cycle at "${parent}"`,
					},
				};
			}

			let next = await this.getLocal(parent);
			if (!next) {
				if (!opts.allowNetwork) {
					return { ok: false, failure: { status: "resolvable" } };
				}
				try {
					next = await this.fetchAndCache(parent);
				} catch {
					return {
						ok: false,
						failure: { status: "unresolved-parent", parent },
					};
				}
			}
			currentId = parent;
			current = next;
		}

		return {
			ok: false,
			failure: {
				status: "invalid",
				reason: `dependent style chain exceeds depth ${MAX_DEPENDENT_DEPTH} (possible cycle)`,
			},
		};
	}
}
