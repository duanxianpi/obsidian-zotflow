/**
 * Public core types for csl-render-core.
 *
 * A CSL-JSON item. `id` and `type` are the only required fields; everything
 * else is a standard CSL variable (`title`, `author`, `issued`, ...).
 */
export type CSLItem = { id: string; type: string; [k: string]: unknown };

export type OutputFormat = "text" | "html" | "markdown" | "markdown-pure";

export interface RenderOptions {
	/** Style id (slug like "apa" or a zotero.org/styles URL). Mutually exclusive with styleXml. */
	styleId?: string;
	/** Raw CSL style XML (custom style). Takes precedence over styleId when both are given. */
	styleXml?: string;
	/** BCP-47 locale, e.g. "en-US", "de-DE", "zh-CN". Defaults to the service default ("en-US"). */
	locale?: string;
	/** Output format. Defaults to "text". */
	format?: OutputFormat;
	/**
	 * HTML only: "keep" (default) preserves the csl-bib-body/csl-entry wrappers,
	 * "strip" removes them and flattens csl-left-margin/csl-right-inline into
	 * "[1] entry" for numbered styles.
	 */
	htmlContainer?: "keep" | "strip";
}

/** Extra per-cite properties accepted by BibliographyContext.addCitation. */
export interface CiteProps {
	/** Locator value, e.g. a page number. */
	locator?: string;
	/** Locator label, e.g. "page", "chapter". */
	label?: string;
	prefix?: string;
	suffix?: string;
	suppressAuthor?: boolean;
	/** Footnote number for note styles; 0 (default) means in-text. */
	noteIndex?: number;
}

/**
 * Availability of a style is not a boolean: it is whether the whole dependency
 * chain (style -> independent parent -> locale) is closed.
 */
export type Availability =
	| { status: "ready" }
	| { status: "resolvable" }
	| { status: "unresolved-parent"; parent: string }
	| { status: "unresolved-locale"; locale: string }
	| { status: "missing" }
	| { status: "invalid"; reason: string };

export type StyleSource = "builtin" | "remote-cache" | "folder" | "paste";

export interface StyleInfo {
	/** Local key: remote styles use the slug, folder styles the file basename. */
	id: string;
	title?: string;
	source: StyleSource;
	dependent?: boolean;
	/** For dependent styles, the slug of the independent parent. */
	parent?: string;
	/** default-locale declared by the style (or its dependent override), if any. */
	defaultLocale?: string;
	availability: Availability;
}

/** Parsed metadata extracted from a style's <info> section. */
export interface StyleMeta {
	title?: string;
	/** The style's own declared id URI (info > id), if present. */
	selfUri?: string;
	dependent: boolean;
	/** Slug of the independent parent (dependent styles only). */
	parent?: string;
	/** default-locale attribute on <style>, if any. */
	defaultLocale?: string;
}
