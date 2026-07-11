import type { Citation, CitationItem } from "citeproc";
import {
	EngineHost,
	renderBibliographyEntries,
	type ResolvedResources,
} from "./engine";
import type { CiteProps, CSLItem, OutputFormat } from "./types";

/**
 * citeproc engines are stateful: registered items, citation clusters and —
 * crucially — disambiguation all live on the engine. Two documents whose
 * authors overlap must therefore never share one engine's registry. Each
 * BibliographyContext owns an engine exclusively while active; idle engines
 * are kept in an LRU pool because building one (XML parse) is expensive.
 */

export interface BibliographyContext {
	/** Make items known/cited in this context (citeproc updateItems). */
	registerItems(items: CSLItem[]): void;
	/**
	 * Append a citation cluster and return its rendered form.
	 * Items must have been registered (or are auto-registered if passed as objects).
	 */
	addCitation(itemIds: string[], props?: CiteProps): string;
	/** Full bibliography for everything registered in this context. */
	makeBibliography(): string[];
	/** Clear all context state and start over. */
	rebuild(): void;
	/** Return the engine to the pool. The context is unusable afterwards. */
	dispose(): void;
}

export class EnginePool {
	private idle = new Map<string, EngineHost[]>();
	private order: string[] = []; // LRU order of keys, most recent last
	private size = 0;

	constructor(private maxIdle = 6) {}

	acquire(resolved: ResolvedResources): EngineHost {
		const bucket = this.idle.get(resolved.engineKey);
		const host = bucket?.pop();
		if (host) {
			if (bucket && bucket.length === 0) this.idle.delete(resolved.engineKey);
			this.size--;
			host.reset();
			return host;
		}
		return new EngineHost(resolved);
	}

	release(host: EngineHost): void {
		host.reset();
		let bucket = this.idle.get(host.key);
		if (!bucket) {
			bucket = [];
			this.idle.set(host.key, bucket);
		}
		bucket.push(host);
		this.size++;
		// LRU: refresh key position, then evict the oldest key if over capacity.
		const idx = this.order.indexOf(host.key);
		if (idx !== -1) this.order.splice(idx, 1);
		this.order.push(host.key);
		while (this.size > this.maxIdle && this.order.length > 0) {
			const oldest = this.order[0] as string;
			const oldBucket = this.idle.get(oldest);
			if (oldBucket && oldBucket.length > 0) {
				oldBucket.shift();
				this.size--;
				if (oldBucket.length === 0) {
					this.idle.delete(oldest);
					this.order.shift();
				}
			} else {
				this.idle.delete(oldest);
				this.order.shift();
			}
		}
	}

	/** Drop all idle engines (e.g. after cache clear or style update). */
	clear(): void {
		this.idle.clear();
		this.order = [];
		this.size = 0;
	}
}

interface ContextRenderOptions {
	format: OutputFormat;
	htmlContainer: "keep" | "strip";
}

let clusterCounter = 0;

export class BibliographyContextImpl implements BibliographyContext {
	private host: EngineHost | null;
	private citations: [string, number][] = []; // [citationID, noteIndex]

	constructor(
		host: EngineHost,
		private pool: EnginePool,
		private opts: ContextRenderOptions
	) {
		this.host = host;
		host.setFormat(opts.format);
	}

	private requireHost(): EngineHost {
		if (!this.host) {
			throw new Error("csl-render: context has been disposed");
		}
		return this.host;
	}

	registerItems(items: CSLItem[]): void {
		const host = this.requireHost();
		host.addItems(items);
		// Registered-but-not-cited items must still appear in the bibliography
		// and take part in disambiguation; cited status is owned by
		// processCitationCluster, so register them as "uncited" here.
		host.engine.updateUncitedItems(host.registeredIds());
	}

	addCitation(itemIds: string[], props?: CiteProps): string {
		const host = this.requireHost();
		const noteIndex = props?.noteIndex ?? 0;
		const citationItems: CitationItem[] = itemIds.map((id) => {
			const ci: CitationItem = { id };
			if (props?.locator !== undefined) ci.locator = props.locator;
			if (props?.label !== undefined) ci.label = props.label;
			if (props?.prefix !== undefined) ci.prefix = props.prefix;
			if (props?.suffix !== undefined) ci.suffix = props.suffix;
			if (props?.suppressAuthor) ci["suppress-author"] = true;
			return ci;
		});
		const citationID = `csl-render-cluster-${++clusterCounter}`;
		const citation: Citation = {
			citationID,
			citationItems,
			properties: { noteIndex },
		};

		const [, updates] = host.engine.processCitationCluster(
			citation,
			this.citations,
			[]
		);
		this.citations.push([citationID, noteIndex]);

		// processCitationCluster returns every cluster whose rendering changed;
		// ours is the one with the matching id (last position).
		let rendered = "";
		for (const [, text, id] of updates) {
			if (id === citationID) rendered = text;
		}
		return rendered.trim();
	}

	makeBibliography(): string[] {
		const host = this.requireHost();
		return renderBibliographyEntries(host, this.opts);
	}

	rebuild(): void {
		const host = this.requireHost();
		host.reset();
		host.setFormat(this.opts.format);
		this.citations = [];
	}

	dispose(): void {
		if (!this.host) return;
		const host = this.host;
		this.host = null;
		this.citations = [];
		this.pool.release(host);
	}
}
