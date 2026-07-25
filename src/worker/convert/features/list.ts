/**
 * Lists — `<li>` structure on the way in, cell/item shaping on the way out.
 */

import { toText } from "hast-util-to-text";
import { visit } from "unist-util-visit";
import { defaultHandlers } from "hast-util-to-mdast";

import type {
    Element,
    ElementContent,
    Root as HRoot,
    RootContent,
} from "hast";
import type { ListItem, Paragraph, PhrasingContent } from "mdast";
import type { SyntaxFeature } from "./types";

/** mdast types that force a list item into block (loose) layout. */
const BLOCK_TYPES = new Set(["list", "code", "math", "table"]);

/**
 * What a list item's children can actually be *at this point*.
 *
 * mdast types a `listItem` as holding block content only, and that is true of
 * a well-formed tree. It is not true of the tree rehype-remark hands us: an
 * `<li>` mixing text with inline math yields phrasing content sitting
 * directly under the item, which is precisely the malformation this feature
 * exists to repair. The published types do not model that intermediate
 * state, so the widening is deliberate rather than a shortcut.
 */
type LooseItemChild = ListItem["children"][number] | PhrasingContent;

/** Children of `<li>`/`<td>` that Zotero's editor wraps in a `<span>`. */
const SPAN_WRAPPED_PARENTS = new Set(["li", "td"]);

export const listFeature: SyntaxFeature = {
    name: "list",

    hastHandlers: () => ({
        /**
         * Merge stray inline children into a single paragraph.
         *
         * A `<li>` mixing text with inline math yields a paragraph plus
         * orphaned inline nodes, which the stringifier then separates with
         * blank lines, visually splitting one item into several.
         * (Ported from zotero-better-notes #820, #1207, #1300.)
         */
        li: (state, node) => {
            const base = defaultHandlers.li(state, node);
            if (!base || base.type !== "listItem" || base.children.length < 2) {
                return base;
            }

            // Only merge when orphaned inline content is mixed in with
            // paragraphs. All-paragraph or all-block children are left alone,
            // so <dt>/<dd> definition lists still round-trip.
            const hasOrphanedInline = base.children.some(
                (c) => c.type !== "paragraph" && !BLOCK_TYPES.has(c.type),
            );
            if (!hasOrphanedInline) return base;

            const merged: LooseItemChild[] = [];
            const pending: LooseItemChild[] = base.children.splice(
                0,
                base.children.length,
            );

            for (const current of pending) {
                let last = merged[merged.length - 1];

                if (last?.type !== "paragraph") {
                    last = { type: "paragraph", children: [] };
                    merged.push(last);
                }
                const para: Paragraph = last;

                if (current.type === "paragraph") {
                    para.children.push(...current.children);
                } else if (current.type === "inlineMath") {
                    // Pad inline math with spaces for readability.
                    para.children.push({ type: "text", value: " " });
                    para.children.push(current);
                    para.children.push({ type: "text", value: " " });
                } else if (!BLOCK_TYPES.has(current.type)) {
                    // Any other phrasing content orphaned under the item.
                    para.children.push(current as PhrasingContent);
                } else {
                    merged.push(current);
                }
            }

            base.children.push(...(merged as ListItem["children"]));
            return base;
        },
    }),

    /**
     * Shape `<li>` / `<td>` contents the way Zotero's note editor does:
     * each text run wrapped in a `<span>`, and no whitespace-only text nodes
     * between them. Keeps sync diffs against Zotero-authored notes minimal.
     */
    transformHast(tree: HRoot) {
        visit(tree, "element", (parent: Element) => {
            if (!SPAN_WRAPPED_PARENTS.has(parent.tagName)) return;

            const shaped: ElementContent[] = [];
            for (const child of parent.children) {
                if (child.type !== "text") {
                    // `raw` nodes (from remark-rehype's dangerous HTML
                    // passthrough) and elements are kept as-is.
                    shaped.push(child);
                    continue;
                }
                const value = child.value.replace(/[\r\n]/g, "");
                // Whitespace-only runs between block children are noise here.
                if (!value) continue;
                shaped.push({
                    type: "element",
                    tagName: "span",
                    properties: {},
                    children: [{ type: "text", value }],
                });
            }
            parent.children = shaped;
        });
    },
};

/** An empty `<p>` — Zotero emits these, markdown has no place for them. */
export function isEmptyParagraph(node: RootContent): boolean {
    return (
        node.type === "element" &&
        node.tagName === "p" &&
        node.children.length === 0 &&
        !toText(node).trim()
    );
}

/** A text node that is only whitespace. */
export function isBlankText(node: RootContent): boolean {
    return node.type === "text" && !node.value.trim();
}
