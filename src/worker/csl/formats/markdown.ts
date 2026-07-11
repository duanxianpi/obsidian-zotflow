import CSL from "citeproc";

/**
 * Custom Markdown output formats for citeproc, modeled on citeproc-java's
 * markdown / markdown-pure formatters (Apache-2.0).
 *
 * - "markdown": italic/bold become * / **; sup, sub and small-caps stay as
 *   inline HTML (Obsidian renders it).
 * - "markdown-pure": inline HTML is dropped entirely; only pure Markdown
 *   remains.
 *
 * text_escape does NOT HTML-escape; it backslash-escapes Markdown special
 * characters in text nodes so titles containing `_`, `*` or `[` don't get
 * mis-rendered.
 */

const MD_SPECIALS = /[\\`*_[\]]/g;

export function escapeMarkdown(text: string): string {
	if (!text) return "";
	return text.replace(MD_SPECIALS, (ch) => "\\" + ch);
}

export function unescapeMarkdown(text: string): string {
	return text.replace(/\\([\\`*_[\]])/g, "$1");
}

type FormatFn = (state: unknown, str: string) => string;

function quotesTrue(state: unknown, str: string): string {
	const s = state as { getTerm(term: string): string };
	if (typeof str === "undefined") return s.getTerm("open-quote");
	return s.getTerm("open-quote") + str + s.getTerm("close-quote");
}

function quotesInner(state: unknown, str: string): string {
	const s = state as { getTerm(term: string): string };
	if (typeof str === "undefined") return "’";
	return s.getTerm("open-inner-quote") + str + s.getTerm("close-inner-quote");
}

function passthrough(): FormatFn {
	const formatters = (
		CSL.Output as unknown as {
			Formatters?: { passthrough?: FormatFn };
		}
	).Formatters;
	return formatters?.passthrough ?? ((_state, str) => str);
}

function buildMarkdownFormat(pure: boolean): Record<string, unknown> {
	return {
		text_escape: (text: string) => escapeMarkdown(text ?? ""),
		bibstart: "",
		bibend: "",
		"@font-style/italic": "*%%STRING%%*",
		"@font-style/oblique": "*%%STRING%%*",
		"@font-style/normal": false,
		"@font-variant/small-caps": pure
			? false
			: '<span style="font-variant:small-caps;">%%STRING%%</span>',
		"@font-variant/normal": false,
		"@passthrough/true": passthrough(),
		"@font-weight/bold": "**%%STRING%%**",
		"@font-weight/normal": false,
		"@font-weight/light": false,
		"@text-decoration/none": false,
		"@text-decoration/underline": pure ? false : "<u>%%STRING%%</u>",
		"@vertical-align/sup": pure ? false : "<sup>%%STRING%%</sup>",
		"@vertical-align/sub": pure ? false : "<sub>%%STRING%%</sub>",
		"@vertical-align/baseline": false,
		"@strip-periods/true": passthrough(),
		"@strip-periods/false": passthrough(),
		"@quotes/true": quotesTrue,
		"@quotes/inner": quotesInner,
		"@quotes/false": false,
		"@cite/entry": function (
			this: { item_id: string; locator_txt: string; suffix_txt: string },
			state: {
				sys: {
					wrapCitationEntry?: (
						str: string,
						id: string,
						loc: string,
						suf: string
					) => string;
				};
			},
			str: string
		) {
			if (!state.sys.wrapCitationEntry) return str;
			return state.sys.wrapCitationEntry(
				str,
				this.item_id,
				this.locator_txt,
				this.suffix_txt
			);
		},
		"@bibliography/entry": (_state: unknown, str: string) => str + "\n",
		"@display/block": (_state: unknown, str: string) => "\n" + str,
		// Flatten numbered styles ("[1]" + entry) into one line.
		"@display/left-margin": (_state: unknown, str: string) => str + " ",
		"@display/right-inline": (_state: unknown, str: string) => str,
		"@display/indent": (_state: unknown, str: string) => "\n" + str,
		"@showid/true": (_state: unknown, str: string) => str,
		"@URL/true": pure
			? (_state: unknown, str: string) => str
			: (_state: unknown, str: string) =>
					`[${str}](${unescapeMarkdown(str)})`,
		"@DOI/true": pure
			? (_state: unknown, str: string) => str
			: (_state: unknown, str: string) => {
					const raw = unescapeMarkdown(str);
					const url = /^https?:\/\//.test(raw)
						? raw
						: `https://doi.org/${raw}`;
					return `[${str}](${url})`;
				},
	};
}

let registered = false;

/** Install "markdown" and "markdown-pure" onto CSL.Output.Formats (idempotent). */
export function registerMarkdownFormats(): void {
	if (registered) return;
	const formats = CSL.Output.Formats as Record<string, unknown>;
	formats["markdown"] = buildMarkdownFormat(false);
	formats["markdown-pure"] = buildMarkdownFormat(true);
	registered = true;
}
