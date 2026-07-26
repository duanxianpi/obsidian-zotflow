/**
 * Task lists — `- [x] done` / `- [ ] todo`.
 *
 * Zotero's note schema has no checkbox node and silently drops
 * `<input type="checkbox">` on import, losing the checked state. Strategy:
 * **preserve** the marker as ordinary text, which Zotero keeps verbatim and
 * Obsidian re-recognizes as a task list.
 *
 * Both directions are pure mdast transforms. micromark has already resolved
 * block structure by then, so a `- [x]` line inside a fenced code block is a
 * `code` node and is never visited — the whole-string regex this replaced
 * could not tell the difference and corrupted such code blocks irreversibly.
 */

import { visit } from "unist-util-visit";

import type { Paragraph, Root as MRoot, Text } from "mdast";
import type { SyntaxFeature } from "./types";

/** Literal marker at the head of a list item, as stored in Zotero. */
const TASK_PREFIX_RE = /^\[([ xX])\]\s+/;

function text(value: string): Text {
    return { type: "text", value };
}

export const taskListFeature: SyntaxFeature = {
    name: "task-list",

    /**
     * Lift the literal `[x] ` / `[ ] ` prefix back into `listItem.checked`,
     * so the GFM stringifier emits canonical `* [x] foo`. Also catches
     * hand-written markers that never went through Zotero.
     */
    transformMdastIn(tree: MRoot) {
        visit(tree, "listItem", (node) => {
            if (typeof node.checked === "boolean") return;

            // Normally a paragraph, but a heading can lead a list item too
            // and carries phrasing children just the same.
            const container = node.children[0];
            if (
                container?.type !== "paragraph" &&
                container?.type !== "heading"
            ) {
                return;
            }

            const firstText = container.children[0];
            if (firstText?.type !== "text") return;

            const m = TASK_PREFIX_RE.exec(firstText.value);
            if (!m) return;

            node.checked = m[1]!.toLowerCase() === "x";
            firstText.value = firstText.value.slice(m[0].length);

            // If stripping emptied the text node and nothing else remains,
            // drop it so the stringifier emits no stray empty paragraph.
            if (!firstText.value && container.children.length === 1) {
                container.children.shift();
            }
        });
    },

    /** Flatten `listItem.checked` into literal text before HTML generation. */
    transformMdastOut(tree: MRoot) {
        visit(tree, "listItem", (node) => {
            if (typeof node.checked !== "boolean") return;
            const marker = node.checked ? "[x] " : "[ ] ";
            node.checked = null;

            const first = node.children[0];
            if (first?.type === "paragraph") {
                // Merge into the leading text node when there is one, so the
                // marker and the item text stay a single inline run — this
                // matches the `<li><span>…</span></li>` shape Zotero's own
                // note editor emits (see the list feature's span wrapping).
                const lead = first.children[0];
                if (lead?.type === "text") lead.value = marker + lead.value;
                else first.children.unshift(text(marker));
            } else {
                // Empty item, or one opening with a block node (nested list,
                // code fence …) — give the marker its own paragraph.
                const para: Paragraph = {
                    type: "paragraph",
                    children: [text(marker)],
                };
                node.children.unshift(para);
            }
        });
    },
};
