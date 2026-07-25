/**
 * Markdown → Zotero note HTML.
 *
 * Pipeline orchestration only. Every syntax decision lives in `./features`,
 * one file per syntax with both directions in it.
 *
 *   md string
 *     → remark parse            (+ ZF_NOTE_META extraction)
 *     → transformMdastOut       feature stage 1
 *     → remark-rehype
 *     → transformHast           feature stage 2
 *     → rehype-stringify
 *     → postSerializeHtml       feature stage 3 (last resort)
 *     → wrapper div restored
 *
 * Nothing here rewrites the raw markdown string before parsing. micromark
 * resolves block and inline structure first, so `code` and `inlineCode` are
 * distinct node types the feature passes simply never visit — a whole-string
 * regex cannot tell prose from the inside of a fence, and used to corrupt any
 * note that documented markdown syntax.
 *
 * Runs entirely in the Web Worker — no DOM dependency.
 */

import { matchLeadingNoteMeta } from "utils/note-meta";
import {
    runTransformMdastOut,
    runTransformHast,
    runPostSerializeHtml,
} from "./features";

import type { ConvertProcessors } from "./processors";
import type { FeatureContext } from "./features";

/* ================================================================ */
/*  Options                                                         */
/* ================================================================ */

/** Options for Markdown → HTML conversion. */
export interface ConvertOptions {
    /**
     * When `true` (default), single line breaks in markdown are soft breaks
     * (standard CommonMark). When `false`, they become hard breaks (`<br>`)
     * — matching Obsidian with "Strict line breaks" turned off.
     */
    strictLineBreaks?: boolean;
}

function toContext(options?: ConvertOptions): FeatureContext {
    return {
        strictLineBreaks: options?.strictLineBreaks ?? true,
        // Outbound never derives display links; the citation-links feature
        // strips any that came in unconditionally.
        linkCitationSpans: false,
    };
}

/* ================================================================ */
/*  Public API                                                      */
/* ================================================================ */

/**
 * Convert Markdown to Zotero-format note HTML.
 *
 * If the markdown starts with a `<!-- ZF_NOTE_META … -->` comment (injected
 * by `html2md`), the wrapper `<div>` is restored with its original
 * `data-schema-version` / `data-citation-items` attributes.
 *
 * Processors are injected by ConvertService (frozen, reusable).
 */
export async function md2htmlWithProcessors(
    md: string,
    processors: ConvertProcessors,
    options?: ConvertOptions,
): Promise<string> {
    const ctx = toContext(options);

    // Lift the wrapper-div metadata. Anchored at offset 0, so unlike the
    // syntax passes this cannot collide with document content. Accepted
    // spellings — current and legacy — live in utils/note-meta.
    let wrapperAttrs: string | null = null;
    const metaMatch = matchLeadingNoteMeta(md);
    if (metaMatch) {
        wrapperAttrs = metaMatch.attrs;
        md = md.slice(metaMatch.raw.length);
    }

    const mdast = processors.parseMarkdown(md);
    runTransformMdastOut(mdast, ctx);

    const hast = await processors.mdastToHast(mdast);
    runTransformHast(hast, ctx);

    let html = processors.stringifyHtml(hast);
    html = runPostSerializeHtml(html, ctx);

    if (wrapperAttrs) html = `<div ${wrapperAttrs}>${html}</div>`;

    return html;
}
