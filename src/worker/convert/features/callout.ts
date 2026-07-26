/**
 * Obsidian callouts — `> [!note] Title`.
 *
 * A callout is not its own block type: it is an ordinary blockquote whose
 * first paragraph opens with `[!type]`, optionally followed by a fold marker
 * (`+`/`-`) and a title. The blockquote itself already round-trips, and the
 * marker reaches Zotero untouched — `md2html` emits
 * `<blockquote><p>[!note] Title …`, which Zotero stores as plain text.
 *
 * Only the return leg broke it. `mdast-util-to-markdown` escapes a leading
 * `[` in text so it cannot be re-read as link syntax, so `[!note]` came back
 * as `\[!note]` and Obsidian no longer recognized the callout. Claiming the
 * marker as an `obsidianRaw` node bypasses that escape, exactly as the
 * wikilink handling does.
 *
 * Only the marker is claimed, never the title: a title is ordinary phrasing
 * content and must keep being parsed as such, so `> [!note] See [[Alpha]]`
 * still gets its wikilink handled by the obsidian-syntax feature.
 */

import { visit } from "unist-util-visit";

import { obsidianRaw } from "../model/nodes";

import type { PhrasingContent, Root as MRoot } from "mdast";
import type { SyntaxFeature } from "./types";

/**
 * `[!type]` plus an optional fold marker, anchored at the start of the text.
 *
 * The type is bounded by `[^\]\n]` rather than `\w` because Obsidian matches
 * callout types case-insensitively and community themes register hyphenated
 * ones; nothing here depends on the type being known.
 */
const CALLOUT_MARKER_RE = /^\[![^\]\n]+\][+-]?/;

export const calloutFeature: SyntaxFeature = {
    name: "callout",

    transformMdastIn(tree: MRoot) {
        visit(tree, "blockquote", (node) => {
            // `visit` descends into nested blockquotes on its own, so
            // `> > [!todo]` is reached as its own blockquote node.
            const first = node.children[0];
            if (first?.type !== "paragraph") return;

            const lead = first.children[0];
            if (lead?.type !== "text") return;

            const marker = CALLOUT_MARKER_RE.exec(lead.value)?.[0];
            if (!marker) return;

            const rest = lead.value.slice(marker.length);
            const replacement: PhrasingContent[] = [obsidianRaw(marker)];
            if (rest) replacement.push({ type: "text", value: rest });

            first.children.splice(0, 1, ...replacement);
        });
    },
};
