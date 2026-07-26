/**
 * Obsidian-only inline syntax — wikilinks, embeds, footnote markers.
 *
 * | syntax           | strategy | note                                      |
 * | ---------------- | -------- | ----------------------------------------- |
 * | `[[Note]]`       | preserve | plain text to Zotero, verbatim both ways  |
 * | `[[A\|B]]`       | preserve | ditto                                     |
 * | `![[file]]`      | preserve | ditto — see "embeds" below                |
 * | `[^1]`, `[^1]:`  | preserve | GFM footnotes are deliberately off        |
 * | `^[inline note]` | preserve | may contain one nested `[[…]]`            |
 * | `#tag`           | preserve | only at a line start — see "tags" below   |
 *
 * All of it reaches Zotero intact on its own: none of these forms means
 * anything to a markdown parser, so they arrive as ordinary text and Zotero
 * stores them verbatim. The work is entirely on the way *back*, where
 * `mdast-util-to-markdown` escapes `[`, `!` and a leading `#` in text so they
 * cannot be re-read as link/image/heading syntax — turning `[[Note]]` into
 * `\[\[Note]]` and `^[note]` into `^\[note]`. Wrapping each form in an
 * `obsidianRaw` node bypasses that escape pass, and unlike the bare `html`
 * node this replaced, says why.
 *
 * Embeds: `![[…]]` used to be expanded one-way into `![](…)`, on the reasoning
 * that Zotero has no embed concept. That cost the syntax permanently and
 * bought nothing — the destination is a vault-relative path Zotero cannot
 * resolve, so the result was a broken image there either way, and a sizing
 * hint such as `![[img.png|100x145]]` had its `|` percent-encoded into the
 * `src` as `%7C`, mangling the path as well. Preserving the literal text
 * instead costs Zotero nothing it had and keeps the embed working in the
 * vault.
 *
 * Tags: unlike the bracket forms, `#` is only escaped at a line start, and
 * only because of ATX headings. The claim here is therefore narrower and
 * rests on a rule from CommonMark rather than on Obsidian's tag grammar —
 * see `scanTag`.
 */

import { visit, SKIP } from "unist-util-visit";

import { obsidianRaw } from "../model/nodes";
import { safeInContainer, stringifyAs } from "./types";

import type { PhrasingContent, Root as MRoot } from "mdast";
import type { ObsidianRaw } from "../model/nodes";
import type { SyntaxFeature } from "./types";

/* ---------------------------------------------------------------- */
/*  Scanning                                                         */
/* ---------------------------------------------------------------- */

/**
 * A hand-written left-to-right scan rather than one regex with four
 * alternatives. The forms have genuinely different bracket rules — `^[…]` may
 * contain a nested `[[…]]`, the others may not contain a bracket at all — and
 * expressing that as a single pattern needs nested quantifiers whose
 * backtracking behaviour is hard to bound. A single pass has no such failure
 * mode: every character is visited once.
 */
interface RawSpan {
    start: number;
    /** Exclusive. */
    end: number;
}

/**
 * Scan the body of `[[…]]`, `![[…]]` or `[^…]`, which may hold no bracket and
 * no newline. Returns the index just past `close`, or -1 if unterminated.
 */
function scanFlat(value: string, from: number, close: string): number {
    for (let i = from; i < value.length; i++) {
        const ch = value[i];
        if (ch === "\n" || ch === "[") return -1;
        if (ch === "]") {
            return value.startsWith(close, i) ? i + close.length : -1;
        }
    }
    return -1;
}

/**
 * Scan the body of `^[…]`. Unlike the others this one routinely holds a
 * wikilink — `^[see [[Note]]]` — so a nested `[[…]]` is stepped over rather
 * than rejected. Any other `[` still ends the attempt: a lone bracket means
 * this was not an inline footnote.
 */
function scanInlineFootnote(value: string, from: number): number {
    for (let i = from; i < value.length; i++) {
        const ch = value[i];
        if (ch === "\n") return -1;
        if (ch === "]") return i + 1;
        if (ch === "[") {
            if (!value.startsWith("[[", i)) return -1;
            const nested = scanFlat(value, i + 2, "]]");
            if (nested === -1) return -1;
            i = nested - 1;
        }
    }
    return -1;
}

/**
 * Scan a tag starting at the `#` in `from`, which the caller has established
 * sits at a line start. Returns the index just past the tag, or -1.
 *
 * The condition tested here is *not* "is this a valid Obsidian tag" but "is
 * this definitely not an ATX heading" — CommonMark requires whitespace or the
 * end of the line after the hashes, so `#philosophy` cannot be one.
 * `mdast-util-to-markdown` escapes every `#` at a break regardless of what
 * follows, which turned a tag into `\#philosophy`: literal text in Obsidian,
 * not a tag.
 *
 * Deriving the claim from the heading rule rather than from tag syntax is what
 * makes it safe. The span is emitted raw in exactly the cases where the escape
 * it would otherwise receive is unnecessary, so a genuine `\# not a heading`
 * still gets its backslash. It also means a form Obsidian would reject as a
 * tag, such as `#123`, still round-trips verbatim — which is the actual goal.
 */
function scanTag(value: string, from: number): number {
    let i = from;
    while (value[i] === "#") i++;

    // `#`, `# x` and `#\n` are all headings; anything else is not.
    const next = value[i];
    if (next === undefined || next === " " || next === "\t" || next === "\n") {
        return -1;
    }

    // Stop at whitespace, and at `[` so a following wikilink is still claimed
    // by its own rule rather than swallowed into the tag.
    while (i < value.length) {
        const ch = value[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "[") break;
        i++;
    }
    return i;
}

/** Every Obsidian inline construct in `value`, in order, without overlaps. */
function scanObsidianInline(value: string): RawSpan[] {
    const spans: RawSpan[] = [];

    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        let end = -1;

        if (ch === "!" && value.startsWith("![[", i)) {
            end = scanFlat(value, i + 3, "]]");
        } else if (ch === "[") {
            if (value.startsWith("[[", i)) end = scanFlat(value, i + 2, "]]");
            else if (value.startsWith("[^", i)) end = scanFlat(value, i + 2, "]");
        } else if (ch === "^" && value.startsWith("^[", i)) {
            end = scanInlineFootnote(value, i + 2);
        } else if (ch === "#" && (i === 0 || value[i - 1] === "\n")) {
            // Only a line start can attract the heading escape. Claiming a
            // mid-line `#` would be harmless but pointless, and the check
            // keeps the common case — a `#` inside a URL or a `[[Note#H]]`
            // — from entering the scan at all.
            end = scanTag(value, i);
        }

        if (end === -1) continue;
        spans.push({ start: i, end });
        i = end - 1;
    }

    return spans;
}

/* ---------------------------------------------------------------- */
/*  Serialization                                                    */
/* ---------------------------------------------------------------- */

/* ---------------------------------------------------------------- */
/*  Feature                                                          */
/* ---------------------------------------------------------------- */

export const obsidianSyntaxFeature: SyntaxFeature = {
    name: "obsidian-syntax",

    /**
     * Split text nodes so Obsidian syntax reaches the vault unescaped.
     *
     * Code needs no guarding here, and none is attempted: `code`,
     * `inlineCode`, `html` and `obsidianRaw` are mdast *literals*, holding a
     * bare `value` and no children. A fence's contents are therefore never
     * text nodes, so visiting text cannot reach them. (The ancestor check
     * this replaced tested for exactly that impossible case.)
     */
    transformMdastIn(tree: MRoot) {
        visit(tree, "text", (node, index, parent) => {
            if (!parent || index === undefined) return;
            const value = node.value;
            // Cheap rejection of text that cannot contain any claimed form:
            // the bracket forms all need a `[`, and a tag is only claimed at a
            // line start.
            if (
                !value.includes("[") &&
                !value.startsWith("#") &&
                !value.includes("\n#")
            ) {
                return;
            }

            const spans = scanObsidianInline(value);
            if (!spans.length) return;

            const parts: PhrasingContent[] = [];
            let last = 0;

            // The span is claimed exactly as scanned. An adjacent newline used
            // to be folded into the raw node as well, because a text node
            // ending in `\n` beside one was normalized to a single space and
            // pulled `[[link]]` up onto the previous line. That was a symptom
            // of the raw node sitting outside the serializer's accounting
            // entirely; now that it goes through `state.safe()` like anything
            // else, the newline is handled where it belongs and the fold is
            // unnecessary. `wikilinks-line-breaks` in the md round-trip
            // harness is the case that originally forced it, and still passes.
            for (const span of spans) {
                if (span.start > last) {
                    parts.push({
                        type: "text",
                        value: value.slice(last, span.start),
                    });
                }
                parts.push(obsidianRaw(value.slice(span.start, span.end)));
                last = span.end;
            }

            if (last < value.length) {
                parts.push({ type: "text", value: value.slice(last) });
            }

            parent.children.splice(index, 1, ...parts);
            return [SKIP, index + parts.length];
        });
    },

    stringifyHandlers: () => ({
        /**
         * Escaped normally, minus the rules these forms exist to dodge —
         * see `safeInContainer`. `[[Beta|Gamma]]` in a table cell is what
         * proved that emitting the value untouched is not an option.
         */
        obsidianRaw: stringifyAs<ObsidianRaw>((node, _parent, state, info) =>
            safeInContainer(state, info, node.value),
        ),
    }),
};
