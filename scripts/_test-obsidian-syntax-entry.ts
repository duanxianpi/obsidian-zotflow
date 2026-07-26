/**
 * Obsidian syntax survival matrix:  MD → HTML → MD
 *
 * A *discovery* harness, not a unit test. Every syntax Obsidian understands is
 * fed in as an isolated snippet, pushed through `md2html` and back through
 * `html2md`, and classified by what came out the other side. The output is the
 * coverage table — which Obsidian syntax survives a Zotero sync, which is
 * silently rewritten, and which is destroyed.
 *
 * Why this exists separately from `test-md-roundtrip`:
 *
 *   That harness asks "does feature X behave as designed?" — each case asserts
 *   against hand-written expectations, so it can only fail for syntax someone
 *   already thought about. This one asks the opposite question, "what happens
 *   to syntax we may never have considered?", and answers it for the whole of
 *   Obsidian's documented surface. A blank spot here is the point of the test,
 *   not an omission from it.
 *
 * Verdicts, worst to best:
 *
 *   DRIFT      rt2 !== rt — the round trip is not a fixed point. Content keeps
 *              mutating on every sync. Always a failure, whatever `expect`
 *              says: no syntax is allowed to be unstable.
 *   BROKEN     stable, but the syntax did not survive: a required token is
 *              missing, or a forbidden one (usually a `\` escape) appeared.
 *   CANONICAL  stable, semantically intact, but not byte-identical — `-`
 *              bullets became `*`, an entity resolved, whitespace normalized.
 *              Acceptable: markdown has many spellings of the same document.
 *   VERBATIM   byte-identical after trimming trailing whitespace.
 *
 * `expect` records the *current, reviewed* verdict for each case, so this file
 * doubles as a regression gate. Three outcomes are reported distinctly:
 *
 *   - worse than `expect`           → FAIL  (a regression)
 *   - matches `expect: "broken"`    → KNOWN (a documented gap, not a failure)
 *   - better than `expect`          → FIXED (update the expectation)
 *
 * Every case runs under both `strictLineBreaks` settings. The flag mirrors one
 * vault setting and is threaded into *both* directions from `vaultConfig` in
 * production, so a mixed pair is not a configuration that can occur — passing
 * different values to md2html and html2md is what previously made `<br>`
 * handling look broken when it was not.
 *
 * Usage:
 *   node scripts/test-obsidian-syntax.mjs                # full matrix
 *   node scripts/test-obsidian-syntax.mjs callout embed  # filter by id/name
 *   node scripts/test-obsidian-syntax.mjs --verbose      # dump HTML + MD
 *   node scripts/test-obsidian-syntax.mjs --all          # list passes too
 */
// @ts-ignore
import { ConvertService } from "worker/services/convert";

const convert = new ConvertService();

/* ================================================================ */
/*  Case model                                                      */
/* ================================================================ */

type Verdict = "VERBATIM" | "CANONICAL" | "BROKEN" | "DRIFT";

/** The best verdict this case is currently known to reach. */
type Expect = "verbatim" | "canonical" | "broken";

interface BaseCase {
    /** Filter key. */
    id: string;
    /** Human-readable name, as it appears in the report. */
    name: string;
    /** Compact display form of the syntax, for the summary table. */
    syntax: string;
    /** Reviewed current behaviour — see the header. */
    expect: Expect;
    /**
     * Why a case is `expect: "broken"`. The distinction is the whole point of
     * recording it:
     *
     *   "by-design"  Zotero's note schema cannot carry the construct. Nothing
     *                to fix here — the loss is a property of the destination.
     *   "bug"        The pipeline could preserve it and does not. A real gap,
     *                listed separately so it does not hide among the former.
     */
    gap?: "by-design" | "bug";
    /**
     * Substrings that must appear in the round-tripped markdown for the
     * syntax to count as having survived. Checked only when the output is
     * not byte-identical, i.e. to separate CANONICAL from BROKEN.
     */
    mustKeep?: string[];
    /** Substrings whose presence means the syntax was mangled. */
    mustNotHave?: string[];
    /** Why this case exists, or why it is expected to be broken. */
    note?: string;
}

/**
 * A case declares its source format, and that choice picks the direction.
 *
 *   `md`    Obsidian authored it.  md → html → md → html → md
 *   `html`  Zotero authored it.    html → md → html → md → html
 *
 * Both directions matter and they are not mirror images. A note written in
 * Obsidian and synced up exercises the first; a note written in Zotero's own
 * editor and pulled down exercises the second, and only that one sees real
 * citation payloads, annotation spans, styled tables and the wrapper div.
 *
 * The union makes the two mutually exclusive rather than leaving a `source`
 * field whose meaning depends on a sibling flag.
 */
type Case = BaseCase &
    ({ md: string; html?: never } | { html: string; md?: never });

/** Source text and the direction it implies. */
function sourceOf(c: Case): { text: string; from: "md" | "html" } {
    return c.md !== undefined
        ? { text: c.md, from: "md" }
        : { text: c.html!, from: "html" };
}

const GROUPS: { group: string; cases: Case[] }[] = [];
function group(name: string, cases: Case[]) {
    GROUPS.push({ group: name, cases });
}

/* ================================================================ */
/*  1. Obsidian internal links                                      */
/* ================================================================ */

group("Internal links", [
    {
        id: "wikilink-plain",
        name: "WikiLink",
        syntax: "[[Note]]",
        md: `See [[Three laws of motion]] for details.`,
        expect: "verbatim",
        mustKeep: ["[[Three laws of motion]]"],
        mustNotHave: ["\\["],
    },
    {
        id: "wikilink-alias",
        name: "WikiLink with alias",
        syntax: "[[Note|alias]]",
        md: `See [[Three laws of motion|the laws]] for details.`,
        expect: "verbatim",
        mustKeep: ["[[Three laws of motion|the laws]]"],
        mustNotHave: ["\\["],
    },
    {
        id: "wikilink-heading",
        name: "WikiLink to heading",
        syntax: "[[Note#Heading]]",
        md: `Jump to [[Note#Second law]] now.`,
        expect: "verbatim",
        mustKeep: ["[[Note#Second law]]"],
        mustNotHave: ["\\["],
    },
    {
        id: "wikilink-subheading",
        name: "WikiLink to nested heading",
        syntax: "[[Note#A#B]]",
        md: `Jump to [[Note#Chapter#Section]] now.`,
        expect: "verbatim",
        mustKeep: ["[[Note#Chapter#Section]]"],
    },
    {
        id: "wikilink-block",
        name: "WikiLink to block",
        syntax: "[[Note#^blockid]]",
        md: `Quote [[Note#^quote-of-the-day]] here.`,
        expect: "verbatim",
        mustKeep: ["[[Note#^quote-of-the-day]]"],
        mustNotHave: ["\\["],
    },
    {
        id: "wikilink-same-file",
        name: "WikiLink within file",
        syntax: "[[#Heading]]",
        md: `Back to [[#Introduction]] and [[#^abc123]].`,
        expect: "verbatim",
        mustKeep: ["[[#Introduction]]", "[[#^abc123]]"],
    },
    {
        id: "wikilink-heading-alias",
        name: "WikiLink heading + alias",
        syntax: "[[Note#H|alias]]",
        md: `See [[Note#Second law|the second law]].`,
        expect: "verbatim",
        mustKeep: ["[[Note#Second law|the second law]]"],
    },
    {
        id: "wikilink-in-list",
        name: "WikiLink in list item",
        syntax: "- [[Note]]",
        md: `- Refers to [[Alpha]]
- Refers to [[Beta|Gamma]]`,
        expect: "canonical",
        mustKeep: ["[[Alpha]]", "[[Beta|Gamma]]"],
        mustNotHave: ["\\["],
        note: "Bullet marker is canonicalized `-` → `*`.",
    },
    {
        id: "wikilink-in-table",
        name: "WikiLink in table cell",
        syntax: "| [[Note]] |",
        md: `| Ref | Note |
| --- | --- |
| [[Alpha]] | text |`,
        expect: "canonical",
        mustKeep: ["[[Alpha]]"],
        note: "Tables serialize through a nested toMarkdown call — checks that the obsidianRaw handler is reachable from there at all.",
    },
    {
        id: "wikilink-alias-in-table",
        name: "Aliased WikiLink in table cell",
        syntax: "| [[A\\|B]] |",
        md: `| Ref | Note |
| --- | --- |
| [[Beta\\|Gamma]] | more |`,
        expect: "canonical",
        mustKeep: ["[[Beta\\|Gamma]]"],
        note:
            "Corruption regression guard. `obsidianRaw` emits its value " +
            "verbatim to bypass the `[` escape, which is right everywhere " +
            "except inside a table row, where an unescaped `|` is a column " +
            "separator. That produced markdown the next parse read as two " +
            "cells — `| \\[\\[Beta | Gamma]] |` — destroying the link, " +
            "writing the damage back to Zotero, and mutating the row again on " +
            "every sync. The handler now escapes `|` when `state.stack` says " +
            "it is in a cell.",
    },
    {
        id: "wikilink-punctuation",
        name: "WikiLink with punctuation in target",
        syntax: "[[a&b_c*d]]",
        md: `See [[A&B]] and [[a_b_c]] and [[q~r]] and [[p(1)]].`,
        expect: "verbatim",
        mustKeep: ["[[A&B]]", "[[a_b_c]]", "[[q~r]]", "[[p(1)]]"],
        mustNotHave: ["\\&", "\\_", "\\~", "\\("],
        note: "Adversarial guard for the escape policy. A wikilink target is matched literally by Obsidian, so any backslash inserted into it breaks resolution — `[[A\\&B]]` does not find the note `A&B`. These must stay bare even though `state.unsafe` declares several of them risky in phrasing, which is why the escape bypass cannot simply be dropped.",
    },
    {
        id: "wikilink-emphasis-in-target",
        name: "WikiLink with emphasis chars in target",
        syntax: "[[x*y*z]]",
        md: `See [[x*y*z]] here.`,
        expect: "broken",
        gap: "bug",
        mustKeep: ["[[x*y*z]]"],
        note: "Not an escaping problem, and not fixable at the level the other cases live at. `md2html` parses `*y*` as emphasis, so the wikilink arrives back as three siblings — text `[[x`, an `emphasis`, text `z]]` — and a scanner that works inside one text node at a time can never reassemble it. Only a real micromark construct for `[[…]]`, which would out-rank emphasis during tokenization, fixes this class. Underscores are safe by contrast (`[[a_b_c]]`) because CommonMark does not allow intraword `_` emphasis.",
    },
    {
        id: "wikilink-in-heading",
        name: "WikiLink in heading",
        syntax: "# [[Note]]",
        md: `## See also [[Alpha]]`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]"],
    },
    {
        id: "wikilink-in-blockquote",
        name: "WikiLink in blockquote",
        syntax: "> [[Note]]",
        md: `> Quoting [[Alpha]] here.`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]"],
    },
    {
        id: "wikilink-adjacent",
        name: "Adjacent WikiLinks",
        syntax: "[[A]][[B]]",
        md: `Chained [[Alpha]][[Beta]] together.`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]][[Beta]]"],
    },
    {
        id: "wikilink-line-breaks",
        name: "WikiLink on its own line",
        syntax: "\\n[[A]]\\n",
        md: `123
[[link]]
123`,
        expect: "verbatim",
        mustKeep: ["[[link]]"],
        note: "Regression case: a trailing newline next to a raw node used to be collapsed to a space by the safe() pass.",
    },
    {
        id: "wikilink-bold",
        name: "WikiLink inside bold",
        syntax: "**[[A]]**",
        md: `A **[[Alpha]]** link.`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]"],
    },
]);

/* ================================================================ */
/*  2. Embeds                                                       */
/* ================================================================ */

group("Embeds", [
    {
        id: "embed-note",
        name: "Embed note",
        syntax: "![[Note]]",
        md: `![[Three laws of motion]]`,
        expect: "verbatim",
        mustKeep: ["![[Three laws of motion]]"],
        note: "Preserved as literal text. The previous one-way expansion to `![](…)` cost the syntax permanently and bought nothing: the destination is a vault-relative path Zotero cannot resolve, so it was a broken image there either way.",
    },
    {
        id: "embed-heading",
        name: "Embed note section",
        syntax: "![[Note#Heading]]",
        md: `![[Three laws of motion#Second law]]`,
        expect: "verbatim",
        mustKeep: ["![[Three laws of motion#Second law]]"],
    },
    {
        id: "embed-block",
        name: "Embed block",
        syntax: "![[Note#^id]]",
        md: `![[Three laws of motion#^quote-of-the-day]]`,
        expect: "verbatim",
        mustKeep: ["![[Three laws of motion#^quote-of-the-day]]"],
    },
    {
        id: "embed-image",
        name: "Embed image",
        syntax: "![[image.png]]",
        md: `![[Engelbart.jpg]]`,
        expect: "verbatim",
        mustKeep: ["![[Engelbart.jpg]]"],
    },
    {
        id: "embed-image-width",
        name: "Embed image with width",
        syntax: "![[img.png|100]]",
        md: `![[Engelbart.jpg|100]]`,
        expect: "verbatim",
        mustKeep: ["![[Engelbart.jpg|100]]"],
        note: "The sizing hint had no place to go in `![](…)` form — the `|` was percent-encoded into the `src` as `%7C`, mangling the path on top of losing the syntax.",
    },
    {
        id: "embed-image-dims",
        name: "Embed image with dimensions",
        syntax: "![[img.png|100x145]]",
        md: `![[Engelbart.jpg|100x145]]`,
        expect: "verbatim",
        mustKeep: ["![[Engelbart.jpg|100x145]]"],
    },
    {
        id: "embed-pdf-page",
        name: "Embed PDF at page",
        syntax: "![[doc.pdf#page=3]]",
        md: `![[Lecture notes.pdf#page=3]]`,
        expect: "verbatim",
        mustKeep: ["![[Lecture notes.pdf#page=3]]"],
    },
    {
        id: "embed-audio",
        name: "Embed audio",
        syntax: "![[audio.mp3]]",
        md: `![[Recording.mp3]]`,
        expect: "verbatim",
        mustKeep: ["![[Recording.mp3]]"],
    },
    {
        id: "embed-in-list",
        name: "Embed in list item",
        syntax: "- ![[Note]]",
        md: `- ![[Alpha]]`,
        expect: "canonical",
        mustKeep: ["![[Alpha]]"],
    },
]);

/* ================================================================ */
/*  3. Callouts                                                     */
/* ================================================================ */

group("Callouts", [
    {
        id: "callout-basic",
        name: "Callout",
        syntax: "> [!note]",
        md: `> [!note]
> Lorem ipsum dolor sit amet.`,
        expect: "verbatim",
        mustKeep: ["> [!note]"],
        mustNotHave: ["\\[!"],
        note: "Was never a schema limit — a callout is an ordinary blockquote whose first line starts with `[!`, and the marker reaches Zotero intact. Only the return leg escaped it to `\\[!note]`, which Obsidian stops recognizing. `features/callout.ts` now claims the marker as `obsidianRaw`.",
    },
    {
        id: "callout-title",
        name: "Callout with title",
        syntax: "> [!tip] Title",
        md: `> [!tip] Callouts can have custom titles
> Like this one.`,
        expect: "verbatim",
        mustKeep: ["> [!tip] Callouts can have custom titles"],
        mustNotHave: ["\\[!"],
    },
    {
        id: "callout-foldable-closed",
        name: "Foldable callout (closed)",
        syntax: "> [!faq]-",
        md: `> [!faq]- Are callouts foldable?
> Yes! In a foldable callout.`,
        expect: "verbatim",
        mustKeep: ["> [!faq]-"],
        mustNotHave: ["\\[!"],
    },
    {
        id: "callout-foldable-open",
        name: "Foldable callout (open)",
        syntax: "> [!faq]+",
        md: `> [!faq]+ Are callouts foldable?
> Yes! In a foldable callout.`,
        expect: "verbatim",
        mustKeep: ["> [!faq]+"],
        mustNotHave: ["\\[!"],
    },
    {
        id: "callout-nested",
        name: "Nested callouts",
        syntax: "> > [!todo]",
        md: `> [!question] Outer
> > [!todo] Inner
> > > [!example] Innermost`,
        expect: "canonical",
        mustKeep: ["[!question]", "[!todo]", "[!example]"],
        mustNotHave: ["\\[!"],
    },
    {
        id: "callout-with-content",
        name: "Callout with rich content",
        syntax: "> [!info] + list",
        md: `> [!info] Contents
> - one
> - two
>
> Trailing paragraph.`,
        expect: "canonical",
        mustKeep: ["[!info] Contents"],
        mustNotHave: ["\\[!"],
    },
    {
        id: "callout-all-types",
        name: "Callout type keywords",
        syntax: "[!abstract] …",
        md: `> [!abstract]
> a

> [!success]
> b

> [!danger]
> c

> [!bug]
> d

> [!quote]
> e`,
        expect: "verbatim",
        mustKeep: ["[!abstract]", "[!success]", "[!danger]", "[!bug]", "[!quote]"],
        mustNotHave: ["\\[!"],
    },
]);

/* ================================================================ */
/*  4. Footnotes                                                    */
/* ================================================================ */

group("Footnotes", [
    {
        id: "footnote-numeric",
        name: "Footnote",
        syntax: "[^1]",
        md: `You can add footnotes[^1] to your notes.

[^1]: This is a footnote.`,
        expect: "verbatim",
        mustKeep: ["[^1]", "[^1]: This is a footnote."],
        mustNotHave: ["\\[^", "<sup", "data-footnotes"],
        note: "GFM footnote parsing is deliberately not composed in (gfm.ts), so these stay literal text.",
    },
    {
        id: "footnote-named",
        name: "Named footnote",
        syntax: "[^label]",
        md: `Named footnotes[^note] keep their label.

[^note]: The label is not rendered.`,
        expect: "verbatim",
        mustKeep: ["[^note]", "[^note]: The label is not rendered."],
        mustNotHave: ["\\[^"],
    },
    {
        id: "footnote-inline",
        name: "Inline footnote",
        syntax: "^[text]",
        md: `You can also use inline footnotes.^[This is an inline footnote.]`,
        expect: "verbatim",
        mustKeep: ["^[This is an inline footnote.]"],
        mustNotHave: ["^\\["],
        note: "Used to come back as `^\\[…]`: the old pattern matched `[^id]` but not `^[text]`, leaving the `[` to the escape pass. The scanner now claims it, including a nested `[[…]]` in the footnote body.",
    },
    {
        id: "footnote-multiblock",
        name: "Multi-paragraph footnote",
        syntax: "[^1]: multi-line",
        md: `Text with a long footnote[^big].

[^big]: First paragraph.

    Second indented paragraph.`,
        expect: "canonical",
        mustKeep: ["[^big]"],
        note: "The indented continuation is not footnote syntax to this parser; it is an indented code block.",
    },
    {
        id: "footnote-in-list",
        name: "Footnote ref in list",
        syntax: "- text[^1]",
        md: `- item one[^a]
- item two[^b]`,
        expect: "canonical",
        mustKeep: ["[^a]", "[^b]"],
        mustNotHave: ["\\[^"],
    },
]);

/* ================================================================ */
/*  5. Tags, block IDs, comments                                    */
/* ================================================================ */

group("Tags, block IDs, comments", [
    {
        id: "tag-inline",
        name: "Tag (inline)",
        syntax: "#tag",
        md: `This note is about #philosophy and #science.`,
        expect: "verbatim",
        mustKeep: ["#philosophy", "#science"],
        mustNotHave: ["\\#"],
    },
    {
        id: "tag-line-start",
        name: "Tag at line start",
        syntax: "#tag (line start)",
        md: `#philosophy

Some body text.`,
        expect: "verbatim",
        mustKeep: ["#philosophy"],
        mustNotHave: ["\\#"],
        note: "Used to come back as `\\#philosophy` — literal text in Obsidian, not a tag. Only column 0 was affected (an inline `#tag` was always fine, see tag-inline) because the serializer escapes `#` at a break to stop it becoming an ATX heading. `#philosophy` cannot be one: CommonMark requires whitespace after the hashes.",
    },
    {
        id: "tag-vs-heading-escape",
        name: "Escaped literal hash",
        syntax: "\\# not a heading",
        md: `\\# this is not a heading

\\## nor this`,
        expect: "verbatim",
        mustKeep: ["\\# this is not a heading", "\\## nor this"],
        note: "The other side of tag-line-start, and the reason the tag claim is derived from CommonMark's heading rule rather than from Obsidian's tag grammar: a `#` that IS followed by whitespace must keep its backslash, or the next parse turns the line into a heading.",
    },
    {
        id: "tag-after-soft-break",
        name: "Tag after a soft line break",
        syntax: "text\\n#tag",
        md: `first line
#philosophy on the next`,
        expect: "verbatim",
        mustKeep: ["#philosophy"],
        mustNotHave: ["\\#"],
        note: "`newlines: true` keeps the break inside one text node, so the `#` sits after a `\\n` rather than at offset 0 — the escape fires there too.",
    },
    {
        id: "tag-nested",
        name: "Nested tag",
        syntax: "#a/b/c",
        md: `Filed under #inbox/to-read/urgent today.`,
        expect: "verbatim",
        mustKeep: ["#inbox/to-read/urgent"],
    },
    {
        id: "tag-in-list",
        name: "Tag in list item",
        syntax: "- #tag",
        md: `- #todo review this
- #done finished`,
        expect: "canonical",
        mustKeep: ["#todo", "#done"],
        mustNotHave: ["\\#"],
        note: "Same escape as tag-line-start: a list item's text also begins at the start of a line. Only the bullet marker canonicalizes now.",
    },
    {
        id: "block-id",
        name: "Block identifier",
        syntax: "^blockid",
        md: `This is a quotable paragraph. ^quote-of-the-day`,
        expect: "verbatim",
        mustKeep: ["^quote-of-the-day"],
    },
    {
        id: "block-id-own-line",
        name: "Block ID after list",
        syntax: "^id (own line)",
        md: `- one
- two

^my-list-id`,
        expect: "canonical",
        mustKeep: ["^my-list-id"],
    },
    {
        id: "comment-block",
        name: "Comment (block)",
        syntax: "%%\\n…\\n%%",
        md: `Visible text.

%%
This is a block comment.
%%`,
        expect: "verbatim",
        mustKeep: ["Visible text."],
        note: "`%%` has no HTML representation; the comment body survives as literal text rather than being stripped.",
    },
    {
        id: "comment-inline",
        name: "Comment (inline)",
        syntax: "%%…%%",
        md: `Here is some %%hidden%% text.`,
        expect: "verbatim",
        mustKeep: ["%%hidden%%"],
    },
    {
        id: "comment-html",
        name: "HTML comment",
        syntax: "<!-- … -->",
        md: `Before.

<!-- an html comment -->

After.`,
        expect: "verbatim",
        mustKeep: ["Before.", "After."],
        note: "Overlaps ZF_NOTE_META / ZF_*_BEG marker territory — a stray comment must not be mistaken for one.",
    },
]);

/* ================================================================ */
/*  6. Tasks                                                        */
/* ================================================================ */

group("Tasks", [
    {
        id: "task-basic",
        name: "Task list",
        syntax: "- [ ] / - [x]",
        md: `- [x] This is a completed task.
- [ ] This is an incomplete task.`,
        expect: "canonical",
        mustKeep: ["[x] This is a completed task.", "[ ] This is an incomplete task."],
        note: "Zotero's schema drops `<input type=checkbox>`, so the marker is carried as literal text. Bullet canonicalizes `-` → `*`.",
    },
    {
        id: "task-nested",
        name: "Nested tasks",
        syntax: "  - [ ] nested",
        md: `- [ ] parent
    - [x] child
    - [ ] sibling`,
        expect: "canonical",
        mustKeep: ["[ ] parent", "[x] child"],
    },
    {
        id: "task-custom-status",
        name: "Custom checkbox status",
        syntax: "- [/] - [?] - [!]",
        md: `- [/] in progress
- [?] question
- [!] important
- [-] cancelled
- [>] deferred`,
        expect: "canonical",
        mustKeep: ["[/] in progress", "[?] question", "[!] important", "[-] cancelled", "[>] deferred"],
        note: "Community-plugin statuses. Not GFM task items, so these ride through as plain text — the risk is `[` being escaped.",
    },
    {
        id: "task-with-wikilink",
        name: "Task containing a WikiLink",
        syntax: "- [ ] [[Note]]",
        md: `- [ ] Read [[Three laws of motion]]
- [x] Read [[Optics|Newton's Optics]]`,
        expect: "canonical",
        mustKeep: ["[ ] Read [[Three laws of motion]]", "[x] Read [[Optics|Newton's Optics]]"],
        note: "Two features claim the same list item — task-list rewrites the leading text node, obsidian-syntax splits it.",
    },
    {
        id: "task-empty",
        name: "Empty task",
        syntax: "- [ ]",
        md: `- [ ]
- [x]`,
        expect: "canonical",
        mustKeep: ["[ ]", "[x]"],
        note: "Stripping the marker empties the paragraph — checks the stray-empty-paragraph guard.",
    },
    {
        id: "task-with-tag",
        name: "Task with tag and due date",
        syntax: "- [ ] #tag 📅",
        md: `- [ ] Submit report #work 📅 2026-08-01`,
        expect: "canonical",
        mustKeep: ["[ ] Submit report #work 📅 2026-08-01"],
    },
]);

/* ================================================================ */
/*  7. Links and images (CommonMark surface)                        */
/* ================================================================ */

group("Links and images", [
    {
        id: "link-inline",
        name: "Inline link",
        syntax: "[text](url)",
        md: `[Obsidian Help](https://help.obsidian.md) is useful.`,
        expect: "verbatim",
        mustKeep: ["[Obsidian Help](https://help.obsidian.md)"],
    },
    {
        id: "link-title",
        name: "Link with title",
        syntax: '[t](url "title")',
        md: `[Help](https://help.obsidian.md "The manual") here.`,
        expect: "verbatim",
        mustKeep: ["https://help.obsidian.md"],
        note: "The `title` attribute may not survive the Zotero schema.",
    },
    {
        id: "link-relative",
        name: "Relative markdown link",
        syntax: "[t](Note.md)",
        md: `See [the note](Three%20laws%20of%20motion.md) for details.`,
        expect: "verbatim",
        mustKeep: ["Three%20laws%20of%20motion.md"],
    },
    {
        id: "link-angle-dest",
        name: "Link with spaces in <>",
        syntax: "[t](<a b.md>)",
        md: `See [the note](<Three laws of motion.md>) here.`,
        expect: "canonical",
        mustKeep: ["Three"],
        note: "Angle-bracket destinations are re-serialized as percent-encoded.",
    },
    {
        id: "link-obsidian-uri",
        name: "obsidian:// URI",
        syntax: "[t](obsidian://…)",
        md: `[Note](obsidian://open?vault=MainVault&file=Note.md)`,
        expect: "verbatim",
        mustKeep: ["obsidian://open"],
        note: "The `&` must not re-encode on every pass — that would be drift.",
    },
    {
        id: "link-autolink",
        name: "Autolink",
        syntax: "<https://…>",
        md: `Visit <https://example.com> today.`,
        expect: "canonical",
        mustKeep: ["https://example.com"],
    },
    {
        id: "link-bare",
        name: "Bare URL",
        syntax: "https://…",
        md: `plain https://example.com text

params https://example.com/?a=1&b=2 here

bare www.example.com site`,
        expect: "verbatim",
        mustKeep: ["plain https://example.com text", "https://example.com/?a=1&b=2", "www.example.com"],
        mustNotHave: ["<https://example.com>"],
    },
    {
        id: "link-reference",
        name: "Reference link",
        syntax: "[t][ref]",
        md: `See [the manual][manual] for details.

[manual]: https://help.obsidian.md`,
        expect: "canonical",
        mustKeep: ["https://help.obsidian.md"],
        note: "Reference definitions have no HTML form; they collapse to inline links.",
    },
    {
        id: "image-external",
        name: "External image",
        syntax: "![alt](url)",
        md: `![Engelbart](https://example.com/photo.jpg)`,
        expect: "verbatim",
        mustKeep: ["https://example.com/photo.jpg"],
    },
    {
        id: "image-sized",
        name: "Image with size in alt",
        syntax: "![alt|100x160](url)",
        md: `![Engelbart|120x160](https://example.com/photo.jpg)`,
        expect: "verbatim",
        mustKeep: ["120x160", "https://example.com/photo.jpg"],
    },
    {
        id: "link-in-emphasis",
        name: "Link inside emphasis",
        syntax: "*[t](u)*",
        md: `An *[italic link](https://example.com)* here.`,
        expect: "verbatim",
        mustKeep: ["[italic link](https://example.com)"],
    },
    {
        id: "link-underscore-url",
        name: "URL with underscores",
        syntax: "[t](a_b_c)",
        md: `See [file](https://example.com/a_b_c_d.pdf) here.`,
        expect: "verbatim",
        mustKeep: ["https://example.com/a_b_c_d.pdf"],
        note: "Underscores in a destination must not be read as emphasis or grow escapes.",
    },
]);

/* ================================================================ */
/*  8. Obsidian formatting extensions                               */
/* ================================================================ */

group("Formatting", [
    {
        id: "highlight",
        name: "Highlight",
        syntax: "==text==",
        md: `This is ==highlighted text== here.`,
        expect: "verbatim",
        mustKeep: ["==highlighted text=="],
        note: "Obsidian-only, and nothing maps `==` onto Zotero's highlight span — but `=` is not escaped by the serializer, so the markers survive as literal text and Obsidian re-recognizes them.",
    },
    {
        id: "bold-italic",
        name: "Bold / italic",
        syntax: "** * ***",
        md: `**Bold text** and *italic text* and ***bold italic***.`,
        expect: "verbatim",
        mustKeep: ["**Bold text**", "*italic text*"],
    },
    {
        id: "underscore-emphasis",
        name: "Underscore emphasis",
        syntax: "__b__ _i_",
        md: `__Bold with underscores__ and _italic with underscores_.`,
        expect: "canonical",
        mustKeep: ["Bold with underscores", "italic with underscores"],
        note: "Canonicalized to `*`-based markers.",
    },
    {
        id: "strikethrough",
        name: "Strikethrough",
        syntax: "~~text~~",
        md: `~~Striked out text~~`,
        expect: "verbatim",
        mustKeep: ["~~Striked out text~~"],
    },
    {
        id: "inline-code",
        name: "Inline code",
        syntax: "`code`",
        md: "Text inside `backticks` on a line.",
        expect: "verbatim",
        mustKeep: ["`backticks`"],
    },
    {
        id: "inline-code-syntax",
        name: "Markdown syntax inside inline code",
        syntax: "`[[a]]` `[^1]`",
        md: "Literal `[[wikilink]]`, `[^1]`, `- [x]` and `![[embed]]` in code.",
        expect: "verbatim",
        mustKeep: ["`[[wikilink]]`", "`[^1]`", "`- [x]`", "`![[embed]]`"],
        note: "Regression case for the whole-string-regex corruption: these must be untouched inside inline code.",
    },
    {
        id: "html-inline-marks",
        name: "Inline HTML marks",
        syntax: "<u> <sub> <sup>",
        md: `H<sub>2</sub>O and E=mc<sup>2</sup> and <u>underlined</u>.`,
        expect: "verbatim",
        mustKeep: ["<sub>2</sub>", "<sup>2</sup>", "<u>underlined</u>"],
    },
    {
        id: "html-nested-mark",
        name: "Nested mark inside <u>",
        syntax: "<u><a>…</a></u>",
        md: `<u>[a link](https://example.com)</u> and <u>**bold**</u>.`,
        expect: "verbatim",
        mustKeep: ["https://example.com"],
        note: "Regression case: `<u>` used to flatten to text and drop the URL.",
    },
    {
        id: "escapes",
        name: "Backslash escapes",
        syntax: "\\* \\_ \\[",
        md: `Literal \\*asterisks\\*, \\_underscores\\_ and \\[brackets\\].`,
        expect: "canonical",
        mustKeep: ["asterisks", "underscores", "brackets"],
        note: "Escapes must not accumulate backslashes across passes — that is the classic drift signature.",
    },
    {
        id: "entities",
        name: "HTML entities",
        syntax: "&amp; &nbsp;",
        md: `AT&amp;T and non&nbsp;breaking space.`,
        expect: "canonical",
        mustKeep: ["AT\\&T"],
        note: "`&amp;` resolves to `\\&` and `&nbsp;` to U+00A0. Both are correct and, more importantly, resolve exactly once — an entity that re-encoded on every pass would be drift.",
    },
    {
        id: "hard-break-spaces",
        name: "Hard break (two spaces)",
        syntax: "line␣␣\\n",
        md: `First line
Second line`,
        expect: "verbatim",
        mustKeep: ["First line", "Second line"],
    },
    {
        id: "hard-break-backslash",
        name: "Hard break (backslash)",
        syntax: "line\\\\\\n",
        md: `First line\\
Second line`,
        expect: "canonical",
        mustKeep: ["First line", "Second line"],
    },
]);

/* ================================================================ */
/*  9. Blocks                                                       */
/* ================================================================ */

group("Blocks", [
    {
        id: "headings",
        name: "Headings h1–h6",
        syntax: "# … ######",
        md: `# H1

## H2

### H3

#### H4

##### H5

###### H6`,
        expect: "verbatim",
        mustKeep: ["# H1", "###### H6"],
    },
    {
        id: "heading-setext",
        name: "Setext heading",
        syntax: "===== / -----",
        md: `Title
=====

Subtitle
--------`,
        expect: "canonical",
        mustKeep: ["Title", "Subtitle"],
        note: "Canonicalized to ATX form.",
    },
    {
        id: "blockquote",
        name: "Blockquote",
        syntax: "> quote",
        md: `> Human beings face ever more complex problems.
>
> Second paragraph in quote.`,
        expect: "verbatim",
        mustKeep: ["> Human beings"],
    },
    {
        id: "blockquote-nested",
        name: "Nested blockquote",
        syntax: "> > quote",
        md: `> outer
> > inner`,
        expect: "canonical",
        mustKeep: ["outer", "inner"],
    },
    {
        id: "code-fence",
        name: "Fenced code block",
        syntax: "```lang",
        md: "```js\nfunction f(arg) {\n  return arg;\n}\n```",
        expect: "broken",
        gap: "by-design",
        mustKeep: ["```js", "function f(arg)"],
        note: "The fence body survives exactly; the `js` info string does not. Zotero's `codeBlock` schema has no language attribute, so there is nowhere to put it (see features/code-block.ts).",
    },
    {
        id: "code-fence-syntax",
        name: "Markdown syntax inside a fence",
        syntax: "``` [[a]] [^1]",
        md: "```markdown\n[[wikilink]]\n[^1]: footnote\n- [x] task\n![[embed]]\n> [!note]\n```",
        expect: "canonical",
        mustKeep: ["[[wikilink]]", "[^1]: footnote", "- [x] task", "![[embed]]", "> [!note]"],
        note: "The headline regression case. Whole-string regexes used to rewrite every one of these inside the fence and the damage was written back to Zotero. All five must survive byte-for-byte; only the `markdown` info string is lost (see code-fence).",
    },
    {
        id: "code-fence-nested",
        name: "Nested fences",
        syntax: "````",
        md: "````\n```\ncd ~/Desktop\n```\n````",
        expect: "verbatim",
        mustKeep: ["```"],
    },
    {
        id: "code-indented",
        name: "Indented code block",
        syntax: "    code",
        md: `Paragraph.

    indented code
    second line`,
        expect: "canonical",
        mustKeep: ["indented code"],
    },
    {
        id: "mermaid",
        name: "Mermaid diagram",
        syntax: "```mermaid",
        md: "```mermaid\ngraph TD\nA --> B\n```",
        expect: "broken",
        gap: "by-design",
        mustKeep: ["```mermaid", "A --> B"],
        note: "Same info-string loss as code-fence, but with a visible consequence: without the `mermaid` tag Obsidian renders the diagram source as a plain code block instead of a diagram.",
    },
    {
        id: "hr",
        name: "Horizontal rule",
        syntax: "--- / *** / ___",
        md: `Before

---

After`,
        expect: "canonical",
        mustKeep: ["***"],
        note: "The marker canonicalizes `---` → `***`; both are the same thematic break.",
    },
    {
        id: "list-unordered",
        name: "Unordered list",
        syntax: "- item",
        md: `- First
- Second
- Third`,
        expect: "canonical",
        mustKeep: ["First", "Second", "Third"],
        note: "Bullet marker canonicalizes `-` → `*`.",
    },
    {
        id: "list-ordered",
        name: "Ordered list",
        syntax: "1. item",
        md: `1. First
2. Second
3. Third`,
        expect: "verbatim",
        mustKeep: ["1. First"],
    },
    {
        id: "list-ordered-start",
        name: "Ordered list with offset start",
        syntax: "5. item",
        md: `5. Fifth
6. Sixth`,
        expect: "verbatim",
        mustKeep: ["Fifth", "Sixth"],
        note: "Zotero's schema may not carry the `start` attribute.",
    },
    {
        id: "list-nested-mixed",
        name: "Nested mixed list",
        syntax: "1. / - nested",
        md: `1. First
    1. Ordered nested
2. Second
    - Unordered nested`,
        expect: "canonical",
        mustKeep: ["Ordered nested", "Unordered nested"],
    },
    {
        id: "list-loose",
        name: "Loose list",
        syntax: "- a\\n\\n- b",
        md: `- First item

- Second item`,
        expect: "canonical",
        mustKeep: ["First item", "Second item"],
    },
    {
        id: "list-multi-para",
        name: "List item with two paragraphs",
        syntax: "- a\\n\\n  b",
        md: `- First paragraph

    Second paragraph in the same item.`,
        expect: "canonical",
        mustKeep: ["First paragraph", "Second paragraph in the same item."],
    },
    {
        id: "list-with-code",
        name: "List item containing a fence",
        syntax: "- ```",
        md: "- item with code\n\n    ```js\n    const a = 1;\n    ```",
        expect: "canonical",
        mustKeep: ["const a = 1;"],
    },
]);

/* ================================================================ */
/*  10. Tables                                                      */
/* ================================================================ */

group("Tables", [
    {
        id: "table-basic",
        name: "Table",
        syntax: "| a | b |",
        md: `| First name | Last name |
| ---------- | --------- |
| Max        | Planck    |`,
        expect: "verbatim",
        mustKeep: ["Max", "Planck"],
    },
    {
        id: "table-alignment",
        name: "Table alignment",
        syntax: "| :-- | :-: | --: |",
        md: `| Left | Center | Right |
| :--- | :----: | ----: |
| L    |   C    |     R |`,
        expect: "canonical",
        mustKeep: [":-", "-:"],
    },
    {
        id: "table-formatted",
        name: "Table with inline formatting",
        syntax: "| **b** | `c` |",
        md: `| A | B |
| --- | --- |
| [Link](https://example.com) | **bold** and *italic* |
| ~~strike~~ | \`code\` |`,
        expect: "canonical",
        mustKeep: ["[Link](https://example.com)", "~~strike~~"],
    },
    {
        id: "table-escaped-pipe",
        name: "Escaped pipe in cell",
        syntax: "| a \\| b |",
        md: `| Col | Value |
| --- | --- |
| pipe | a \\| b |`,
        expect: "canonical",
        mustKeep: ["a \\| b"],
        note: "The escape must survive without accumulating backslashes.",
    },
    {
        id: "table-break-plain",
        name: "Line break in cell (control)",
        syntax: "| a<br>b |",
        md: `| A | B |
| --- | --- |
| text<br>plain | b |`,
        expect: "canonical",
        mustKeep: ["text", "plain"],
        note: "Control for the two cases below. A `\\n` is unsafe inside a `tableCell`, and for an ordinary text node `safe()` encodes it as `&#xA;` — the row survives. Any difference in the next two is therefore down to how the content is serialized, not to the line break itself.",
    },
    {
        id: "table-break-wikilink",
        name: "Line break + WikiLink in cell",
        syntax: "| a<br>[[N]] |",
        md: `| A | B |
| --- | --- |
| text<br>[[link]] | b |`,
        expect: "canonical",
        mustKeep: ["[[link]]"],
        note: "The scanner folds an adjacent newline into the `obsidianRaw` value, and that node used to be emitted without consulting `state.unsafe` at all — so the `\\n` reached the cell literally and the next parse split one row into two, moving `b` into a different row. Same family as the alias-pipe bug: a raw emission that ignores the construct it is in.",
    },
    {
        id: "table-break-tag",
        name: "Line break + tag in cell",
        syntax: "| a<br>#t |",
        md: `| A | B |
| --- | --- |
| text<br>#tag | b |`,
        expect: "canonical",
        mustKeep: ["#tag"],
    },
    {
        id: "table-empty-cells",
        name: "Table with empty cells",
        syntax: "|  |  |",
        md: `| A | B |
| --- | --- |
|   | only right |
| only left |   |`,
        expect: "canonical",
        mustKeep: ["only right", "only left"],
    },
]);

/* ================================================================ */
/*  11. Math                                                        */
/* ================================================================ */

group("Math", [
    {
        id: "math-inline",
        name: "Inline math",
        syntax: "$x$",
        md: `This is inline math: $e^{2i\\pi} = 1$.`,
        expect: "verbatim",
        mustKeep: ["$e^{2i\\pi} = 1$"],
    },
    {
        id: "math-display",
        name: "Display math",
        syntax: "$$…$$",
        md: `$$
\\begin{vmatrix}a & b\\\\
c & d
\\end{vmatrix}=ad-bc
$$`,
        expect: "canonical",
        mustKeep: ["$$", "ad-bc"],
    },
    {
        id: "math-dollar-literal",
        name: "Literal dollar sign",
        syntax: "$5 and $10",
        md: `It costs $5 and $10 respectively.`,
        expect: "canonical",
        mustKeep: ["$5", "$10"],
        note: "Two bare dollars on one line are a candidate inline-math span — checks they are not consumed.",
    },
    {
        id: "math-in-list",
        name: "Math in list item",
        syntax: "- $x$",
        md: `- first $a^2$
- second $b^2$`,
        expect: "canonical",
        mustKeep: ["$a^2$", "$b^2$"],
    },
]);

/* ================================================================ */
/*  12. Frontmatter and document-level                              */
/* ================================================================ */

group("Document-level", [
    {
        id: "frontmatter",
        name: "YAML frontmatter",
        syntax: "---\\nkey: v\\n---",
        md: `---
title: My note
tags: [a, b]
---

Body text.`,
        expect: "broken",
        gap: "by-design",
        mustKeep: ["---\ntitle: My note"],
        note: "remark-frontmatter is not composed in, so the block parses as a thematic break plus a paragraph. A Zotero note has nowhere to store frontmatter and ZotFlow handles the vault note's own properties outside the converter, so this is a deliberate non-goal rather than an oversight — recorded here because a hand-edited note body can still contain it.",
    },
    {
        id: "emoji",
        name: "Emoji and CJK",
        syntax: "🚀 中文",
        md: `Emoji 🚀 and 中文字符 and combining é.`,
        expect: "verbatim",
        mustKeep: ["🚀", "中文字符"],
    },
    {
        id: "html-block",
        name: "Raw HTML block",
        syntax: "<div>…</div>",
        md: `Before.

<div align="center">centered</div>

After.`,
        expect: "canonical",
        mustKeep: ["centered"],
    },
    {
        id: "html-br",
        name: "Literal <br>",
        syntax: "<br>",
        md: `First line<br>Second line`,
        expect: "canonical",
        mustKeep: ["First line", "Second line"],
    },
    {
        id: "mixed-document",
        name: "Mixed realistic note",
        syntax: "(everything)",
        md: `# Reading notes

Tagged #reading and linked to [[Source]].

- [x] Read chapter 1
- [ ] Read chapter 2

> [!note] Key idea
> The important part.

See the formula $E = mc^2$ and the footnote[^1].

\`\`\`python
x = [[1, 2], [3, 4]]
\`\`\`

[^1]: A note about the source.`,
        expect: "canonical",
        mustKeep: ["#reading", "[[Source]]", "[x] Read chapter 1", "[!note] Key idea", "$E = mc^2$", "[^1]", "x = [[1, 2], [3, 4]]"],
        mustNotHave: ["\\[!"],
        note: "End-to-end case: tag, wikilink, tasks, callout, math, footnote and a `[[1, 2]]` array inside a fence in one document. `mustNotHave` is load-bearing here — `\\[!note] Key idea` still *contains* `[!note] Key idea`, so the mustKeep alone would not notice a re-introduced escape.",
    },
]);

/* ================================================================ */
/*  13. Zotero-authored notes  (html → md → html)                   */
/* ================================================================ */

/** URL-encoded JSON, the shape Zotero stores span payloads in. */
function payload(value: unknown): string {
    return encodeURIComponent(JSON.stringify(value));
}

const ANNOTATION = payload({
    attachmentURI: "http://zotero.org/users/12345/items/ATTACH01",
    annotationKey: "ANNOKEY1",
    color: "#ffd400",
    pageLabel: "5",
    position: { pageIndex: 4, rects: [[1, 2, 3, 4]] },
    citationItem: { uris: ["http://zotero.org/users/12345/items/ITEMKEY1"] },
});

const CITATION = payload({
    citationItems: [
        {
            uris: ["http://zotero.org/users/12345/items/ITEMKEY1"],
            locator: "5",
        },
    ],
    properties: {},
});

group("Zotero-authored notes", [
    {
        id: "zh-wrapper",
        name: "Wrapper div",
        syntax: "<div data-schema-version>",
        html: `<div data-schema-version="9" data-citation-items="%5B%5D"><p>Body text.</p></div>`,
        expect: "verbatim",
        mustKeep: ['data-schema-version="9"', "Body text."],
        note: "The wrapper is lifted into a `ZF_NOTE_META` comment and rebuilt on the way back. Its attributes must survive verbatim — `data-citation-items` can hold the note's entire citation metadata.",
    },
    {
        id: "zh-citation-span",
        name: "Citation span",
        syntax: '<span class="citation">',
        html: `<p>As shown <span class="citation" data-citation="${CITATION}"><span class="citation-item">(Doe, 2020, p. 5)</span></span> here.</p>`,
        expect: "verbatim",
        mustKeep: [`data-citation="${CITATION}"`, "citation-item"],
        note: "The payload is the note's only record of what was cited. It must come back byte-for-byte, nested `citation-item` span included.",
    },
    {
        id: "zh-highlight-span",
        name: "Highlight annotation span",
        syntax: '<span class="highlight">',
        html: `<p><span class="highlight" data-annotation="${ANNOTATION}">quoted text</span> <span class="citation" data-citation="${CITATION}">(Doe, 2020)</span></p>`,
        expect: "verbatim",
        mustKeep: [`data-annotation="${ANNOTATION}"`, "quoted text"],
        note: "Zotero emits a highlight and its citation as adjacent spans. Both payloads must survive, and the whitespace between them must not collapse the pair.",
    },
    {
        id: "zh-underline-annotation",
        name: "Underline WITH data-annotation",
        syntax: '<span class="underline" data-annotation>',
        html: `<p><span class="underline" data-annotation="${ANNOTATION}">underlined quote</span></p>`,
        expect: "verbatim",
        mustKeep: [`data-annotation="${ANNOTATION}"`],
        mustNotHave: ["<u>"],
        note: "Must stay an opaque payload, not become a `<u>` mark. The `data-annotation` attribute is the only thing distinguishing it from a plain underline — see the guard in zotero-payloads.ts.",
    },
    {
        id: "zh-underline-plain",
        name: "Plain <u> without payload",
        syntax: "<u>",
        html: `<p><u>just underlined</u></p>`,
        expect: "verbatim",
        mustKeep: ["<u>just underlined</u>"],
        mustNotHave: ["data-annotation"],
        note: "The other half of zh-underline-annotation: with no payload it is an ordinary mark and must round-trip as `<u>`.",
    },
    {
        id: "zh-colored-text",
        name: "Text colour span",
        syntax: '<span style="color">',
        html: `<p><span style="color: #ff6666">red text</span> and <span style="background-color: #ffd400">highlighted</span></p>`,
        expect: "verbatim",
        mustKeep: ["color: #ff6666", "background-color: #ffd400"],
        note: "Markdown has no colour. Preserved as opaque HTML with reason `colored-text`.",
    },
    {
        id: "zh-strike-span",
        name: "Strike as styled span",
        syntax: "text-decoration: line-through",
        html: `<p><span style="text-decoration: line-through">struck out</span></p>`,
        expect: "verbatim",
        mustKeep: ["line-through", "struck out"],
        note: "Zotero expresses strike as a styled span, not `<del>`. Maps to `~~` and must come back as the span, not as `<del>`.",
    },
    {
        id: "zh-payload-and-strike",
        name: "Annotation payload AND strike style",
        syntax: 'class="highlight" style="…line-through"',
        html: `<p><span class="highlight" data-annotation="${ANNOTATION}" style="text-decoration: line-through">both</span></p>`,
        expect: "verbatim",
        mustKeep: [`data-annotation="${ANNOTATION}"`],
        note: "Ordering guard: `zotero-payloads` is registered before `marks`, so the payload claims this span. If the order flipped, the annotation JSON would be silently dropped in favour of `~~both~~`.",
    },
    {
        id: "zh-math-inline",
        name: "Zotero inline math",
        syntax: '<span class="math">',
        html: `<p>Formula <span class="math">$e^{i\\pi}+1=0$</span> inline.</p>`,
        expect: "verbatim",
        mustKeep: ['class="math"', "e^{i\\pi}+1=0"],
        note: "Ordering guard: `math` is registered before `zotero-payloads` and `span-unwrap`, either of which would otherwise swallow a `<span class=\"math\">`.",
    },
    {
        id: "zh-math-display",
        name: "Zotero display math",
        syntax: '<pre class="math">',
        html: `<pre class="math">$$\\int_0^1 x^2 dx$$</pre>`,
        expect: "verbatim",
        mustKeep: ['<pre class="math">', "\\int_0^1 x^2 dx"],
        note: "A `<pre>` WITH the math class is math; without it, a code block. Both handlers are registered for `pre` and the math one declines via PASS when the class is absent.",
    },
    {
        id: "zh-annotation-image",
        name: "Annotation image",
        syntax: "<img data-attachment-key>",
        html: `<p><img data-attachment-key="IMGKEY01" data-annotation="${ANNOTATION}" width="576"></p>`,
        expect: "canonical",
        mustKeep: ['data-attachment-key="IMGKEY01"', 'width="576"'],
        note: "Every `data-*` attribute Zotero needs rides in the markdown image's alt text. Without a configured folder there is no extracted PNG to point at, so the node serializes as the bare tag.",
    },
    {
        id: "zh-plain-image",
        name: "Plain image (no payload)",
        syntax: "<img src>",
        html: `<p><img src="https://example.com/a.png" alt="cap"></p>`,
        expect: "verbatim",
        mustKeep: ["https://example.com/a.png"],
        note: "The other half of zh-annotation-image: no annotation data means the handler declines and rehype-remark produces an ordinary markdown image.",
    },
    {
        id: "zh-li-spans",
        name: "List items wrapped in spans",
        syntax: "<li><span>",
        html: `<ul><li><span>first</span></li><li><span>second</span></li></ul>`,
        expect: "canonical",
        mustKeep: ["first", "second"],
        note: "The shape Zotero's own editor emits. Round-tripping must reproduce it, or every Zotero-authored list shows a diff on the first sync.",
    },
    {
        id: "zh-td-spans",
        name: "Table cells wrapped in spans",
        syntax: "<td><span>",
        html: `<table><tr><td><span>a</span></td><td><span>b</span></td></tr></table>`,
        expect: "canonical",
        mustKeep: ["a", "b"],
    },
    {
        id: "zh-styled-table",
        name: "Table with cell styles",
        syntax: "<td style>",
        html: `<table><tr><td style="background-color: #ffd400">tinted</td><td>plain</td></tr></table>`,
        expect: "canonical",
        mustKeep: ["background-color: #ffd400", "tinted"],
        note: "GFM has no cell styling, so a styled table is preserved whole as opaque HTML rather than silently losing the formatting.",
    },
    {
        id: "zh-headerless-table",
        name: "Headerless table",
        syntax: "<table> with no <th>",
        html: `<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>`,
        expect: "canonical",
        mustKeep: ["a", "b", "c", "d"],
        note: "Zotero's schema allows a table with no header row; GFM does not. Tagged during conversion and given `<!-- -->` placeholder header cells at serialization time.",
    },
    {
        id: "zh-code-block",
        name: "Zotero code block",
        syntax: "<pre>",
        html: `<pre>const a = 1;\nconst b = [[2]];</pre>`,
        expect: "verbatim",
        mustKeep: ["const a = 1;", "const b = [[2]];"],
        note: "`[[2]]` inside the fence must not be claimed as a wikilink. On the mdast a fence is one opaque `code` node the syntax passes never visit.",
    },
    {
        id: "zh-blockquote",
        name: "Zotero blockquote",
        syntax: "<blockquote>",
        html: `<blockquote><p>Quoted paragraph.</p></blockquote>`,
        expect: "canonical",
        mustKeep: ["Quoted paragraph."],
    },
    {
        id: "zh-nested-marks",
        name: "Nested inline marks",
        syntax: "<u><strong><a>",
        html: `<p><u>a <strong>b</strong> <a href="https://example.com">c</a></u></p>`,
        expect: "verbatim",
        mustKeep: ["<u>", "https://example.com"],
        note: "Regression guard: `<u>` used to keep only `toText()`, so the nested link lost its URL. It is a phrasing container now.",
    },
    {
        id: "zh-sub-sup",
        name: "Subscript and superscript",
        syntax: "<sub> <sup>",
        html: `<p>H<sub>2</sub>O and x<sup>2</sup></p>`,
        expect: "verbatim",
        mustKeep: ["<sub>2</sub>", "<sup>2</sup>"],
    },
    {
        id: "zh-empty-paragraphs",
        name: "Empty paragraphs",
        syntax: "<p></p>",
        html: `<p>before</p><p></p><p></p><p>after</p>`,
        expect: "canonical",
        mustKeep: ["before", "after"],
        note: "Zotero emits empty paragraphs as spacing. Markdown has no place for them, so they are dropped — and runs of them must not accumulate across syncs.",
    },
    {
        id: "zh-orphan-inline",
        name: "Inline element at the root",
        syntax: "<span> at root",
        html: `<span>orphaned</span><p>normal</p>`,
        expect: "canonical",
        mustKeep: ["orphaned", "normal"],
        note: "Zotero can leave a span or img directly under the root. Wrapped in a `<p>` before rehype-remark sees the tree.",
    },
    {
        id: "zh-numeric-charrefs",
        name: "Double-encoded character reference",
        syntax: "&amp;#x20;",
        html: `<p>a&amp;#x20;b and Tom &amp; Jerry</p>`,
        expect: "canonical",
        mustKeep: ["a b", "Jerry"],
        mustNotHave: ["&#x20;", "&amp;#x26;"],
        note: "Zotero emits single character references at inline-mark boundaries; a prior round trip can double-encode them, and rehype-parse then decodes one level into the literal text `&#x20;`. Left alone that re-escapes into a broken reference visible in Zotero, so the note self-heals — `a&amp;#x20;b` comes back as `a b`. The surviving `&` is re-encoded as `&#x26;`, which is correct HTML output; what matters is that it encodes exactly once, and the DRIFT check is what enforces that.",
    },
    {
        id: "zh-br-whitespace",
        name: "Newlines around <br>",
        syntax: "\\n<br>\\n",
        html: `<p>line one\n<br>\nline two</p>`,
        expect: "canonical",
        mustKeep: ["line one", "line two"],
        note: "HTML pretty-printing leaves newline-only text nodes on either side of a `<br>`. They are dropped; a run of spaces is NOT, because Zotero uses those for alignment.",
    },
    {
        id: "zh-full-note",
        name: "Realistic Zotero note",
        syntax: "(everything)",
        html:
            `<div data-schema-version="9" data-citation-items="%5B%5D">` +
            `<h1>Reading notes</h1>` +
            `<p><span class="highlight" data-annotation="${ANNOTATION}">a quoted passage</span> ` +
            `<span class="citation" data-citation="${CITATION}">(Doe, 2020, p. 5)</span></p>` +
            `<ul><li><span>point one</span></li><li><span>point two</span></li></ul>` +
            `<p>Formula <span class="math">$x^2$</span> and <span style="color: #ff6666">red</span>.</p>` +
            `<pre>code(); // [[not a wikilink]]</pre>` +
            `</div>`,
        expect: "canonical",
        mustKeep: [
            `data-annotation="${ANNOTATION}"`,
            `data-citation="${CITATION}"`,
            'data-schema-version="9"',
            "point one",
            'class="math"',
            "color: #ff6666",
            "[[not a wikilink]]",
        ],
        note: "End-to-end for the Zotero direction. Every payload, the wrapper, the span-wrapped list, math, colour and a fence containing wikilink-looking text, in one note.",
    },
]);

/* ================================================================ */
/*  14. Obsidian syntax inside every container                      */
/* ================================================================ */

/*
 * The scanner works one text node at a time, so what encloses that node
 * decides both which escapes apply and whether the node survives at all as a
 * single run. Each container is a different answer, and the two that already
 * produced data loss — a table cell and a line break — were found only by
 * looking. This grid removes the guesswork.
 */
group("Syntax in containers", [
    {
        id: "ctr-blockquote-all",
        name: "All forms in a blockquote",
        syntax: "> [[…]] #t ^[…]",
        md: `> Linked [[Alpha]], tagged #beta, noted.^[a footnote] and ![[Gamma.png]]`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]", "#beta", "^[a footnote]", "![[Gamma.png]]"],
        mustNotHave: ["\\[", "\\#"],
    },
    {
        id: "ctr-nested-blockquote",
        name: "All forms in a nested blockquote",
        syntax: "> > [[…]]",
        md: `> outer
> > Linked [[Alpha]] and tagged #beta`,
        expect: "canonical",
        mustKeep: ["[[Alpha]]", "#beta"],
        mustNotHave: ["\\[", "\\#"],
    },
    {
        id: "ctr-callout-body",
        name: "All forms in a callout body",
        syntax: "> [!note] … [[…]]",
        md: `> [!note] See [[Alpha]]
> Tagged #beta and noted.^[a footnote]`,
        expect: "verbatim",
        mustKeep: ["[!note] See [[Alpha]]", "#beta", "^[a footnote]"],
        mustNotHave: ["\\[", "\\#"],
        note: "The callout marker and a wikilink share one paragraph's leading text node — callout claims the marker, obsidian-syntax splits the rest.",
    },
    {
        id: "ctr-table-all",
        name: "All forms in table cells",
        syntax: "| [[…]] | #t |",
        md: `| A | B |
| --- | --- |
| [[Alpha]] | #beta |
| ^[a footnote] | ![[Gamma.png]] |`,
        expect: "canonical",
        mustKeep: ["[[Alpha]]", "#beta", "^[a footnote]", "![[Gamma.png]]"],
        note: "A table cell is the construct that broke twice: an unescaped `|` and an unescaped newline both tore rows apart.",
    },
    {
        id: "ctr-heading-all",
        name: "All forms in a heading",
        syntax: "## [[…]] #t",
        md: `## See [[Alpha]] and #beta`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]", "#beta"],
        mustNotHave: ["\\["],
        note: "A heading already begins with `#`, so a tag inside one exercises the heading-escape rule from the other side.",
    },
    {
        id: "ctr-task-all",
        name: "All forms in a task item",
        syntax: "- [ ] [[…]] #t",
        md: `- [ ] Read [[Alpha]] #beta
- [x] Done ^[a footnote]`,
        expect: "canonical",
        mustKeep: ["[ ] Read [[Alpha]] #beta", "[x] Done ^[a footnote]"],
        mustNotHave: ["\\[["],
        note: "Two features rewrite the same leading text node here: task-list lifts the `[x]` marker out, obsidian-syntax splits what remains.",
    },
    {
        id: "ctr-nested-list",
        name: "All forms in a deeply nested list",
        syntax: "- - - [[…]]",
        md: `- one
    - two
        - three [[Alpha]] #beta
            - four ^[a footnote]`,
        expect: "canonical",
        mustKeep: ["[[Alpha]]", "#beta", "^[a footnote]"],
        mustNotHave: ["\\["],
    },
    {
        id: "ctr-emphasis-wrapped",
        name: "All forms inside emphasis",
        syntax: "**[[…]]** *#t*",
        md: `**[[Alpha]]** and *#beta* and ~~^[a footnote]~~`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]", "#beta", "^[a footnote]"],
        mustNotHave: ["\\["],
        note: "Emphasis puts the text node inside `fullPhrasingSpans`, which changes which unsafe patterns are in scope.",
    },
    {
        id: "ctr-link-label",
        name: "WikiLink inside a link label",
        syntax: "[[[A]]](url)",
        md: `See [text [[Alpha]] more](https://example.com) here.`,
        expect: "canonical",
        mustKeep: ["https://example.com"],
        note: "A link label is one of the few constructs where escaping `[` is genuinely required, so the container-scoped policy keeps that rule while dropping the phrasing one. Whatever the outcome, it must converge.",
    },
    {
        id: "ctr-code-immunity",
        name: "All forms inside code (must NOT be claimed)",
        syntax: "`[[…]]` ``` #t",
        md: "Inline `[[Alpha]]` `#beta` `^[fn]` `![[E.png]]`\n\n```\n[[Alpha]]\n#beta\n^[fn]\n![[E.png]]\n> [!note]\n```",
        expect: "verbatim",
        mustKeep: [
            "`[[Alpha]]`",
            "`#beta`",
            "`^[fn]`",
            "`![[E.png]]`",
            "\n[[Alpha]]\n#beta\n^[fn]\n![[E.png]]\n> [!note]\n",
        ],
        note: "The corruption regression, extended to every claimed form at once. None may be touched inside inline code or a fence.",
    },
]);

/* ================================================================ */
/*  15. Adversarial and pathological input                          */
/* ================================================================ */

group("Adversarial", [
    {
        id: "adv-note-meta-in-body",
        name: "ZF_NOTE_META inside the body",
        syntax: "<!-- ZF_NOTE_META … -->",
        md: `Real text.

<!-- ZF_NOTE_META data-schema-version="9" -->

More text.`,
        expect: "verbatim",
        mustKeep: ["Real text.", "More text."],
        note: "The marker is machine-owned and matched only at offset 0. One in the body must not be mistaken for the wrapper's, which would inject a bogus `<div>` and swallow the note.",
    },
    {
        id: "adv-note-meta-first-line",
        name: "ZF_NOTE_META written by hand at the top",
        syntax: "leading ZF_NOTE_META",
        md: `<!-- ZF_NOTE_META data-schema-version="9" -->

Body.`,
        expect: "canonical",
        mustKeep: ["Body."],
        note: "Anchored at offset 0, so this one IS consumed and rebuilt as a wrapper div. It must at least converge rather than nest a wrapper per pass.",
    },
    {
        id: "adv-editable-marker",
        name: "ZF_*_BEG marker in the body",
        syntax: "<!-- ZF_ANNO_BEG_x -->",
        md: `<!-- ZF_ANNO_BEG_abc123 -->
content
<!-- ZF_ANNO_END_abc123 -->`,
        expect: "canonical",
        mustKeep: ["ZF_ANNO_BEG_abc123", "content", "ZF_ANNO_END_abc123"],
        note: "The CM6 editable-region extension keys on these. They are ordinary HTML comments to the converter and must survive unchanged.",
    },
    {
        id: "adv-span-link-class",
        name: "zotflow-span-link written by hand",
        syntax: 'class="zotflow-span-link"',
        html: `<p><a class="zotflow-span-link" href="https://example.com">text</a></p>`,
        expect: "canonical",
        mustKeep: ["text"],
        note: "The outbound strip is an unconditional string replace keyed on this class. A hand-written anchor carrying it will be unwrapped — check that this at least converges and keeps the text.",
    },
    {
        id: "adv-backslash-run",
        name: "Link opener followed by backslashes",
        syntax: "](\\\\\\\\\\\\…",
        md: `text ](\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\ and no closing paren`,
        expect: "canonical",
        mustKeep: ["and no closing paren"],
        note: "`link.ts`'s postSerializeMd scans `](…)` destinations. Its pattern must keep the alternatives disjoint — an ambiguous `(?:\\\\.|[^()\\s])+` backtracks exponentially on exactly this input. A hang here is the failure mode, not a wrong answer.",
    },
    {
        id: "adv-deep-nesting",
        name: "Deeply nested lists and quotes",
        syntax: "10 levels",
        md: `- 1
    - 2
        - 3
            - 4
                - 5
                    - 6
                        - 7
                            - 8
                                - 9 [[Alpha]]`,
        expect: "canonical",
        mustKeep: ["[[Alpha]]"],
    },
    {
        id: "adv-unclosed-html",
        name: "Unclosed tags",
        syntax: "<u>… (no close)",
        html: `<p><u>never closed<p>next paragraph</p>`,
        expect: "canonical",
        mustKeep: ["never closed", "next paragraph"],
        note: "rehype-parse repairs this the way a browser would. Whatever shape it settles on must be stable.",
    },
    {
        id: "adv-empty-doc",
        name: "Empty document",
        syntax: "(empty)",
        md: ``,
        expect: "verbatim",
        note: "Degenerate input must not throw or grow content.",
    },
    {
        id: "adv-whitespace-only",
        name: "Whitespace-only document",
        syntax: "(spaces)",
        md: `   \n\n   \n`,
        expect: "verbatim",
    },
    {
        id: "adv-nbsp-run",
        name: "Non-breaking space runs",
        syntax: "&nbsp;&nbsp;&nbsp;",
        md: `Multiple&nbsp;&nbsp;&nbsp;adjacent&nbsp;spaces here`,
        expect: "canonical",
        mustKeep: ["adjacent"],
        note: "Zotero uses NBSP runs for alignment. They must resolve exactly once, not re-encode on every pass.",
    },
    {
        id: "adv-unicode",
        name: "RTL, ZWJ emoji, combining marks",
        syntax: "‏ 👨‍👩‍👧 é",
        md: `Arabic العربية and Hebrew עברית, family 👨‍👩‍👧‍👦, combining é, surrogate 𝔘𝔫𝔦.`,
        expect: "verbatim",
        mustKeep: ["العربية", "עברית", "👨‍👩‍👧‍👦", "𝔘𝔫𝔦"],
        note: "ZWJ emoji sequences and astral-plane characters are multi-code-unit; a scanner indexing by code unit must not split them.",
    },
    {
        id: "adv-unicode-in-wikilink",
        name: "Non-Latin wikilink target",
        syntax: "[[中文笔记]]",
        md: `See [[中文笔记]] and [[العربية]] and [[emoji 🚀 note]].`,
        expect: "verbatim",
        mustKeep: ["[[中文笔记]]", "[[العربية]]", "[[emoji 🚀 note]]"],
    },
    {
        id: "adv-long-line",
        name: "Very long single line",
        syntax: "(4000 chars)",
        md: `${"word ".repeat(800)}[[Alpha]]`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]"],
        note: "Guards against quadratic behaviour in the per-text-node scan.",
    },
    {
        id: "adv-many-wikilinks",
        name: "Many wikilinks in one node",
        syntax: "200 × [[…]]",
        md: Array.from({ length: 200 }, (_, i) => `[[N${i}]]`).join(" "),
        expect: "verbatim",
        mustKeep: ["[[N0]]", "[[N199]]"],
        note: "The scan splices a text node per match; 200 splices in one node exercises the index bookkeeping after each SKIP.",
    },
    {
        id: "adv-unterminated-forms",
        name: "Unterminated Obsidian forms",
        syntax: "[[ , ![[ , ^[",
        md: `Unclosed [[Alpha and ![[Beta and ^[Gamma and [^Delta`,
        expect: "canonical",
        mustKeep: ["Alpha", "Beta", "Gamma", "Delta"],
        note: "None of these terminate, so the scanner must claim nothing and let the escape pass do its job. The risk is a scan that runs to end-of-string and swallows the rest of the paragraph.",
    },
    {
        id: "adv-adjacent-forms",
        name: "Forms with no separator",
        syntax: "[[A]]![[B]]#c^[d]",
        md: `[[Alpha]]![[Beta.png]]#gamma^[delta]`,
        expect: "verbatim",
        mustKeep: ["[[Alpha]]", "![[Beta.png]]", "^[delta]"],
        note: "Four claims back to back with no text between them, so every splice boundary is exercised at once.",
    },
    {
        id: "adv-empty-forms",
        name: "Empty forms",
        syntax: "[[]] ![[]] ^[]",
        md: `Empty [[]] and ![[]] and ^[] and [^].`,
        expect: "verbatim",
        note: "Zero-length bodies. Must not produce an empty raw node that the serializer then joins wrongly.",
    },
    {
        id: "adv-pipe-heavy-table",
        name: "Pipes everywhere in a table",
        syntax: "| a\\|b | [[c\\|d]] |",
        md: `| A | B |
| --- | --- |
| a \\| b | [[Note\\|alias]] |
| \`code \\| pipe\` | **bo \\| ld** |`,
        expect: "canonical",
        mustKeep: ["[[Note\\|alias]]"],
        note: "Escaped pipes in plain text, inside a wikilink, inside code and inside emphasis — four different escaping paths in one row.",
    },
    {
        id: "adv-html-in-md",
        name: "Raw HTML mixed with Obsidian syntax",
        syntax: "<div>[[A]]</div>",
        md: `<div class="x">[[Alpha]] and #beta</div>

Normal [[Gamma]] here.`,
        expect: "canonical",
        mustKeep: ["[[Gamma]]"],
        note: "Content inside a raw HTML block is an `html` literal on the mdast, not a text node, so the scanner never sees it. Recorded so the asymmetry is deliberate rather than surprising.",
    },
    {
        id: "adv-dollar-heavy",
        name: "Dollar signs that are not math",
        syntax: "$5 $10 $$ $",
        md: `Costs $5, then $10, then $$20 and a lone $ here.`,
        expect: "canonical",
        mustKeep: ["$5", "$10"],
        note: "remark-math has to decide what is a delimiter. Whatever it decides must be stable across passes.",
    },
    {
        id: "adv-repeated-entities",
        name: "Ampersands and entities",
        syntax: "& &amp; &#38;",
        md: `Raw & and named &amp; and numeric &#38; and &notanentity;`,
        expect: "canonical",
        note: "The classic drift shape: an entity that re-encodes a little more on every pass.",
    },
]);

/* ================================================================ */
/*  16. Verbatim handlers in hostile containers                     */
/* ================================================================ */

/*
 * `obsidianRaw` used to emit its value with no escaping at all, which
 * destroyed content twice inside a table cell — once via an unescaped `|`,
 * once via an unescaped newline. It now goes through `state.safe()` with only
 * the content rules dropped.
 *
 * Three other stringify handlers still emit inline content verbatim:
 *
 *     zoteroOpaqueHtml      -> node.value
 *     zoteroAnnotationImage -> node.value  /  ![node.value | w](path)
 *     inlineMath            -> `$${node.value}$`
 *
 * All three produce *phrasing* content, so all three can land in a table cell.
 * These cases exist to find out whether they share the same failure, rather
 * than waiting for a note to find out first. (`code` and block `math` are
 * block-level and cannot occur in a GFM cell; `link` delegates to the default
 * handler and `marks` uses `state.containerPhrasing`, so both are already
 * safe.)
 */
group("Verbatim handlers in cells", [
    {
        id: "vh-math-pipe-cell",
        name: "Inline math containing a pipe, in a cell",
        syntax: "| $a\\|b$ |",
        md: `| A | B |
| --- | --- |
| $a \\| b$ | second |`,
        expect: "canonical",
        mustKeep: ["second"],
        note: "Round-trips, and the reason is worth recording: remark-math keeps the `\\|` inside the value rather than unescaping it, so the escape written here is simply part of the formula and stays consistent. A bare `|` cannot be written from markdown at all — it would end the cell — which is why the destructive shape only reaches the pipeline from Zotero (see vh-math-pipe-cell-html).",
    },
    {
        id: "vh-math-norm-cell",
        name: "LaTeX norm symbol in a cell",
        syntax: "| $\\|x\\|$ |",
        md: `| A | B |
| --- | --- |
| $\\|x\\|$ | second |`,
        expect: "canonical",
        mustKeep: ["second"],
        note: "`\\|` is the LaTeX norm symbol, which is why the inbound direction cannot simply normalize `\\|` to `|` — doing so would silently rewrite the formula. The pipe here is part of the maths, not a separator.",
    },
    {
        id: "vh-math-latex-cell",
        name: "LaTeX commands in a cell",
        syntax: "| $\\frac{a}{b}$ |",
        md: `| A | B |
| --- | --- |
| $\\frac{a}{b}$ | second |`,
        expect: "canonical",
        mustKeep: ["\\frac{a}{b}", "second"],
        note: "Guards the other failure mode of escaping maths: backslashes are LaTeX, and any pass that escapes them accumulates.",
    },
    {
        id: "vh-math-pipe-prose",
        name: "Inline math with a pipe, in prose",
        syntax: "$|x|$ (no table)",
        md: `The set $\\{x : |x| < 1\\}$ is open.`,
        expect: "verbatim",
        mustKeep: ["|x|"],
        note: "Control: outside a cell a `|` in maths is ordinary, so the plain `$…$` form must be kept rather than the HTML detour.",
    },
    {
        id: "vh-math-pipe-cell-html",
        name: "Zotero math with a pipe, in a cell",
        syntax: '<td><span class="math">$a|b$',
        html: `<table><tr><td><span class="math">$a|b$</span></td><td>second</td></tr></table>`,
        expect: "broken",
        gap: "bug",
        mustKeep: ["second"],
        note: "The one shape that still loses content: a bare `|` inside inline math inside a cell, which only Zotero can produce (markdown cannot express it — the pipe would end the cell). The row is torn and the following cell is dropped. Three candidate fixes were tried and each traded this for a different corruption; the analysis is in features/math.ts.",
    },
    {
        id: "vh-citation-pipe-cell",
        name: "Citation span with a pipe, in a cell",
        syntax: "<td><span class=citation>a|b",
        html: `<table><tr><td><span class="citation" data-citation="${CITATION}">(Doe | 2020)</span></td><td>second</td></tr></table>`,
        expect: "canonical",
        mustKeep: [`data-citation="${CITATION}"`, "second"],
        note: "`zoteroOpaqueHtml` emits `node.value` verbatim — correct everywhere except a cell, where the `|` in the citation's visible text is a column separator.",
    },
    {
        id: "vh-highlight-br-cell",
        name: "Annotation span with a <br>, in a cell",
        syntax: "<td><span class=highlight>a<br>b",
        html: `<table><tr><td><span class="highlight" data-annotation="${ANNOTATION}">line one<br>line two</span></td><td>second</td></tr></table>`,
        expect: "canonical",
        mustKeep: [`data-annotation="${ANNOTATION}"`, "second"],
        note: "The other half of the pair: gfm-table declares `\\n` unsafe in a cell too, and a `<br>` inside a preserved payload puts one there.",
    },
    {
        id: "vh-colored-pipe-cell",
        name: "Colour span with a pipe, in a cell",
        syntax: '<td><span style="color">a|b',
        html: `<table><tr><td><span style="color: #ff6666">red | text</span></td><td>second</td></tr></table>`,
        expect: "canonical",
        mustKeep: ["color: #ff6666", "second"],
    },
    {
        id: "vh-annotation-image-cell",
        name: "Annotation image in a cell",
        syntax: "<td><img data-annotation>",
        html: `<table><tr><td><img data-attachment-key="IMGKEY01" data-annotation="${ANNOTATION}" width="576"></td><td>second</td></tr></table>`,
        expect: "canonical",
        mustKeep: ['data-attachment-key="IMGKEY01"', "second"],
        note: "`zoteroAnnotationImage` emits the raw `<img …>` tag. Its attribute values are URL-encoded, but the tag itself is long and unescaped.",
    },
    {
        id: "vh-payload-in-list",
        name: "Payload span in a list item",
        syntax: "<li><span class=citation>",
        html: `<ul><li><span class="citation" data-citation="${CITATION}">(Doe | 2020)</span></li></ul>`,
        expect: "canonical",
        mustKeep: [`data-citation="${CITATION}"`],
        note: "Control for the cell cases: a list item has no column separator, so the same payload should be fine here. A failure here would mean something else entirely.",
    },
    {
        id: "vh-payload-in-list-nopipe",
        name: "Payload span in a list item, no pipe",
        syntax: "<li><span class=citation> (plain)",
        html: `<ul><li><span class="citation" data-citation="${CITATION}">(Doe, 2020)</span></li></ul>`,
        expect: "canonical",
        mustKeep: [`data-citation="${CITATION}"`],
        note: "Isolates span accumulation from pipe splitting. No `|` anywhere, no table — if this still drifts, the cause is the `<li>`/`<td>` span wrapping meeting raw HTML, not the escaping.",
    },
    {
        id: "vh-payload-in-paragraph",
        name: "Payload span in a plain paragraph",
        syntax: "<p><span class=citation>",
        html: `<p><span class="citation" data-citation="${CITATION}">(Doe, 2020)</span></p>`,
        expect: "verbatim",
        mustKeep: [`data-citation="${CITATION}"`],
        note: "The true control: a paragraph is not in `SPAN_WRAPPED_PARENTS`, so no wrapping happens and the payload should be untouched.",
    },
    {
        id: "vh-nested-payload-spans",
        name: "Payload span inside a mark",
        syntax: "<u><span class=citation>",
        html: `<p><u>see <span class="citation" data-citation="${CITATION}">(Doe, 2020)</span></u></p>`,
        expect: "verbatim",
        mustKeep: [`data-citation="${CITATION}"`, "<u>"],
        note: "`marks` serializes through `state.containerPhrasing`, so the opaque child is emitted from inside another handler's context.",
    },
    {
        id: "vh-math-in-heading",
        name: "Inline math in a heading",
        syntax: "## $x$",
        md: `## Formula $x^2$ here`,
        expect: "verbatim",
        mustKeep: ["$x^2$"],
    },
]);

/* ================================================================ */
/*  Runner                                                          */
/* ================================================================ */

const ALL: Case[] = GROUPS.flatMap((g) => g.cases);

/** Trailing whitespace and blank-line padding are formatting noise. */
function norm(s: string): string {
    return s
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

interface Result {
    verdict: Verdict;
    /** Source after one full round trip, in the source's own format. */
    rt: string;
    /** After a second round trip. Equal to `rt` unless the case drifts. */
    rt2: string;
    /** The other format, in between — dumped by --verbose. */
    intermediate: string;
    /** A third round trip, to tell one-time canonicalization from slow drift. */
    rt3: string;
    missing: string[];
    forbidden: string[];
}

async function runCase(c: Case, strictLineBreaks: boolean): Promise<Result> {
    const opts = { strictLineBreaks };
    const { text, from } = sourceOf(c);

    // One round trip, in whichever direction the case declares. `there` and
    // `back` are the two halves; composing them keeps the rest of the runner
    // identical for both directions.
    const there = async (s: string) =>
        from === "md"
            ? await convert.md2html(s, opts)
            : await convert.html2md(s, opts);
    const back = async (s: string) =>
        from === "md"
            ? await convert.html2md(s, opts)
            : await convert.md2html(s, opts);

    const intermediate = await there(text);
    const rt = await back(intermediate);
    const rt2 = await back(await there(rt));
    // A third pass separates "canonicalizes once, then settles" from a slow
    // drift that a two-pass check would call stable by luck.
    const rt3 = await back(await there(rt2));

    const missing = (c.mustKeep ?? []).filter((n) => !rt.includes(n));
    const forbidden = (c.mustNotHave ?? []).filter((n) => rt.includes(n));

    let verdict: Verdict;
    if (norm(rt) !== norm(rt2) || norm(rt2) !== norm(rt3)) verdict = "DRIFT";
    else if (norm(rt) === norm(text) && forbidden.length === 0)
        verdict = "VERBATIM";
    else if (missing.length === 0 && forbidden.length === 0)
        verdict = "CANONICAL";
    else verdict = "BROKEN";

    return { verdict, rt, rt2, rt3, intermediate, missing, forbidden };
}

const RANK: Record<Verdict, number> = {
    DRIFT: 0,
    BROKEN: 1,
    CANONICAL: 2,
    VERBATIM: 3,
};
const EXPECT_RANK: Record<Expect, number> = {
    broken: 1,
    canonical: 2,
    verbatim: 3,
};

type Outcome = "OK" | "KNOWN" | "FIXED" | "FAIL";

function classify(c: Case, v: Verdict): Outcome {
    // Instability is never acceptable, no matter what the expectation says.
    if (v === "DRIFT") return "FAIL";
    const got = RANK[v];
    const want = EXPECT_RANK[c.expect];
    if (got < want) return "FAIL";
    if (got > want) return "FIXED";
    return c.expect === "broken" ? "KNOWN" : "OK";
}

const MODES: { label: string; strictLineBreaks: boolean }[] = [
    { label: "strictLineBreaks=true", strictLineBreaks: true },
    { label: "strictLineBreaks=false", strictLineBreaks: false },
];

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function indent(s: string, prefix: string): string {
    return s
        .split("\n")
        .map((l) => prefix + l)
        .join("\n");
}

export async function run(argv?: string[]) {
    const args = argv ?? [];
    const verbose = args.includes("--verbose");
    const showAll = args.includes("--all");
    const filters = args.filter((a) => !a.startsWith("--"));

    const active = filters.length
        ? ALL.filter((c) =>
              filters.some(
                  (f) =>
                      c.id.toLowerCase().includes(f.toLowerCase()) ||
                      c.name.toLowerCase().includes(f.toLowerCase()),
              ),
          )
        : ALL;

    if (!active.length) {
        console.log("[WARN] No cases matched the filter.");
        return;
    }

    const rows: {
        c: Case;
        perMode: { mode: string; res: Result; outcome: Outcome }[];
    }[] = [];

    for (const c of active) {
        const perMode = [];
        for (const m of MODES) {
            const res = await runCase(c, m.strictLineBreaks);
            perMode.push({
                mode: m.label,
                res,
                outcome: classify(c, res.verdict),
            });
        }
        rows.push({ c, perMode });
    }

    /* ---- detail for anything not clean ------------------------- */

    const interesting = rows.filter((r) =>
        r.perMode.some((p) => p.outcome !== "OK"),
    );
    const detail = showAll ? rows : interesting;

    if (detail.length) {
        console.log("\n" + "=".repeat(76));
        console.log(
            showAll ? " ALL CASES" : " CASES NEEDING ATTENTION (--all to see every case)",
        );
        console.log("=".repeat(76));
    }

    for (const { c, perMode } of detail) {
        const { text, from } = sourceOf(c);
        const arrow = from === "md" ? "md → html → md" : "html → md → html";
        console.log(`\n### ${c.name}  [${c.id}]   ${c.syntax}   (${arrow})`);
        if (c.note) console.log(indent(c.note, "    | "));
        console.log(`  --- input (${from}) ---`);
        console.log(indent(text, "  | "));

        for (const { mode, res, outcome } of perMode) {
            console.log(`  --- ${mode} → ${res.verdict} (${outcome}) ---`);
            if (outcome !== "OK" || verbose) {
                console.log(indent(res.rt, "  > "));
            }
            if (res.missing.length) {
                console.log(
                    `    MISSING: ${res.missing.map((s) => JSON.stringify(s)).join(", ")}`,
                );
            }
            if (res.forbidden.length) {
                console.log(
                    `    FORBIDDEN PRESENT: ${res.forbidden.map((s) => JSON.stringify(s)).join(", ")}`,
                );
            }
            if (res.verdict === "DRIFT") {
                const slow = norm(res.rt) === norm(res.rt2);
                console.log(
                    slow
                        ? "    !! DRIFTS ON THE THIRD PASS — a two-pass check would call this stable:"
                        : "    !! NOT A FIXED POINT — second pass differs:",
                );
                const a = (slow ? res.rt2 : res.rt).split("\n");
                const b = (slow ? res.rt3 : res.rt2).split("\n");
                for (let i = 0; i < Math.max(a.length, b.length); i++) {
                    if (a[i] !== b[i]) {
                        console.log(`      L${i + 1} before: ${JSON.stringify(a[i] ?? "(missing)")}`);
                        console.log(`      L${i + 1} after : ${JSON.stringify(b[i] ?? "(missing)")}`);
                    }
                }
            }
            if (verbose) {
                console.log(
                    `    --- intermediate (${sourceOf(c).from === "md" ? "html" : "md"}) ---`,
                );
                console.log(indent(res.intermediate, "    . "));
            }
        }
    }

    /* ---- the matrix -------------------------------------------- */

    const ICON: Record<Verdict, string> = {
        VERBATIM: "OK  ",
        CANONICAL: "~   ",
        BROKEN: "X   ",
        DRIFT: "DRIFT",
    };

    console.log("\n" + "=".repeat(76));
    console.log(" OBSIDIAN SYNTAX SURVIVAL MATRIX");
    console.log("=".repeat(76));
    console.log(
        `  ${pad("Name", 30)} ${pad("Syntax", 22)} ${pad("strict=T", 10)} ${pad("strict=F", 10)}`,
    );
    console.log("  " + "-".repeat(72));

    for (const { group: gname, cases } of GROUPS) {
        const mine = rows.filter((r) => cases.includes(r.c));
        if (!mine.length) continue;
        console.log(`  -- ${gname} --`);
        for (const { c, perMode } of mine) {
            const cells = perMode.map((p) => {
                const mark = ICON[p.res.verdict].trim();
                const flag =
                    p.outcome === "FAIL"
                        ? " !"
                        : p.outcome === "FIXED"
                          ? " +"
                          : "";
                return pad(mark + flag, 10);
            });
            console.log(
                `  ${pad(c.name, 30)} ${pad(c.syntax, 22)} ${cells.join(" ")}`,
            );
        }
    }
    console.log("  " + "-".repeat(72));
    console.log("  OK = verbatim   ~ = canonicalized   X = syntax lost");
    console.log("  DRIFT = not a fixed point (always a failure)");
    console.log("  ! = regression vs. expectation   + = better than expected");

    /* ---- summary ----------------------------------------------- */

    const flat = rows.flatMap((r) => r.perMode);
    const count = (o: Outcome) => flat.filter((p) => p.outcome === o).length;
    const fails = rows.filter((r) => r.perMode.some((p) => p.outcome === "FAIL"));
    // Only worth re-declaring when *every* mode beat the expectation —
    // `expect` is one value per case, so a syntax that is verbatim under one
    // line-break setting and canonical under the other is correctly recorded
    // as the weaker of the two.
    const fixed = rows.filter((r) => r.perMode.every((p) => p.outcome === "FIXED"));
    const known = rows.filter((r) =>
        r.perMode.every((p) => p.outcome === "KNOWN"),
    );

    console.log("\n" + "=".repeat(76));
    console.log(" SUMMARY");
    console.log("=".repeat(76));
    console.log(`  Cases: ${rows.length}   Runs: ${flat.length} (2 modes each)`);
    console.log(
        `  OK ${count("OK")}   KNOWN-GAP ${count("KNOWN")}   FIXED ${count("FIXED")}   FAIL ${count("FAIL")}`,
    );

    // The two kinds of gap want different responses, so they are never mixed
    // into one list: a schema limit is a fact to document, a bug is work.
    const byDesign = known.filter((r) => r.c.gap === "by-design");
    const bugs = known.filter((r) => r.c.gap !== "by-design");
    if (byDesign.length) {
        console.log(
            `\n  Lost to Zotero's schema — nothing to fix (${byDesign.length}):`,
        );
        for (const r of byDesign) {
            console.log(`    - ${pad(r.c.name, 30)} ${r.c.syntax}`);
        }
    }
    if (bugs.length) {
        console.log(
            `\n  Lost to the pipeline — fixable (${bugs.length}):`,
        );
        for (const r of bugs) {
            console.log(`    ! ${pad(r.c.name, 30)} ${r.c.syntax}`);
        }
    }
    if (fixed.length) {
        console.log(`\n  Better than expected — update \`expect\`:`);
        for (const r of fixed) console.log(`    + ${r.c.name}  (${r.c.id})`);
    }
    if (fails.length) {
        console.log(`\n  REGRESSIONS:`);
        for (const r of fails) {
            const modes = r.perMode
                .filter((p) => p.outcome === "FAIL")
                .map((p) => `${p.mode}=${p.res.verdict}`)
                .join(", ");
            console.log(`    ! ${r.c.name}  (${r.c.id})  ${modes}`);
        }
        process.exitCode = 1;
    }
}
