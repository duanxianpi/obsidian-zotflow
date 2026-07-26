/**
 * Zotero payload spans — citations, annotations, and colour marks.
 *
 * These carry URL-encoded JSON (`data-citation`, `data-annotation`) or inline
 * styles that Markdown cannot express. Strategy: **preserve**. The element is
 * kept verbatim as a `zoteroOpaqueHtml` node and re-emitted byte-for-byte, so
 * the payload survives any number of round-trips.
 *
 * Every degradation records *why* via `OpaqueReason`, so an unrepresentable
 * node is never confused with a deliberate passthrough.
 */

import { toHtml } from "hast-util-to-html";

import { opaqueHtml } from "../model/nodes";
import { classNames, styleStr } from "./element";
import { PASS, safeInContainer, stringifyAs } from "./types";

import type { ZoteroOpaqueHtml } from "../model/nodes";
import type { SyntaxFeature } from "./types";

export const zoteroPayloadFeature: SyntaxFeature = {
    name: "zotero-payloads",

    hastHandlers: () => ({
        span: (_state, node) => {
            const cls = classNames(node);
            const style = styleStr(node);

            // <span class="citation" data-citation="…">
            if (cls.includes("citation")) {
                return opaqueHtml(toHtml(node), "citation");
            }

            // <span class="highlight" data-annotation="…">
            if (cls.includes("highlight")) {
                return opaqueHtml(toHtml(node), "annotation");
            }

            // <span class="underline" data-annotation="…"> — the annotation
            // attribute distinguishes it from the plain underline mark, which
            // the marks feature turns into <u>.
            if (
                cls.includes("underline") &&
                node.properties.dataAnnotation != null
            ) {
                return opaqueHtml(toHtml(node), "annotation");
            }

            // Zotero backgroundColor / textColor marks.
            if (style.includes("background-color") || style.includes("color")) {
                return opaqueHtml(toHtml(node), "colored-text");
            }

            return PASS;
        },
    }),

    stringifyHandlers: () => ({
        /**
         * Emitted verbatim, so the payload is re-parsed as HTML on the way
         * back in and survives arbitrarily many round-trips — except for the
         * escapes the surrounding construct demands.
         *
         * Only container rules apply here (see `safeInContainer`), and they
         * are all safe on raw HTML: `\|` in a table cell is unescaped by the
         * GFM table parser before the inline HTML is read, so the payload
         * arrives intact. Skipping them is not safe: a citation whose visible
         * text contains a `|`, or an annotation containing a `<br>`, used to
         * tear its own table row apart.
         */
        zoteroOpaqueHtml: stringifyAs<ZoteroOpaqueHtml>(
            (node, _parent, state, info) =>
                safeInContainer(state, info, node.value),
        ),
    }),
};

/**
 * Generic `<span>` fallback — the last link in the span chain.
 *
 * Unwraps the wrapper and splices its inline children into the parent.
 * Returning the array (rather than wrapping in a `paragraph`) matters:
 * a paragraph would force the surrounding context — `<li>`, `<td>` — into
 * block mode and break GFM task lists and inline table cells.
 *
 * Registered last so every span-claiming feature gets first refusal.
 */
export const spanUnwrapFeature: SyntaxFeature = {
    name: "span-unwrap",

    hastHandlers: () => ({
        span: (state, node) => state.all(node),
    }),
};
