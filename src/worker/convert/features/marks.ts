/**
 * Inline marks — underline, sub/superscript, strikethrough.
 *
 * `~~strike~~` has GFM syntax; the other three do not and survive as inline
 * HTML tags, which CommonMark passes through and Obsidian renders.
 */

import { visit } from "unist-util-visit";

import { styleStr } from "./element";
import { PASS, stringifyAs } from "./types";

import type { Root as HRoot } from "hast";
import type { Delete, PhrasingContent } from "mdast";
import type { InlineHtmlMark } from "../model/nodes";
import type { SyntaxFeature } from "./types";

type InlineHtmlTag = InlineHtmlMark["type"];

/**
 * Serialize a phrasing container as an inline HTML tag.
 *
 * The node keeps real `children`, so nested marks survive: `<u>a
 * <strong>b</strong></u>` becomes `<u>a **b**</u>` rather than flattening to
 * the bare text `<u>a b</u>`. CommonMark treats the tag as raw inline HTML
 * and keeps parsing markdown around it, so Obsidian renders the nested
 * emphasis and the next `html2md` sees the original structure again.
 */
function inlineHtmlMark(tag: InlineHtmlTag) {
    return stringifyAs<InlineHtmlMark>((node, _parent, state, info) => {
        const open = `<${tag}>`;
        const close = `</${tag}>`;
        const inner = state.containerPhrasing(node, {
            ...info,
            before: open,
            after: close,
        });
        return open + inner + close;
    });
}

export const marksFeature: SyntaxFeature = {
    name: "marks",

    hastHandlers: () => ({
        // Zotero's strike mark is a styled span, not <del>.
        span: (state, node) => {
            if (!styleStr(node).includes("text-decoration: line-through")) {
                return PASS;
            }
            const del: Delete = {
                type: "delete",
                children: state.all(node) as PhrasingContent[],
            };
            return del;
        },

        // <u>/<sub>/<sup> → phrasing containers of the same name.
        u: (state, node) => markNode("u", state.all(node)),
        sub: (state, node) => markNode("sub", state.all(node)),
        sup: (state, node) => markNode("sup", state.all(node)),
    }),

    stringifyHandlers: () => ({
        u: inlineHtmlMark("u"),
        sub: inlineHtmlMark("sub"),
        sup: inlineHtmlMark("sup"),
    }),

    /**
     * GFM `~~strike~~` becomes `<del>`, but Zotero's schema expresses strike
     * as a styled span. Rewrite on the way out.
     */
    transformHast(tree: HRoot) {
        visit(tree, "element", (node) => {
            if (node.tagName !== "del") return;
            node.tagName = "span";
            node.properties.style = "text-decoration: line-through";
        });
    },
};

function markNode(tag: InlineHtmlTag, children: unknown): InlineHtmlMark {
    return { type: tag, children: children as PhrasingContent[] };
}
