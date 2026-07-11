/**
 * Injection points that keep core/ platform agnostic. The Obsidian shell
 * implements these with requestUrl and IndexedDB; tests use in-memory stubs.
 */

export interface ResourceFetcher {
	/** Fetch a text resource. Must reject on network error or non-2xx status. */
	fetchText(url: string): Promise<string>;
}

export interface KVStore {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	/** List all keys starting with the given prefix. */
	list(prefix: string): Promise<string[]>;
	delete(key: string): Promise<void>;
}

/** Simple in-memory KVStore, used by tests and as a fallback. */
export class MemoryKVStore implements KVStore {
	private map = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.map.has(key) ? (this.map.get(key) as string) : null;
	}

	async set(key: string, value: string): Promise<void> {
		this.map.set(key, value);
	}

	async list(prefix: string): Promise<string[]> {
		return [...this.map.keys()].filter((k) => k.startsWith(prefix));
	}

	async delete(key: string): Promise<void> {
		this.map.delete(key);
	}
}
