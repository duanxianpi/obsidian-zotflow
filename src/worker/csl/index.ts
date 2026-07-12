/**
 * Public barrel of the vendored csl-render core (platform agnostic, zero
 * Obsidian imports). Vendored from the standalone csl-render project; files
 * inside this folder intentionally use relative imports so the unit stays
 * portable.
 */

export { CslRenderService } from "./api";
export type { CslRenderServiceConfig, LocaleInfo, UpdateStatus } from "./api";
export type { BibliographyContext } from "./context";
export { UnavailableStyleError, describeAvailability } from "./errors";
export { normalizeLocale } from "./locales";
export { MemoryKVStore } from "./ports";
export type { KVStore, ResourceFetcher } from "./ports";
export type {
	Availability,
	CiteProps,
	CSLItem,
	LocalePreview,
	OutputFormat,
	RemoteMeta,
	RenderOptions,
	StyleInfo,
	StyleMeta,
	StylePreview,
	StyleSample,
	StyleSource,
	StyleUpdateReport,
	UpdateAllReport,
} from "./types";
export { extractStyleMeta, slugFromStyleUri } from "./xml";
