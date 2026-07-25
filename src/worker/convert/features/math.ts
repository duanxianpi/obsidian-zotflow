/**
 * Math — Zotero `math_inline` / `math_display` ↔ `$…$` / `$$…$$`.
 *
 * Zotero stores math as `<span class="math">$x$</span>` and
 * `<pre class="math">$$x$$</pre>`, delimiters included in the text.
 * `remark-math` supplies the markdown side.
 */

import { toText } from "hast-util-to-text";
import { visit } from "unist-util-visit";

import { hasClass } from "./element";
import { PASS, stringifyAs } from "./types";

import type { Element, Root as HRoot } from "hast";
// The node interfaces live here; `remark-math` only augments mdast's maps.
import type { InlineMath, Math } from "mdast-util-math";
import type { SyntaxFeature } from "./types";

/** Strip the delimiters Zotero stores inside the element. */
function undelimit(raw: string, delim: "$" | "$$"): string {
    const n = delim.length;
    return raw.startsWith(delim) && raw.endsWith(delim)
        ? raw.slice(n, -n).trim()
        : raw;
}

/** `remark-rehype` marks math with these, not with Zotero's `math` class. */
function isMathElement(node: Element): "inline" | "display" | null {
    if (hasClass(node, "math-display")) return "display";
    if (hasClass(node, "math-inline")) return "inline";
    return null;
}

/** Rewrite an element into Zotero's shape, delimiters back inside the text. */
function toZoteroMath(node: Element, kind: "inline" | "display"): void {
    const delim = kind === "display" ? "$$" : "$";
    node.tagName = kind === "display" ? "pre" : "span";
    node.properties = { className: "math" };
    node.children = [
        { type: "text", value: delim + toText(node) + delim },
    ];
}

export const mathFeature: SyntaxFeature = {
    name: "math",

    hastHandlers: () => ({
        // <span class="math">$x$</span> → inlineMath
        span: (_state, node) => {
            if (!hasClass(node, "math")) return PASS;
            const value = undelimit(toText(node), "$");
            const mathNode: InlineMath = { type: "inlineMath", value };
            return mathNode;
        },

        // <pre class="math">$$x$$</pre> → math (block)
        // A <pre> without the class is a code block — declined so the
        // code-block feature (and ultimately rehype-remark) handles it.
        pre: (_state, node) => {
            if (!hasClass(node, "math")) return PASS;
            const value = undelimit(toText(node), "$$");
            const mathNode: Math = { type: "math", value };
            return mathNode;
        },
    }),

    stringifyHandlers: () => ({
        inlineMath: stringifyAs<InlineMath>((node) => `$${node.value}$`),
        math: stringifyAs<Math>((node) => `$$\n${node.value}\n$$`),
    }),

    /**
     * `remark-math` + `remark-rehype` emit
     * `<code class="language-math math-inline">` and
     * `<pre><code class="… math-display">`.
     *
     * Must run before the code-block feature flattens `<code>` inside
     * `<pre>`, which would otherwise destroy the math element — the registry
     * order guarantees this.
     */
    transformHast(tree: HRoot) {
        visit(tree, "element", (node, _index, parent) => {
            const kind = isMathElement(node);
            if (!kind) return;

            // Display math arrives wrapped: <pre><code class="math-display">.
            // Collapse onto the <pre> so Zotero sees its own shape.
            if (
                kind === "display" &&
                node.tagName === "code" &&
                parent?.type === "element" &&
                parent.tagName === "pre"
            ) {
                parent.properties = { className: "math" };
                parent.children = [
                    { type: "text", value: "$$" + toText(node) + "$$" },
                ];
                return;
            }

            toZoteroMath(node, kind);
        });
    },
};
