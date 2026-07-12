import CSL from "citeproc";
import type { XmlJsonNode } from "citeproc";
import type { StyleMeta } from "./types";

/**
 * Style introspection built on citeproc's own pure-JS XML parser
 * (CSL.parseXml), so core stays platform agnostic — no DOMParser needed.
 */

export function parseStyleXml(xml: string): XmlJsonNode {
	const tree = CSL.parseXml(xml);
	if (!tree || typeof tree !== "object" || !("name" in tree)) {
		throw new Error("not well-formed XML");
	}
	return tree;
}

function childElements(node: XmlJsonNode, name?: string): XmlJsonNode[] {
	const out: XmlJsonNode[] = [];
	for (const c of node.children ?? []) {
		if (typeof c === "string") continue;
		if (!name || c.name === name) out.push(c);
	}
	return out;
}

function textOf(node: XmlJsonNode | undefined): string | undefined {
	if (!node) return undefined;
	const parts = (node.children ?? []).filter(
		(c): c is string => typeof c === "string"
	);
	const s = parts.join("").trim();
	return s.length ? s : undefined;
}

/** Extract the style slug from a zotero.org/styles style URI, else return the input. */
export function slugFromStyleUri(uri: string): string {
	// Query/fragment never belong in a slug (zotero.org pages link styles
	// with tracking params like "?source=1").
	const cleaned = uri.split(/[?#]/)[0] as string;
	const m = cleaned.match(/\/styles\/([^/]+)\/?$/);
	if (m && m[1]) return m[1];
	// Not a styles URL — take the last path segment if it looks like a URL.
	if (/^https?:\/\//.test(cleaned)) {
		const seg = cleaned.replace(/\/+$/, "").split("/").pop();
		if (seg) return seg;
	}
	return cleaned;
}

/**
 * Parse a CSL style and extract the metadata needed for dependency resolution.
 * Throws if the XML is not well-formed or is not a CSL <style> document.
 */
export function extractStyleMeta(xml: string): StyleMeta {
	const root = parseStyleXml(xml);
	if (root.name !== "style") {
		throw new Error(`root element is <${root.name}>, expected <style>`);
	}

	const info = childElements(root, "info")[0];
	const title = info ? textOf(childElements(info, "title")[0]) : undefined;
	const selfUri = info ? textOf(childElements(info, "id")[0]) : undefined;

	let parentUri: string | undefined;
	let citationFormat: string | undefined;
	if (info) {
		for (const link of childElements(info, "link")) {
			if (link.attrs?.["rel"] === "independent-parent" && link.attrs["href"]) {
				parentUri = link.attrs["href"];
				break;
			}
		}
		for (const category of childElements(info, "category")) {
			if (category.attrs?.["citation-format"]) {
				citationFormat = category.attrs["citation-format"];
				break;
			}
		}
	}

	// A style is dependent when it points at an independent parent and has no
	// <citation> element of its own.
	const hasCitation = childElements(root, "citation").length > 0;
	const dependent = !!parentUri && !hasCitation;

	if (!dependent && !hasCitation) {
		throw new Error("style has neither <citation> nor an independent-parent link");
	}

	return {
		title,
		selfUri,
		dependent,
		parent: dependent && parentUri ? slugFromStyleUri(parentUri) : undefined,
		defaultLocale: root.attrs?.["default-locale"] || undefined,
		citationFormat,
		// <bibliography> is optional by spec: note-only styles omit it on
		// purpose. Checked directly — never inferred from citation-format.
		// Meaningless for dependent styles (inherited from the parent).
		hasBibliography: dependent
			? undefined
			: childElements(root, "bibliography").length > 0,
	};
}
