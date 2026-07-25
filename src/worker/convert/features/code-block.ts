/**
 * Code blocks and inline code.
 *
 * Zotero's `codeBlock` schema carries no language attribute — `toDOM` emits a
 * bare `<pre>` — so a fence info string (```` ```python ````) has nowhere to
 * live and is **degraded** away. Everything inside the fence is preserved
 * exactly, which is the part that matters: all the syntax handling in this
 * pipeline runs on the AST, where a fence is a single opaque `code` node.
 */

import { toText } from "hast-util-to-text";
import { visit } from "unist-util-visit";

import { stringifyAs } from "./types";

import type { Root as HRoot } from "hast";
import type { Code } from "mdast";
import type { SyntaxFeature } from "./types";

export const codeBlockFeature: SyntaxFeature = {
    name: "code-block",

    stringifyHandlers: () => ({
        /**
         * Fenced, with the fence widened past any backtick run in the content
         * — otherwise an inner ``` would close the outer fence, which happens
         * whenever a note documents fenced code.
         */
        code: stringifyAs<Code>((node) => {
            const value = node.value;
            let longestRun = 0;
            for (const run of value.match(/`+/g) ?? []) {
                if (run.length > longestRun) longestRun = run.length;
            }
            const fence = "`".repeat(Math.max(3, longestRun + 1));
            return `${fence}\n${value}\n${fence}`;
        }),
    }),

    /**
     * Replace `<code>` inside `<pre>` with its text — Zotero's `codeBlock`
     * takes `text*` content directly, with no inner `<code>` element.
     *
     * Registered after the math feature, which needs its
     * `<code class="… math-display">` rewritten before this pass would erase
     * it.
     */
    transformHast(tree: HRoot) {
        visit(tree, "element", (node) => {
            if (node.tagName !== "pre") return;
            node.children = node.children.map((child) => {
                if (child.type !== "element" || child.tagName !== "code") {
                    return child;
                }
                const value = toText(child, { whitespace: "pre-wrap" });
                return {
                    type: "text" as const,
                    value: value.endsWith("\n") ? value.slice(0, -1) : value,
                };
            });
        });
    },
};
