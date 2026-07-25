/**
 * The conversion primitives the two pipelines need, named by what they do.
 *
 * ConvertService owns the frozen `unified()` instances and reuses them across
 * every note; the pipelines only ever need five operations from them. Stating
 * those directly — rather than passing `Processor` values around — keeps the
 * tree types concrete at each step. unified's `Processor` is generic over its
 * input and output trees, and the shared, reusable instances have to be typed
 * loosely enough to cover all of them, which erased the tree type at every
 * call site and forced a cast at each one. Those casts now live in exactly one
 * place: ConvertService's constructor.
 */

import type { Root as HRoot } from "hast";
import type { Root as MRoot } from "mdast";
import type { Handle as StringifyHandle } from "mdast-util-to-markdown";

export interface ConvertProcessors {
    /** Parse a Zotero note HTML string into hast. */
    parseHtml(html: string): HRoot;

    /** Parse a markdown string into mdast. */
    parseMarkdown(md: string): MRoot;

    /** Run the remark→rehype bridge. */
    mdastToHast(tree: MRoot): Promise<HRoot>;

    /** Serialize hast to an HTML string. */
    stringifyHtml(tree: HRoot): string;

    /** Serialize mdast to markdown, using the given per-node-type handlers. */
    stringifyMarkdown(
        tree: MRoot,
        handlers: Record<string, StringifyHandle>,
    ): string;
}
