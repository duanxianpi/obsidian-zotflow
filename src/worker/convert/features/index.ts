/**
 * Feature registry.
 *
 * Order is part of the contract — see the comments on the list below. Within
 * a single stage, features run in this order; for element handlers, the first
 * feature that does not return `PASS` claims the tag.
 */

import { defaultHandlers as defaultRehype2Remark } from "hast-util-to-mdast";

import { noteStructureFeature } from "./note-structure";
import { citationLinksFeature } from "./citation-links";
import { mathFeature } from "./math";
import { zoteroPayloadFeature, spanUnwrapFeature } from "./zotero-payloads";
import { marksFeature } from "./marks";
import { annotationImageFeature } from "./annotation-image";
import { tableFeature } from "./table";
import { listFeature } from "./list";
import { taskListFeature } from "./task-list";
import { obsidianSyntaxFeature } from "./obsidian-syntax";
import { codeBlockFeature } from "./code-block";
import { lineBreaksFeature } from "./line-breaks";
import { linkFeature } from "./link";
import { PASS } from "./types";

import type { Root as HRoot } from "hast";
import type { Root as MRoot } from "mdast";
import type { Handle } from "hast-util-to-mdast";
import type { Handle as StringifyHandle } from "mdast-util-to-markdown";
import type {
    ElementHandler,
    FeatureContext,
    SyntaxFeature,
} from "./types";

/**
 * The ordering constraints that actually matter:
 *
 *  - `note-structure` first: everything downstream assumes a cleaned tree.
 *  - `citation-links` before the payload features, so the anchors it injects
 *    are inside the spans by the time those are captured verbatim.
 *  - `math` before `zotero-payloads` and `span-unwrap`: `<span class="math">`
 *    would otherwise be swallowed by the generic span handling.
 *  - `math` before `code-block` on the outbound side, because the code
 *    flattener would erase `<code class="… math-display">`.
 *  - `zotero-payloads` before `marks`: a `<span>` with both an annotation
 *    payload and a strike style must keep the payload.
 *  - `span-unwrap` last of the span claimants — it is the fallback.
 */
export const FEATURES: readonly SyntaxFeature[] = [
    noteStructureFeature,
    citationLinksFeature,
    mathFeature,
    zoteroPayloadFeature,
    marksFeature,
    spanUnwrapFeature,
    annotationImageFeature,
    tableFeature,
    listFeature,
    taskListFeature,
    obsidianSyntaxFeature,
    codeBlockFeature,
    lineBreaksFeature,
    linkFeature,
];

/* ---------------------------------------------------------------- */
/*  Composition                                                      */
/* ---------------------------------------------------------------- */

/**
 * Merge every feature's element handlers into the record rehype-remark
 * expects, chaining the features that claim the same tag.
 */
export function buildHastHandlers(
    ctx: FeatureContext,
): Record<string, Handle> {
    const chains = new Map<string, ElementHandler[]>();
    for (const feature of FEATURES) {
        const handlers = feature.hastHandlers?.(ctx);
        if (!handlers) continue;
        for (const [tag, handler] of Object.entries(handlers)) {
            const chain = chains.get(tag);
            if (chain) chain.push(handler);
            else chains.set(tag, [handler]);
        }
    }

    const defaults = defaultRehype2Remark as Record<string, Handle | undefined>;
    const merged: Record<string, Handle> = {};

    for (const [tag, chain] of chains) {
        const fallback = defaults[tag];
        const handle: Handle = (state, node, parent) => {
            for (const handler of chain) {
                const result = handler(state, node, parent);
                if (result !== PASS) return result;
            }
            // Every feature declined — hand back to rehype-remark's default,
            // or drop the element if it has none.
            return fallback?.(state, node, parent);
        };
        merged[tag] = handle;
    }
    return merged;
}

/** Merge every feature's markdown stringify handlers. */
export function buildStringifyHandlers(
    ctx: FeatureContext,
): Record<string, StringifyHandle> {
    const merged: Record<string, StringifyHandle> = {};
    for (const feature of FEATURES) {
        Object.assign(merged, feature.stringifyHandlers?.(ctx, merged) ?? {});
    }
    return merged;
}

/* ---------------------------------------------------------------- */
/*  Stage runners                                                    */
/* ---------------------------------------------------------------- */

export function runCleanHast(tree: HRoot, ctx: FeatureContext): void {
    for (const f of FEATURES) f.cleanHast?.(tree, ctx);
}

export function runTransformMdastIn(tree: MRoot, ctx: FeatureContext): void {
    for (const f of FEATURES) f.transformMdastIn?.(tree, ctx);
}

export function runPostSerializeMd(md: string, ctx: FeatureContext): string {
    for (const f of FEATURES) md = f.postSerializeMd?.(md, ctx) ?? md;
    return md;
}

export function runTransformMdastOut(tree: MRoot, ctx: FeatureContext): void {
    for (const f of FEATURES) f.transformMdastOut?.(tree, ctx);
}

export function runTransformHast(tree: HRoot, ctx: FeatureContext): void {
    for (const f of FEATURES) f.transformHast?.(tree, ctx);
}

export function runPostSerializeHtml(
    html: string,
    ctx: FeatureContext,
): string {
    for (const f of FEATURES) html = f.postSerializeHtml?.(html, ctx) ?? html;
    return html;
}

export type { FeatureContext, SyntaxFeature } from "./types";
