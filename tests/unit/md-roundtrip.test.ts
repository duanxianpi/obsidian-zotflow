/**
 * MD → HTML → MD round-trip (Obsidian-style markdown).
 *
 * Each test point is an isolated markdown snippet, converted to Zotero HTML
 * via md2html then back via html2md. Every check inside a point becomes its
 * own test case so a failure names the exact construct that drifted.
 *
 * Migrated from scripts/_test-md-roundtrip-entry.ts.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { ConvertService } from "worker/services/convert";

const convert = new ConvertService();


/**
 * `strictLineBreaks` mirrors ONE vault setting, so both directions must be
 * given the same value. Passing `true` to md2html while letting html2md
 * default to `false` models a configuration that cannot occur in production
 * — item-note.ts sources both from `vaultConfig.strictLineBreaks` — and makes
 * `<br>` round-tripping look broken when it is not.
 */
const CONVERT_OPTS = { strictLineBreaks: true };

/* ================================================================ */
/*  Test Point Types                                                */
/* ================================================================ */

interface TestPoint {
    name: string;
    md: string;
    checks: Check[];
}

type Check =
    | { type: "html-contains"; label: string; needle: string }
    | { type: "html-not-contains"; label: string; needle: string }
    | { type: "rt-contains"; label: string; needle: string }
    | { type: "rt-not-contains"; label: string; needle: string }
    | { type: "html-regex"; label: string; pattern: RegExp }
    | { type: "rt-regex"; label: string; pattern: RegExp };

/* ================================================================ */
/*  Test Points                                                     */
/* ================================================================ */

const testPoints: TestPoint[] = [
    // ── Bare URLs (GFM literal autolinks) must round-trip verbatim ──
    {
        name: "bare-urls",
        md: `plain https://example.com text

params https://example.com/?a=1&b=2 here

bare www.example.com site

a [named](https://example.com) link`,
        checks: [
            {
                type: "rt-contains",
                label: "bare https URL stays bare",
                needle: "plain https://example.com text",
            },
            {
                type: "rt-contains",
                label: "bare URL with params stays bare and unescaped",
                needle: "params https://example.com/?a=1&b=2 here",
            },
            {
                type: "rt-contains",
                label: "bare www URL stays bare",
                needle: "bare www.example.com site",
            },
            {
                type: "rt-contains",
                label: "named link keeps resource form",
                needle: "a [named](https://example.com) link",
            },
            {
                type: "rt-not-contains",
                label: "no autolink angle brackets introduced",
                needle: "<https://example.com>",
            },
        ],
    },
    // ── 1. Paragraphs ──
    {
        name: "paragraphs",
        md: `First paragraph.

Second paragraph.`,
        checks: [
            { type: "html-contains", label: "<p> tags", needle: "<p>" },
            {
                type: "rt-contains",
                label: "First para preserved",
                needle: "First paragraph.",
            },
            {
                type: "rt-contains",
                label: "Second para preserved",
                needle: "Second paragraph.",
            },
        ],
    },

    // ── 2. Headings h1–h6 ──
    {
        name: "headings",
        md: `# Heading 1

## Heading 2

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6`,
        checks: [
            { type: "html-contains", label: "<h1>", needle: "<h1>" },
            { type: "html-contains", label: "<h6>", needle: "<h6>" },
            {
                type: "rt-contains",
                label: "# Heading 1",
                needle: "# Heading 1",
            },
            {
                type: "rt-contains",
                label: "###### Heading 6",
                needle: "###### Heading 6",
            },
        ],
    },

    // ── 3. Bold, italic, bold+italic ──
    {
        name: "bold-italic",
        md: `**Bold text** and *italic text* and ***bold italic***.

**Bold with _nested italic_ inside**.`,
        checks: [
            { type: "html-contains", label: "<strong>", needle: "<strong>" },
            { type: "html-contains", label: "<em>", needle: "<em>" },
            {
                type: "rt-contains",
                label: "**Bold text**",
                needle: "**Bold text**",
            },
            {
                type: "rt-contains",
                label: "*italic text*",
                needle: "*italic text*",
            },
        ],
    },

    // ── 4. Strikethrough ──
    {
        name: "strikethrough",
        md: `~~Striked out text~~`,
        checks: [
            {
                type: "html-contains",
                label: "line-through style",
                needle: "text-decoration: line-through",
            },
            {
                type: "rt-contains",
                label: "~~ preserved",
                needle: "~~Striked out text~~",
            },
        ],
    },

    // ── 5. Blockquotes ──
    {
        name: "blockquotes",
        md: `> Human beings face ever more complex and urgent problems.
>
> Second paragraph in quote.`,
        checks: [
            {
                type: "html-contains",
                label: "<blockquote>",
                needle: "<blockquote>",
            },
            {
                type: "rt-contains",
                label: "> quote prefix",
                needle: "> Human beings",
            },
        ],
    },

    // ── 6. Inline code ──
    {
        name: "inline-code",
        md: `Text inside \`backticks\` on a line.

Double backticks: \`\`code with a backtick \` inside\`\`.`,
        checks: [
            { type: "html-contains", label: "<code>", needle: "<code>" },
            {
                type: "rt-contains",
                label: "backtick preserved",
                needle: "`backticks`",
            },
        ],
    },

    // ── 7. Fenced code blocks ──
    {
        name: "code-blocks",
        md: `\`\`\`
cd ~/Desktop
\`\`\`

\`\`\`js
function fancyAlert(arg) {
  if(arg) {
    $.facebox({div:'#foo'})
  }
}
\`\`\``,
        checks: [
            { type: "html-contains", label: "<pre> tag", needle: "<pre>" },
            {
                type: "rt-contains",
                label: "Code content",
                needle: "cd ~/Desktop",
            },
            {
                type: "rt-contains",
                label: "JS code content",
                needle: "function fancyAlert",
            },
        ],
    },

    // ── 8. Code block nested in ```` ──
    {
        name: "code-block-nested",
        md: `\`\`\`\`
\`\`\`
cd ~/Desktop
\`\`\`
\`\`\`\``,
        checks: [
            { type: "html-contains", label: "<pre>", needle: "<pre>" },
            {
                type: "rt-contains",
                label: "Inner ``` in content",
                needle: "```",
            },
        ],
    },

    // ── 9. External links ──
    {
        name: "external-links",
        md: `[Obsidian Help](https://help.obsidian.md)

[Note](obsidian://open?vault=MainVault&file=Note.md)`,
        checks: [
            {
                type: "html-contains",
                label: "<a href>",
                needle: '<a href="https://help.obsidian.md">',
            },
            {
                type: "rt-contains",
                label: "Link text",
                needle: "[Obsidian Help]",
            },
            {
                type: "rt-contains",
                label: "obsidian:// link preserved",
                needle: "obsidian://open",
            },
        ],
    },

    // ── 10. External images ──
    {
        name: "external-images",
        md: `![Engelbart](https://example.com/photo.jpg)

![Engelbart|120x160](https://example.com/photo.jpg)`,
        checks: [
            { type: "html-contains", label: "<img> tag", needle: "<img" },
            {
                type: "rt-contains",
                label: "Image src",
                needle: "https://example.com/photo.jpg",
            },
            {
                type: "rt-contains",
                label: "Alt with dimensions",
                needle: "120x160",
            },
        ],
    },

    // ── 11. Unordered lists ──
    {
        name: "unordered-lists",
        md: `- First list item
- Second list item
- Third list item`,
        checks: [
            { type: "html-contains", label: "<ul>", needle: "<ul>" },
            { type: "html-contains", label: "<li>", needle: "<li>" },
            {
                type: "rt-contains",
                label: "First item",
                needle: "First list item",
            },
        ],
    },

    // ── 12. Ordered lists ──
    {
        name: "ordered-lists",
        md: `1. First list item
2. Second list item
3. Third list item`,
        checks: [
            { type: "html-contains", label: "<ol>", needle: "<ol>" },
            {
                type: "rt-contains",
                label: "First item",
                needle: "First list item",
            },
            { type: "rt-regex", label: "Numbered list", pattern: /^1\.\s/m },
        ],
    },

    // ── 13. Nested lists ──
    {
        name: "nested-lists",
        md: `1. First list item
   1. Ordered nested list item
2. Second list item
   - Unordered nested list item`,
        checks: [
            { type: "html-contains", label: "Nested <ol>", needle: "<ol>" },
            {
                type: "rt-contains",
                label: "Nested ordered item",
                needle: "Ordered nested list item",
            },
            {
                type: "rt-contains",
                label: "Nested unordered item",
                needle: "Unordered nested list item",
            },
        ],
    },

    // ── 14. Task lists ──
    // Zotero's note-editor schema strips `<input type="checkbox">`, so we
    // round-trip task lists as literal `[x] ` / `[ ] ` text inside the
    // `<li>` (Zotero-survivable, Obsidian-recognizable).
    {
        name: "task-lists",
        md: `- [x] This is a completed task.
- [ ] This is an incomplete task.`,
        checks: [
            {
                type: "html-contains",
                label: "Checked marker as text",
                needle: "<li><span>[x] ",
            },
            {
                type: "html-contains",
                label: "Unchecked marker as text",
                needle: "<li><span>[ ] ",
            },
            {
                type: "html-not-contains",
                label: "No checkbox input (Zotero strips it)",
                needle: "<input",
            },
            {
                type: "rt-contains",
                label: "Checked task syntax preserved",
                needle: "[x] This is a completed task.",
            },
            {
                type: "rt-contains",
                label: "Unchecked task syntax preserved",
                needle: "[ ] This is an incomplete task.",
            },
        ],
    },

    // ── 15. Horizontal rule ──
    {
        name: "horizontal-rule",
        md: `Before

- - -

After`,
        checks: [
            { type: "html-contains", label: "<hr>", needle: "<hr" },
            {
                type: "rt-regex",
                label: "HR syntax",
                pattern: /^(\*{3,}|-{3,}|_{3,})$/m,
            },
        ],
    },

    // ── 16. Footnotes ──
    // Note: Zotero's note schema has no footnote nodes. We deliberately
    // preserve `[^id]` syntax verbatim through both directions instead of
    // letting remark-gfm convert it to <sup><a> + <section data-footnotes>
    // (which is unrecoverable on the way back).
    {
        name: "footnotes",
        md: `You can add footnotes[^1] to your notes.

[^1]: This is a footnote.`,
        checks: [
            {
                type: "html-contains",
                label: "[^1] ref preserved in HTML",
                needle: "[^1]",
            },
            {
                type: "html-not-contains",
                label: "no <sup> footnote",
                needle: "<sup",
            },
            {
                type: "html-not-contains",
                label: "no footnotes section",
                needle: "data-footnotes",
            },
            {
                type: "rt-contains",
                label: "[^1] ref preserved in MD",
                needle: "footnotes[^1]",
            },
            {
                type: "rt-contains",
                label: "[^1]: definition preserved in MD",
                needle: "[^1]: This is a footnote.",
            },
        ],
    },

    // ── 17. Tables basic ──
    {
        name: "tables-basic",
        md: `| First name | Last name |
| ---------- | --------- |
| Max        | Planck    |
| Marie      | Curie     |`,
        checks: [
            { type: "html-contains", label: "<table>", needle: "<table>" },
            { type: "html-contains", label: "<thead>", needle: "<thead>" },
            { type: "rt-contains", label: "Max in table", needle: "Max" },
            { type: "rt-contains", label: "Curie in table", needle: "Curie" },
        ],
    },

    // ── 18. Tables with alignment ──
    {
        name: "tables-alignment",
        md: `| Left | Center | Right |
| :--- | :----: | ----: |
| L    |   C    |     R |`,
        checks: [
            {
                type: "html-contains",
                label: "align=left",
                needle: 'align="left"',
            },
            {
                type: "html-contains",
                label: "align=center",
                needle: 'align="center"',
            },
            {
                type: "html-contains",
                label: "align=right",
                needle: 'align="right"',
            },
            { type: "rt-regex", label: ":--- in MD", pattern: /:\s*-/ },
        ],
    },

    // ── 19. Tables with formatted content ──
    {
        name: "tables-formatted",
        md: `| First column | Second column |
| --- | --- |
| [Link](https://example.com) | **bold** and *italic* |
| ~~strike~~ | \`code\` |`,
        checks: [
            {
                type: "html-contains",
                label: "Link in table",
                needle: '<a href="https://example.com">',
            },
            {
                type: "html-contains",
                label: "Strong in table",
                needle: "<strong>",
            },
            {
                type: "rt-contains",
                label: "Link text round-tripped",
                needle: "[Link]",
            },
            { type: "rt-contains", label: "~~ in table", needle: "~~strike~~" },
        ],
    },

    // ── 20. Math inline + display ──
    {
        name: "math",
        md: `$$
\\begin{vmatrix}a & b\\\\
c & d
\\end{vmatrix}=ad-bc
$$

This is inline math: $e^{2i\\pi} = 1$.`,
        checks: [
            {
                type: "html-contains",
                label: "Display math pre",
                needle: '<pre class="math">',
            },
            {
                type: "html-contains",
                label: "Inline math span",
                needle: 'class="math"',
            },
            { type: "rt-contains", label: "$$ block in MD", needle: "$$" },
            { type: "rt-contains", label: "Inline $ in MD", needle: "$e^{" },
        ],
    },

    // ── 21. Highlight (Obsidian-specific) ──
    {
        name: "highlight",
        md: `==Highlighted text==`,
        checks: [
            // Obsidian == has no HTML equivalent, passes through as text
            {
                type: "rt-contains",
                label: "Highlight text preserved",
                needle: "Highlighted text",
            },
        ],
    },

    // ── 22. Mermaid code block ──
    {
        name: "mermaid",
        md: `\`\`\`mermaid
graph TD
A --> B
\`\`\``,
        checks: [
            {
                type: "html-contains",
                label: "<pre> for mermaid",
                needle: "<pre>",
            },
            { type: "rt-contains", label: "Graph content", needle: "A --> B" },
        ],
    },

    // ── 23. Links list ──
    {
        name: "links-list",
        md: `- [Basic syntax](https://help.obsidian.md/Basic)
- [Advanced syntax](https://help.obsidian.md/Advanced)`,
        checks: [
            { type: "html-contains", label: "<a> in list", needle: "<a href=" },
            {
                type: "rt-contains",
                label: "Link text",
                needle: "[Basic syntax]",
            },
        ],
    },

    // ── 24. Nbsp and breaks in blockquote ──
    {
        name: "nbsp-blockquote",
        md: `>Multiple&nbsp;&nbsp;&nbsp;adjacent&nbsp;&nbsp;&nbsp;spaces
> <br>
> and more text.`,
        checks: [
            {
                type: "html-contains",
                label: "<blockquote>",
                needle: "<blockquote>",
            },
            {
                type: "rt-contains",
                label: "Text preserved",
                needle: "more text",
            },
        ],
    },

    // ── 25. Comments (Obsidian-only) ──
    {
        name: "comments",
        md: `Visible text.

%%
This is a block comment.
%%`,
        checks: [
            {
                type: "html-contains",
                label: "Visible text in HTML",
                needle: "Visible text",
            },
            // %% comments are stripped in HTML — that's expected
        ],
    },

    // ── 26. Wikilinks (Obsidian-only) ──
    {
        name: "wikilinks",
        md: `See [[Foo]] and [[Bar|Baz]] for details.`,
        checks: [
            {
                type: "rt-contains",
                label: "[[Foo]] preserved",
                needle: "[[Foo]]",
            },
            {
                type: "rt-contains",
                label: "[[Bar|Baz]] preserved",
                needle: "[[Bar|Baz]]",
            },
            {
                type: "rt-not-contains",
                label: "no escaped bracket",
                needle: "\\[",
            },
        ],
    },

    // ── 27. Wikilinks inside list items ──
    {
        name: "wikilinks-in-list",
        md: `- Refers to [[Alpha]]
- Refers to [[Beta|Gamma]]`,
        checks: [
            {
                type: "rt-contains",
                label: "[[Alpha]] in list preserved",
                needle: "[[Alpha]]",
            },
            {
                type: "rt-contains",
                label: "[[Beta|Gamma]] in list preserved",
                needle: "[[Beta|Gamma]]",
            },
            {
                type: "rt-not-contains",
                label: "no escaped bracket",
                needle: "\\[",
            },
        ],
    },

    // ── 28. Wikilinks across hard line breaks (strictLineBreaks=false) ──
    {
        name: "wikilinks-line-breaks",
        md: `123
[[link]]
123`,
        checks: [
            {
                type: "rt-contains",
                label: "[[link]] preserved",
                needle: "[[link]]",
            },
            {
                type: "rt-contains",
                label: "line break before [[link]] preserved",
                needle: "123\n[[link]]",
            },
            {
                type: "rt-contains",
                label: "line break after [[link]] preserved",
                needle: "[[link]]\n123",
            },
        ],
    },
];

for (const point of testPoints) {
    describe(point.name, () => {
        let html: string;
        let rt: string;

        beforeAll(async () => {
            html = await convert.md2html(point.md, CONVERT_OPTS);
            rt = await convert.html2md(html, CONVERT_OPTS);
        });

        for (const check of point.checks) {
            test(check.label, () => {
                switch (check.type) {
                    case "html-contains":
                        expect(html).toContain(check.needle);
                        break;
                    case "html-not-contains":
                        expect(html).not.toContain(check.needle);
                        break;
                    case "rt-contains":
                        expect(rt).toContain(check.needle);
                        break;
                    case "rt-not-contains":
                        expect(rt).not.toContain(check.needle);
                        break;
                    case "html-regex":
                        expect(html).toMatch(check.pattern);
                        break;
                    case "rt-regex":
                        expect(rt).toMatch(check.pattern);
                        break;
                }
            });
        }

        // Idempotency: html2md(md2html(·)) must be a fixed point.
        //
        // Asserts `g(f(g(f(x)))) === g(f(x))`, not `f(g(f(x))) === f(x)`.
        // The round trip is allowed to canonicalize once — bullet markers
        // become `*`, `&nbsp;` becomes U+00A0, soft breaks around a literal
        // `<br>` collapse — because a test input need not already be in
        // canonical form. What must never happen is *drift*: an escape that
        // grows a backslash each pass, an entity that re-encodes, a `<span>`
        // that accumulates. Demanding equality on the first pass conflates
        // the two and fails on inputs that were simply written by hand.
        test("round-trip idempotent", async () => {
            const html2 = await convert.md2html(rt, CONVERT_OPTS);
            expect(await convert.html2md(html2, CONVERT_OPTS)).toBe(rt);
        });
    });
}
