/**
 * GFM support, composed from the granular micromark/mdast extensions.
 *
 * `remark-gfm` bundles footnote support with no per-feature toggle. ZotFlow
 * must NOT parse footnotes: Zotero's note schema has no footnote node, so
 * `[^1]` would become `<sup><a>` and `[^1]:` a `<section data-footnotes>`,
 * neither of which `html2md` can reverse. Historically this was worked around
 * by hiding `[^1]` inside HTML-comment sentinels via a whole-string regex
 * before parsing — which also fired inside fenced/inline code and corrupted
 * it irreversibly.
 *
 * Composing GFM by hand and simply *omitting* the footnote extension makes
 * `[^1]` ordinary text. It then round-trips verbatim with no sentinel, and
 * micromark's block/inline structure keeps it untouched inside code.
 *
 * `gfm-tagfilter` is intentionally omitted too — it neuters raw HTML on the
 * output side, but ZotFlow deliberately round-trips raw Zotero HTML.
 */

import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import {
    gfmAutolinkLiteralFromMarkdown,
    gfmAutolinkLiteralToMarkdown,
} from "mdast-util-gfm-autolink-literal";
import {
    gfmStrikethroughFromMarkdown,
    gfmStrikethroughToMarkdown,
} from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import {
    gfmTaskListItemFromMarkdown,
    gfmTaskListItemToMarkdown,
} from "mdast-util-gfm-task-list-item";

import type { Processor } from "unified";

/**
 * `toMarkdown` extensions for the GFM features ZotFlow supports.
 * Exported separately because the nested `toMarkdown()` call used for
 * table serialization needs the same set.
 */
export function gfmToMarkdownExtensions() {
    return [
        gfmAutolinkLiteralToMarkdown(),
        gfmStrikethroughToMarkdown(),
        gfmTableToMarkdown(),
        gfmTaskListItemToMarkdown(),
    ];
}

/**
 * unified plugin — GFM minus footnotes and tagfilter.
 * Drop-in replacement for `remark-gfm` on both the parse and stringify
 * processors.
 */
export function remarkGfmNoFootnotes(this: Processor): undefined {
    const data = this.data();

    const micromarkExtensions =
        data.micromarkExtensions ?? (data.micromarkExtensions = []);
    const fromMarkdownExtensions =
        data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
    const toMarkdownExtensions =
        data.toMarkdownExtensions ?? (data.toMarkdownExtensions = []);

    micromarkExtensions.push(
        gfmAutolinkLiteral(),
        gfmStrikethrough(),
        gfmTable(),
        gfmTaskListItem(),
    );
    fromMarkdownExtensions.push(
        gfmAutolinkLiteralFromMarkdown(),
        gfmStrikethroughFromMarkdown(),
        gfmTableFromMarkdown(),
        gfmTaskListItemFromMarkdown(),
    );
    toMarkdownExtensions.push(...gfmToMarkdownExtensions());
}
