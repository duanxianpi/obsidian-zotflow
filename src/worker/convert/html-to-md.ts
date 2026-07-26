/**
 * Zotero note HTML → Markdown.
 *
 * Pipeline orchestration only. Every syntax decision — what a Zotero element
 * becomes, what survives verbatim, what degrades — lives in `./features`,
 * one file per syntax with both directions in it.
 *
 *   html string
 *     → rehype parse            (+ wrapper-div extraction)
 *     → cleanHast               feature stage 1
 *     → rehype-remark           feature stage 2 (element handlers)
 *     → transformMdastIn        feature stage 3
 *     → remark-stringify        feature stage 4 (stringify handlers)
 *     → postSerializeMd         feature stage 5 (last resort)
 *
 * Runs entirely in the Web Worker — no DOM dependency.
 */

import { unified } from "unified";
import rehypeRemark from "rehype-remark";
import { toHtml } from "hast-util-to-html";

import { formatNoteMeta } from "utils/note-meta";
import {
    buildHastHandlers,
    buildStringifyHandlers,
    runCleanHast,
    runTransformMdastIn,
    runPostSerializeMd,
} from "./features";

import type { Element, Root as HRoot } from "hast";
import type { Root as MRoot } from "mdast";
import type { ConvertProcessors } from "./processors";
import type { FeatureContext } from "./features";

/* ================================================================ */
/*  Options                                                         */
/* ================================================================ */

/** Options for HTML → Markdown conversion. */
export interface Html2MdOptions {
    /** Vault-relative folder for annotation images (e.g. "ZotFlow/images"). */
    annotationImageFolder?: string;
    /**
     * Mirror of the vault's "strict line breaks" setting.
     * When `false` (Obsidian default), `<br>` → bare `\n`.
     * When `true`, `<br>` → literal `<br>` HTML passthrough (a bare `\n`
     * would be a soft break and would be lost).
     */
    strictLineBreaks?: boolean;
    /**
     * Wrap Zotero annotation/citation spans with clickable zotflow anchors.
     * Display-only — md2html strips them.
     */
    linkCitationSpans?: boolean;
}

function toContext(options?: Html2MdOptions): FeatureContext {
    return {
        annotationImageFolder: options?.annotationImageFolder,
        strictLineBreaks: options?.strictLineBreaks ?? false,
        linkCitationSpans: options?.linkCitationSpans ?? false,
    };
}

/* ================================================================ */
/*  Wrapper div                                                     */
/* ================================================================ */

interface NoteParseResult {
    tree: HRoot;
    /** Serialized HTML attributes of the wrapper div (for round-trip). */
    wrapperAttrs: string | null;
}

/**
 * Parse the note and lift out its metadata container
 * `<div data-schema-version data-citation-items>`.
 *
 * Handled here rather than in a feature because unwrapping produces a value
 * the caller has to thread back out — the attributes are re-emitted as the
 * leading `ZF_NOTE_META` comment so `md2html` can rebuild the wrapper.
 */
function parseNoteHtml(
    html: string,
    processors: ConvertProcessors,
): NoteParseResult {
    const tree = processors.parseHtml(html);
    let wrapperAttrs: string | null = null;

    for (let i = tree.children.length - 1; i >= 0; i--) {
        const child = tree.children[i];
        if (
            child?.type !== "element" ||
            child.tagName !== "div" ||
            child.properties.dataSchemaVersion == null
        ) {
            continue;
        }

        // Serialize the attributes via toHtml on a childless clone.
        const stub: Element = {
            type: "element",
            tagName: "div",
            properties: child.properties,
            children: [],
        };
        const stubHtml = toHtml(stub);
        const openEnd = stubHtml.indexOf(">");
        if (openEnd > 5) {
            // '<div ' is 5 chars
            wrapperAttrs = stubHtml.slice(5, openEnd).trim();
        }

        tree.children.splice(i, 1, ...child.children);
    }

    return { tree, wrapperAttrs };
}

/* ================================================================ */
/*  Public API                                                      */
/* ================================================================ */

/**
 * Convert Zotero-format note HTML to Markdown.
 *
 * Processors are injected by ConvertService (frozen, reusable).
 */
export async function html2mdWithProcessors(
    html: string,
    processors: ConvertProcessors,
    options?: Html2MdOptions,
): Promise<string> {
    const ctx = toContext(options);
    const { tree, wrapperAttrs } = parseNoteHtml(html, processors);

    runCleanHast(tree, ctx);

    const remark = (await unified()
        .use(rehypeRemark, {
            // Preserve hand-written line breaks inside paragraphs, so that
            // `<p>123\n[[link]]\n123</p>` round-trips as three lines instead
            // of collapsing into `123 [[link]] 123` (the HTML default).
            newlines: true,
            handlers: buildHastHandlers(ctx),
        })
        .run(tree)) as unknown as MRoot | null;

    if (!remark) return html; // conversion failed — hand back the raw HTML

    runTransformMdastIn(remark, ctx);

    let md = processors.stringifyMarkdown(
        remark,
        buildStringifyHandlers(ctx),
    );

    md = runPostSerializeMd(md, ctx);

    // Prepend the wrapper's attributes so md2html can rebuild it. The CM6
    // meta extension collapses and protects this line in Source Mode.
    if (wrapperAttrs) md = `${formatNoteMeta(wrapperAttrs)}\n` + md;

    return md;
}
