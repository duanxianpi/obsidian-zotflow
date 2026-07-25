/**
 * Obsidian-only syntax — wikilinks, embeds, footnote markers.
 *
 * | syntax          | strategy | note                                     |
 * | --------------- | -------- | ---------------------------------------- |
 * | `[[Note]]`      | preserve | plain text to Zotero, verbatim both ways |
 * | `[[A\|B]]`      | preserve | ditto                                    |
 * | `[^1]`, `[^1]:` | preserve | GFM footnotes are deliberately off       |
 * | `![[file]]`     | degrade  | expanded to `![](file)`; does not return |
 *
 * The preserved forms need protecting in only one direction:
 * `mdast-util-to-markdown` escapes `[` and `!` in text nodes so they cannot
 * be re-read as link/image syntax, which would turn `[[Note]]` into
 * `\[\[Note]]`. Wrapping them in an `obsidianRaw` node bypasses that escape
 * pass — and, unlike the bare `html` node this replaced, says why.
 */

import { visit, SKIP } from "unist-util-visit";

import { obsidianRaw } from "../model/nodes";
import { stringifyAs } from "./types";

import type { PhrasingContent, Root as MRoot } from "mdast";
import type { ObsidianRaw } from "../model/nodes";
import type { SyntaxFeature } from "./types";

/**
 * `[[wikilink]]`, `[[target|alias]]`, and `[^footnote]`.
 *
 * Adjacent newlines are folded into the match because a trailing `\n` in a
 * text node followed by a raw node is normalized to a single space by
 * `mdast-util-to-markdown`'s `safe()` pass.
 */
const OBSIDIAN_INLINE_RE = /(\n?)(\[\[[^[\]\n]+?]]|\[\^[^[\]\n]+?])(\n?)/g;

/** Obsidian embed syntax: `![[target]]`. */
const OBSIDIAN_EMBED_RE = /!\[\[([^[\]\n]*?)]]/g;

/**
 * Split a text node's value on `pattern`, mapping each match through `build`.
 * Returns `null` when nothing matched, so callers can skip the splice.
 */
function splitText(
    value: string,
    pattern: RegExp,
    build: (match: RegExpExecArray) => PhrasingContent,
): PhrasingContent[] | null {
    pattern.lastIndex = 0;
    const parts: PhrasingContent[] = [];
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = pattern.exec(value)) !== null) {
        if (m.index > last) {
            parts.push({ type: "text", value: value.slice(last, m.index) });
        }
        parts.push(build(m));
        last = m.index + m[0].length;
    }
    if (!parts.length) return null;
    if (last < value.length) {
        parts.push({ type: "text", value: value.slice(last) });
    }
    return parts;
}

export const obsidianSyntaxFeature: SyntaxFeature = {
    name: "obsidian-syntax",

    /**
     * Split text nodes so Obsidian syntax reaches the vault unescaped.
     *
     * Code needs no guarding here, and none is attempted: `code`,
     * `inlineCode`, `html` and `obsidianRaw` are mdast *literals*, holding a
     * bare `value` and no children. A fence's contents are therefore never
     * text nodes, so visiting text cannot reach them. (The ancestor check
     * this replaced tested for exactly that impossible case.)
     */
    transformMdastIn(tree: MRoot) {
        visit(tree, "text", (node, index, parent) => {
            if (!parent || index === undefined) return;
            if (!node.value.includes("[")) return;

            const parts = splitText(
                node.value,
                OBSIDIAN_INLINE_RE,
                (m) => obsidianRaw(`${m[1]!}${m[2]!}${m[3]!}`),
            );
            if (!parts) return;

            parent.children.splice(index, 1, ...parts);
            return [SKIP, index + parts.length];
        });
    },

    stringifyHandlers: () => ({
        /** Emitted verbatim, bypassing the text-escape rules. */
        obsidianRaw: stringifyAs<ObsidianRaw>((node) => node.value),
    }),

    /**
     * Expand embeds into standard markdown images.
     *
     * One-way by design: Zotero has no embed concept, so the result comes
     * back as a plain `![](…)`. Only embed destinations are re-encoded —
     * standard images are left alone so that remark-stringify escape
     * sequences (e.g. `\&`) are not mangled into `%5C&`.
     */
    transformMdastOut(tree: MRoot) {
        visit(tree, "text", (node, index, parent) => {
            if (!parent || index === undefined) return;
            if (!node.value.includes("![[")) return;

            const parts = splitText(node.value, OBSIDIAN_EMBED_RE, (m) => {
                const target = m[1]!;
                let url: string;
                try {
                    url = encodeURI(decodeURI(target));
                } catch {
                    url = encodeURI(target); // malformed %-escape: as-is
                }
                return { type: "image", url, alt: "", title: null };
            });
            if (!parts) return;

            parent.children.splice(index, 1, ...parts);
            return [SKIP, index + parts.length];
        });
    },
};
