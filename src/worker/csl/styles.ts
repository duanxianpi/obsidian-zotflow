import type { KVStore, ResourceFetcher } from "./ports";
import type { RemoteMeta, StyleMeta, StyleSource } from "./types";
import { extractStyleMeta, slugFromStyleUri } from "./xml";

const STYLE_PREFIX = "style:"; // cached remote style XML
const STYLE_META_PREFIX = "style-meta:"; // JSON-serialized CachedMeta

const MAX_DEPENDENT_DEPTH = 5;

const DEFAULT_STYLE_URL = "https://www.zotero.org/styles/{id}";

/**
 * Update refetches must not be answered by the HTTP disk cache (Electron's
 * net stack honors Cache-Control, so an offline "update" would silently
 * report the cached copy as up to date). A throwaway query param forces a
 * real network hit; the clean URL is what gets recorded as provenance.
 */
export function bustCache(url: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}zfbust=${Date.now()}`;
}

interface CachedMeta extends StyleMeta {
	invalidReason?: string;
	remote?: RemoteMeta;
	/** True when installed directly by the user (vs pulled in as a parent). */
	explicit?: boolean;
}

export interface CustomEntry {
	xml: string;
	source: Extract<StyleSource, "folder">;
	meta?: StyleMeta;
	invalidReason?: string;
}

export interface LocalStyle {
	xml: string;
	source: StyleSource;
	meta?: StyleMeta;
	invalidReason?: string;
	remote?: RemoteMeta;
	/** True when installed directly by the user (remote-cache styles only). */
	explicit?: boolean;
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

/** Per-member outcome of a chain update (see updateChain). */
export interface ChainUpdateResult {
	updated: string[];
	unchanged: string[];
	failed: { id: string; reason: string }[];
}

/**
 * Style storage and dependent-chain resolution. Custom styles (vault folder)
 * always take precedence over cached remote styles with the same id — that
 * is the point of a user override.
 */
export class StyleRepository {
	private custom = new Map<string, CustomEntry>();
	private styleUrlTemplate: string;

	constructor(
		private fetcher: ResourceFetcher,
		private store: KVStore,
		styleUrlTemplate?: string
	) {
		this.styleUrlTemplate = styleUrlTemplate || DEFAULT_STYLE_URL;
	}

	styleUrl(id: string): string {
		return this.styleUrlTemplate.replace("{id}", id);
	}

	/**
	 * Register a folder style under a local key. Invalid XML is still
	 * registered (so panels can surface it as invalid) but flagged.
	 */
	registerCustom(key: string, xml: string): CustomEntry {
		let entry: CustomEntry;
		try {
			entry = { xml, source: "folder", meta: extractStyleMeta(xml) };
		} catch (e) {
			entry = { xml, source: "folder", invalidReason: (e as Error).message };
		}
		this.custom.set(key, entry);
		return entry;
	}

	unregisterCustom(key: string): void {
		this.custom.delete(key);
	}

	/** Remove all folder-sourced custom styles (before a folder re-scan). */
	clearFolderStyles(): void {
		this.custom.clear();
	}

	customKeys(): string[] {
		return [...this.custom.keys()];
	}

	getCustom(key: string): CustomEntry | undefined {
		return this.custom.get(key);
	}

	/** Look up a style locally: folder styles first, then remote cache. */
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
			remote: meta?.remote,
			explicit: meta?.explicit,
		};
	}

	/**
	 * Fetch a style and cache it together with its provenance. `sourceUrl`
	 * defaults to the standard zotero.org location for the slug. Throws on
	 * failure. Dependency-driven fetches are implicit (explicit: false).
	 * `fresh` bypasses the HTTP cache (update refetches).
	 */
	async fetchAndCache(
		id: string,
		sourceUrl?: string,
		opts?: { fresh?: boolean }
	): Promise<LocalStyle> {
		const url = sourceUrl ?? this.styleUrl(id);
		const xml = await this.fetcher.fetchText(
			opts?.fresh ? bustCache(url) : url
		);
		if (!xml.includes("<style")) {
			throw new Error(`response for style "${id}" does not look like CSL XML`);
		}
		return this.cacheFetched(id, url, xml);
	}

	/**
	 * Persist an already-fetched style. `explicit` marks a direct user
	 * install and is sticky: once a style is explicit, refetching it as a
	 * dependency or during an update never demotes it back to implicit.
	 */
	async cacheFetched(
		id: string,
		sourceUrl: string,
		xml: string,
		opts?: { explicit?: boolean }
	): Promise<LocalStyle> {
		let meta: StyleMeta | undefined;
		let invalidReason: string | undefined;
		try {
			meta = extractStyleMeta(xml);
		} catch (e) {
			invalidReason = (e as Error).message;
		}
		const prevRaw = await this.store.get(STYLE_META_PREFIX + id);
		const prev = prevRaw ? (JSON.parse(prevRaw) as CachedMeta) : undefined;
		const explicit = opts?.explicit === true || prev?.explicit === true;
		const remote: RemoteMeta = { sourceUrl, fetchedAt: Date.now() };
		await this.store.set(STYLE_PREFIX + id, xml);
		await this.store.set(
			STYLE_META_PREFIX + id,
			JSON.stringify({
				...(meta ?? { dependent: false }),
				invalidReason,
				remote,
				explicit,
			})
		);
		return {
			xml,
			source: "remote-cache",
			meta,
			invalidReason,
			remote,
			explicit,
		};
	}

	/**
	 * Installed styles (folder + cached) whose independent-parent link points
	 * at `parent`. Used for ref-counted cleanup: an implicit parent is only
	 * removed when nothing depends on it anymore.
	 */
	async dependentsOf(parent: string): Promise<string[]> {
		const out: string[] = [];
		for (const [key, entry] of this.custom) {
			if (entry.meta?.dependent && entry.meta.parent === parent) {
				out.push(key);
			}
		}
		for (const key of await this.store.list(STYLE_META_PREFIX)) {
			const raw = await this.store.get(key);
			if (raw === null) continue;
			const meta = JSON.parse(raw) as CachedMeta;
			if (meta.dependent && meta.parent === parent) {
				out.push(key.slice(STYLE_META_PREFIX.length));
			}
		}
		return out;
	}

	/** Remove a cached remote style. Folder styles are files; not removable here. */
	async remove(id: string): Promise<void> {
		if (this.custom.has(id)) {
			throw new Error(
				`"${id}" comes from the styles folder; delete the file instead`
			);
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
			// Source label is irrelevant here: this entry never leaves resolveChain.
			current = { xml: opts.xml, source: "folder", meta };
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

	/**
	 * Refetch a style and every member of its dependent chain from their
	 * recorded source URLs. Folder chain members are skipped — they are
	 * user-owned files — but the walk continues through them. A member
	 * that fails to refetch keeps its cached copy and the walk continues
	 * along that copy's parent link.
	 *
	 * A shared `visited` set can be passed so update-all refetches a parent
	 * shared by many aliases only once.
	 */
	async updateChain(
		id: string,
		visited: Set<string> = new Set()
	): Promise<ChainUpdateResult> {
		const result: ChainUpdateResult = {
			updated: [],
			unchanged: [],
			failed: [],
		};
		let currentId = id;

		for (let depth = 0; depth <= MAX_DEPENDENT_DEPTH; depth++) {
			if (visited.has(currentId)) break; // cycle — availability reports it
			visited.add(currentId);

			let entry = await this.getLocal(currentId);

			if (!entry || entry.source === "remote-cache") {
				const url = entry?.remote?.sourceUrl ?? this.styleUrl(currentId);
				try {
					const old = entry?.xml;
					entry = await this.fetchAndCache(currentId, url, {
						fresh: true,
					});
					(entry.xml === old ? result.unchanged : result.updated).push(
						currentId
					);
				} catch (e) {
					result.failed.push({
						id: currentId,
						reason: (e as Error).message,
					});
					if (!entry) return result; // nothing cached to walk through
				}
			}
			// folder styles: leave untouched, but still follow their parent

			const parent =
				entry.meta?.dependent && entry.meta.parent
					? slugFromStyleUri(entry.meta.parent)
					: undefined;
			if (!parent) break;
			currentId = parent;
		}

		return result;
	}
}
