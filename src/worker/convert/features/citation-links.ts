/**
 * Clickable annotation/citation spans — display-only.
 *
 * Zotero payload spans are preserved verbatim (see zotero-payloads.ts) but
 * inert in Obsidian. This feature wraps their contents in an
 * `obsidian://zotflow` anchor on the way in, and strips those anchors on the
 * way out — unconditionally, so a derived link can never reach IDB or Zotero
 * regardless of the display setting's current state.
 *
 * The payload attributes themselves are never touched.
 */

import {
    wrapCitationSpanLinks,
    stripCitationSpanLinks,
} from "../citation-span-links";

import type { Root as HRoot } from "hast";
import type { SyntaxFeature } from "./types";

export const citationLinksFeature: SyntaxFeature = {
    name: "citation-links",

    /**
     * Runs on the parsed note HAST before rehype-remark, so the opaque-HTML
     * passthrough serializes span and anchor together.
     */
    cleanHast(tree: HRoot, ctx) {
        if (!ctx.linkCitationSpans) return;
        wrapCitationSpanLinks(tree);
    },

    /**
     * String-level because by this point the anchors live inside opaque HTML
     * payloads, which are deliberately never re-parsed into the tree.
     * Unconditional — see the note above.
     */
    postSerializeHtml(html: string): string {
        return stripCitationSpanLinks(html);
    },
};
