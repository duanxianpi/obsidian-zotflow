/**
 * Line breaks — `<br>` ↔ newline, governed by the vault's
 * "strict line breaks" setting.
 *
 * strict OFF (Obsidian's default)
 *   `<br>` → a bare `\n`, which Obsidian renders as a visual break.
 *   Coming back, the soft break is promoted to a `break` node and so to
 *   `<br>` again.
 *
 * strict ON
 *   A bare `\n` would be a soft break and simply vanish, so `<br>` is kept
 *   as literal HTML. remark preserves raw HTML as-is, so this is stable —
 *   and there is no accumulation risk because the promotion below only runs
 *   when strict is OFF.
 */

import type { Html, Parents, Root as MRoot, RootContent, Text } from "mdast";
import type { SyntaxFeature } from "./types";

/**
 * Each mdast parent declares its own children type — `Root` holds
 * `RootContent`, `Paragraph` holds `PhrasingContent`, and so on. Rewriting
 * that array generically over the union of parents collapses to `never`, so
 * the walk below works on the widest element type and re-assigns through one
 * cast. It is sound: a `break` is only ever produced where a `text` node
 * already stood, so whatever the parent was still accepts the result.
 */
type LooseChildren = RootContent[];

const HARD_BREAK: Html = { type: "html", value: "<br>" };
const SOFT_BREAK: Text = { type: "text", value: "\n" };

export const lineBreaksFeature: SyntaxFeature = {
    name: "line-breaks",

    hastHandlers: (ctx) => ({
        br: () => (ctx.strictLineBreaks ? { ...HARD_BREAK } : { ...SOFT_BREAK }),
    }),

    /**
     * Promote soft line breaks inside text nodes to hard `break` nodes, so
     * they survive as `<br>`. Only when the vault is not in strict mode.
     */
    transformMdastOut(tree: MRoot, ctx) {
        if (ctx.strictLineBreaks) return;

        const walk = (node: Parents): void => {
            const next: LooseChildren = [];
            for (const child of node.children as LooseChildren) {
                if (child.type === "text") {
                    const parts = child.value.split(/\r?\n|\r/);
                    if (parts.length > 1) {
                        parts.forEach((part, i) => {
                            if (part) next.push({ type: "text", value: part });
                            if (i < parts.length - 1) {
                                next.push({ type: "break" });
                            }
                        });
                        continue;
                    }
                } else if ("children" in child) {
                    walk(child);
                }
                next.push(child);
            }
            node.children = next;
        };
        walk(tree);
    },
};
