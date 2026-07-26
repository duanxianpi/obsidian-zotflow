/**
 * Links.
 *
 * Two Obsidian-compatibility concerns, both about *not* over-escaping:
 * a bare URL must stay bare, and `&` in a destination must stay `&`.
 */

import { visit } from "unist-util-visit";
import { defaultHandlers } from "mdast-util-to-markdown";

import { stringifyAs } from "./types";

import type { Root as HRoot } from "hast";
import type { Link } from "mdast";
import type { SyntaxFeature } from "./types";

export const linkFeature: SyntaxFeature = {
    name: "link",

    stringifyHandlers: () => ({
        /**
         * GFM literal autolinks: a link whose visible text *is* its URL was
         * autolinked from a bare URL the user typed. Re-emit the bare text
         * instead of `<url>` or `[text](url)`, so plain URLs round-trip
         * verbatim — the next parse re-linkifies them identically.
         */
        link: stringifyAs<Link>((node, parent, state, info) => {
            const child = node.children.length === 1 ? node.children[0] : null;
            if (child?.type === "text" && !node.title) {
                const text = child.value;
                const url = node.url;
                const isLiteralAutolink =
                    (text === url && /^https?:\/\//i.test(url)) ||
                    (url === `http://${text}` && /^www\./i.test(text)) ||
                    url === `mailto:${text}`;
                if (isLiteralAutolink) return text;
            }
            return defaultHandlers.link(node, parent, state, info);
        }),
    }),

    /**
     * `mdast-util-to-markdown` defensively escapes `&` in link and image
     * destinations (`\&`) to rule out ambiguity with character references.
     * Obsidian does not unescape backslash sequences when resolving a clicked
     * URL, so every destination containing `&` breaks. A raw `&` is perfectly
     * valid CommonMark there — only parentheses and whitespace are structural
     * — so the escape is stripped.
     *
     * String-level because the escape happens inside the serializer's `safe()`
     * pass, which no handler can reach. Confined to `](…)` destinations; a
     * `\&` in prose is left alone.
     */
    postSerializeMd(md: string): string {
        if (!md.includes("\\&")) return md;
        // NB: the destination alternatives must stay disjoint (backslash
        // excluded from the character class) — an ambiguous `(?:\\.|[^()\s])+`
        // backtracks exponentially on `](` followed by a run of backslashes
        // with no closing paren.
        return md.replace(
            /\]\(((?:[^()\s\\]|\\.)+)\)/g,
            (match: string, dest: string) =>
                dest.includes("\\&")
                    ? `](${dest.replace(/\\&/g, "&")})`
                    : match,
        );
    },

    /** `rel` is noise Zotero neither stores nor needs. */
    transformHast(tree: HRoot) {
        visit(tree, "element", (node) => {
            if (node.tagName !== "a") return;
            delete node.properties.rel;
        });
    },
};
