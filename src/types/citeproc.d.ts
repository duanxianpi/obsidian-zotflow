declare module "citeproc" {
	export interface CiteprocSys {
		retrieveItem(id: string): Record<string, unknown>;
		retrieveLocale(lang: string): string;
		wrapCitationEntry?(
			str: string,
			itemId: string,
			locatorTxt: string,
			suffixTxt: string
		): string;
		embedBibliographyEntry?(itemId: string): string;
		variableWrapper?(
			params: unknown,
			prePunct: string,
			str: string,
			postPunct: string
		): string;
	}

	export interface BibliographyMeta {
		maxoffset: number;
		entryspacing: number;
		linespacing: number;
		hangingindent: boolean;
		"second-field-align": false | "flush" | "margin";
		bibstart: string;
		bibend: string;
		bibliography_errors: unknown[];
		entry_ids: string[][];
	}

	export interface CitationItem {
		id: string;
		locator?: string;
		label?: string;
		prefix?: string;
		suffix?: string;
		"suppress-author"?: boolean;
		"author-only"?: boolean;
	}

	export interface Citation {
		citationID?: string;
		citationItems: CitationItem[];
		properties: { noteIndex: number };
	}

	export class Engine {
		constructor(
			sys: CiteprocSys,
			style: string | object,
			lang?: string,
			forceLang?: boolean
		);
		opt: {
			mode: string;
			[k: string]: unknown;
		};
		updateItems(ids: string[]): void;
		updateUncitedItems(ids: string[]): void;
		makeBibliography(): [BibliographyMeta, string[]] | false;
		makeCitationCluster(items: (CitationItem | string)[]): string;
		processCitationCluster(
			citation: Citation,
			citationsPre: [string, number][],
			citationsPost: [string, number][]
		): [{ bibchange: boolean; citation_errors: unknown[] }, [number, string, string][]];
		previewCitationCluster(
			citation: Citation,
			citationsPre: [string, number][],
			citationsPost: [string, number][],
			format: string
		): string;
		restoreProcessorState(citations?: Citation[]): void;
		setOutputFormat(mode: string): void;
	}

	export interface XmlJsonNode {
		name: string;
		attrs: Record<string, string>;
		children: (XmlJsonNode | string)[];
	}

	export function parseXml(xml: string): XmlJsonNode;

	export const Output: {
		Formats: Record<string, Record<string, unknown>>;
	};

	export const LANG_BASES: Record<string, string>;
	export const LANGS: Record<string, boolean>;

	const CSL: {
		Engine: typeof Engine;
		parseXml: typeof parseXml;
		Output: {
			Formats: Record<string, Record<string, unknown>>;
		};
		Output_Formatters: unknown;
		LANG_BASES: Record<string, string>;
		LANGS: Record<string, boolean>;
	};
	export default CSL;
}
