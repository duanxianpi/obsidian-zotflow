/**
 * ZotFlow's custom mdast nodes.
 *
 * Markdown has no syntax for several things a Zotero note contains, and
 * Obsidian has syntax that CommonMark does not know about. Both used to be
 * smuggled through the pipeline as bare `{ type: "html" }` nodes, which
 * overloaded one node type with three unrelated jobs — Zotero payload
 * passthrough, escape bypass for Obsidian syntax, and (worst) a carrier
 * whose `value` was actually *markdown*. Nothing downstream could tell them
 * apart, and a lossy degradation was indistinguishable from a deliberate one.
 *
 * Each concern now has its own node type with its own stringify handler,
 * declared by the feature that owns it (see ../features).
 */

import type { Literal, Parent, PhrasingContent } from "mdast";

/**
 * Why a piece of Zotero HTML could not be expressed in Markdown.
 * Carried on the node so degradations stay attributable.
 */
export type OpaqueReason =
    /** `<span class="citation" data-citation>` — CSL payload. */
    | "citation"
    /** `<span class="highlight|underline" data-annotation>` — annotation payload. */
    | "annotation"
    /** `<table>` carrying inline styles GFM tables cannot express. */
    | "styled-table"
    /** `<span style="color|background-color">` — Zotero text/background color mark. */
    | "colored-text"
    /** Recognized Zotero element with no Markdown equivalent. */
    | "unknown-zotero-node";

/**
 * A verbatim run of Zotero HTML, preserved byte-for-byte.
 *
 * Serialized as raw HTML into the Markdown, re-parsed as HTML on the way
 * back, so the payload survives arbitrarily many round-trips untouched.
 */
export interface ZoteroOpaqueHtml extends Literal {
    type: "zoteroOpaqueHtml";
    /** The serialized element. */
    value: string;
    reason: OpaqueReason;
}

/**
 * An image extracted from a Zotero annotation.
 *
 * Emitted as `![<img …> | width](folder/KEY.png)`: the destination points at
 * the PNG ZotFlow extracted so Obsidian can render it, while the complete
 * original `<img>` tag — with every `data-*` attribute Zotero needs — rides
 * along in the alt text. `md2html` drops the wrapper and restores the tag.
 */
export interface ZoteroAnnotationImage extends Literal {
    type: "zoteroAnnotationImage";
    /** The original `<img …>` tag, verbatim. */
    value: string;
    /** Vault-relative path to the extracted PNG, when one is configured. */
    displayPath?: string;
    /** `width` attribute, surfaced in the alt text for readability. */
    width?: string;
}

/**
 * Obsidian-only inline syntax that must reach the vault unescaped.
 *
 * `mdast-util-to-markdown` escapes `[` and `!` in text so they cannot be
 * re-read as link/image syntax, which mangles `[[Note]]` into `\[\[Note]]`
 * and `[^1]` into `\[^1]`. This node's handler emits `value` verbatim,
 * bypassing the escape pass — and, unlike a bare `html` node, says why.
 */
export interface ObsidianRaw extends Literal {
    type: "obsidianRaw";
    value: string;
}

/**
 * A mark Markdown cannot express, kept as an inline HTML tag.
 *
 * A phrasing *container*, not a literal: `<u>a <strong>b</strong></u>` keeps
 * its children, so nested marks survive instead of being flattened to text.
 */
export interface InlineHtmlMark extends Parent {
    type: "u" | "sub" | "sup";
    children: PhrasingContent[];
}

/*
 * `inlineMath` and `math` are declared by `mdast-util-math` (via
 * `remark-math`) and deliberately not redeclared here.
 */

declare module "mdast" {
    interface PhrasingContentMap {
        zoteroOpaqueHtml: ZoteroOpaqueHtml;
        zoteroAnnotationImage: ZoteroAnnotationImage;
        obsidianRaw: ObsidianRaw;
        inlineHtmlMark: InlineHtmlMark;
    }
    interface RootContentMap {
        zoteroOpaqueHtml: ZoteroOpaqueHtml;
        zoteroAnnotationImage: ZoteroAnnotationImage;
        obsidianRaw: ObsidianRaw;
        inlineHtmlMark: InlineHtmlMark;
    }
}

/* ---------------------------------------------------------------- */
/*  Constructors                                                     */
/* ---------------------------------------------------------------- */

export function opaqueHtml(
    value: string,
    reason: OpaqueReason,
): ZoteroOpaqueHtml {
    return { type: "zoteroOpaqueHtml", value, reason };
}

export function obsidianRaw(value: string): ObsidianRaw {
    return { type: "obsidianRaw", value };
}
