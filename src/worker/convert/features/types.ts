/**
 * The syntax-feature contract.
 *
 * One file per syntax, both directions in it. The axis of change here is the
 * *feature*, not the pipeline stage: adding Obsidian syntax or a Zotero node
 * means asking "how does this go out, and how does it come back" — so those
 * two answers belong next to each other. Splitting by stage (parse/handlers/
 * serialize) is what previously smeared a single feature such as task lists
 * across four call sites in two files, where changing one and forgetting the
 * others was the default outcome.
 *
 * A feature implements only the hooks it needs; the registry composes them.
 * The two directions are deliberately symmetric — four hooks each, one per
 * representation the document passes through:
 *
 *   html → md :  HAST → (handlers) → mdast → markdown string
 *                cleanHast  hastHandlers  transformMdastIn / stringifyHandlers
 *                                                          postSerializeMd
 *
 *   md → html :  mdast → HAST → html string
 *                transformMdastOut  transformHast  postSerializeHtml
 */

import type { Root as HRoot } from "hast";
import type { Root as MRoot } from "mdast";
import type { State, Handle as HastHandle } from "hast-util-to-mdast";
import type { Element } from "hast";
import type {
    Handle as StringifyHandle,
    State as StringifyState,
} from "mdast-util-to-markdown";

/** Everything a feature may vary its behaviour on. */
export interface FeatureContext {
    /**
     * Vault-relative folder holding extracted annotation images
     * (e.g. `ZotFlow/images`). Absent when extraction is not configured.
     */
    annotationImageFolder?: string;
    /**
     * Mirror of the vault's "strict line breaks" setting. When `false`
     * (Obsidian's default) a single newline renders as a visual break.
     */
    strictLineBreaks: boolean;
    /**
     * Wrap Zotero annotation/citation spans in clickable anchors.
     * Display-only: the outbound direction strips them unconditionally.
     */
    linkCitationSpans: boolean;
}

/**
 * Returned by an element handler that does not claim the node, letting the
 * next feature registered for the same tag try it.
 *
 * Needed because one HTML tag can carry several unrelated features — a
 * Zotero `<span>` is variously math, a citation payload, a highlight, a
 * strike mark, a colour mark, or just a wrapper. A plain `undefined` cannot
 * express this: `hast-util-to-mdast` reads that as "this node produces
 * nothing", which would silently delete content.
 */
export const PASS = Symbol("zotflow.handler.pass");
export type PASS = typeof PASS;

/**
 * A feature's element handler: the usual `hast-util-to-mdast` signature,
 * plus the option to decline via `PASS`.
 */
export type ElementHandler = (
    state: State,
    node: Element,
    parent: unknown,
) => ReturnType<HastHandle> | PASS;

/**
 * Wrap a node-typed serializer as an `mdast-util-to-markdown` handler.
 *
 * That library types a handler's node as `any`, because handlers are keyed by
 * node type and cannot be narrowed generically. Rather than let that `any`
 * spread across every feature, it is confined to this one cast: callers state
 * the node type they registered under and get a checked body.
 */
export function stringifyAs<T>(
    fn: (
        node: T,
        parent: Parameters<StringifyHandle>[1],
        state: StringifyState,
        info: Parameters<StringifyHandle>[3],
    ) => string,
): StringifyHandle {
    return fn as StringifyHandle;
}

export interface SyntaxFeature {
    /** Stable identifier, used in ordering comments and diagnostics. */
    readonly name: string;

    /* ---- html → md ------------------------------------------------ */

    /** Pre-clean the parsed note HAST, before rehype-remark runs. */
    cleanHast?(tree: HRoot, ctx: FeatureContext): void;

    /**
     * Element handlers keyed by HTML tag name. Several features may register
     * the same tag; they are tried in registry order and the first one that
     * does not return `PASS` wins. If all decline, rehype-remark's own
     * default handler runs.
     */
    hastHandlers?(ctx: FeatureContext): Record<string, ElementHandler>;

    /** Transform the mdast produced by rehype-remark. */
    transformMdastIn?(tree: MRoot, ctx: FeatureContext): void;

    /**
     * mdast-util-to-markdown handlers, keyed by mdast node type.
     *
     * `allHandlers` is the merged record the registry is assembling. It is
     * safe to capture by reference and read at serialize time — by then
     * every feature has contributed — which is how the table feature reuses
     * the full handler set inside its nested `toMarkdown` call.
     */
    stringifyHandlers?(
        ctx: FeatureContext,
        allHandlers: Record<string, StringifyHandle>,
    ): Record<string, StringifyHandle>;

    /**
     * Last-resort rewrite of the finished markdown string.
     *
     * Reserved for things with no AST representation — a serializer escape
     * that cannot be reached through a handler, for instance. Anything that
     * can be expressed as a tree transform must be, because a string pass
     * cannot tell prose from the inside of a code fence.
     */
    postSerializeMd?(md: string, ctx: FeatureContext): string;

    /* ---- md → html ------------------------------------------------ */

    /** Transform the mdast produced by remark-parse. */
    transformMdastOut?(tree: MRoot, ctx: FeatureContext): void;

    /** Transform the HAST produced by remark-rehype, before stringify. */
    transformHast?(tree: HRoot, ctx: FeatureContext): void;

    /** Last-resort rewrite of the finished HTML string. See `postSerializeMd`. */
    postSerializeHtml?(html: string, ctx: FeatureContext): string;
}
