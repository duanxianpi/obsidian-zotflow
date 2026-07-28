/**
 * HTML → MD → HTML round-trip (Zotero note-editor content).
 *
 * Each test point is an isolated HTML snippet. The wrapper div is shared but
 * each point runs html2md → md2html independently, and every check inside a
 * point becomes its own test case so a failure names the exact property lost.
 *
 * Migrated from scripts/_test-html-roundtrip-entry.ts.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { ConvertService } from "worker/services/convert";

import type { Html2MdOptions } from "worker/convert/html-to-md";

const convert = new ConvertService();

const WRAPPER_OPEN = `<div data-citation-items="%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FU285LCSS%22%5D%2C%22itemData%22%3A%7B%22id%22%3A%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FU285LCSS%22%2C%22type%22%3A%22article-journal%22%2C%22title%22%3A%22Bitcoin%3A%20A%20Peer-to-Peer%20Electronic%20Cash%20System%22%2C%22author%22%3A%5B%7B%22family%22%3A%22Nakamoto%22%2C%22given%22%3A%22Satoshi%22%7D%5D%7D%7D%5D" data-schema-version="5">`;
const WRAPPER_CLOSE = `</div>`;

/**
 * Shared conversion options.
 *
 * `strictLineBreaks` mirrors ONE vault setting, so both directions must be
 * given the same value — production sources both from
 * `vaultConfig.strictLineBreaks` (see item-note.ts). A mismatched pair models
 * a configuration that cannot occur and makes `<br>` round-tripping look
 * broken when it is not.
 */
const STRICT_LINE_BREAKS = false;

const HTML2MD_OPTS: Html2MdOptions = {
    annotationImageFolder: "ZotFlow/images",
    strictLineBreaks: STRICT_LINE_BREAKS,
};

const MD2HTML_OPTS = { strictLineBreaks: STRICT_LINE_BREAKS };

function wrap(body: string): string {
    return `${WRAPPER_OPEN}\n${body}\n${WRAPPER_CLOSE}`;
}

interface TestPoint {
    name: string;
    html: string;
    checks: Check[];
}

type Check =
    | { type: "contains"; label: string; needle: string }
    | { type: "not-contains"; label: string; needle: string }
    | { type: "md-contains"; label: string; needle: string }
    | { type: "md-not-contains"; label: string; needle: string }
    | { type: "regex"; label: string; pattern: RegExp }
    | { type: "md-regex"; label: string; pattern: RegExp };

const testPoints: TestPoint[] = [
    {
        name: "link destinations with ampersands",
        html: `<p><a href="https://example.com/?a=1&amp;b=2">multi param</a> and <a href="obsidian://zotflow?type=open-note&amp;libraryID=1&amp;key=K">zotflow</a></p>`,
        checks: [
            {
                type: "md-contains",
                label: "raw & in web destination (no backslash escape)",
                needle: "(https://example.com/?a=1&b=2)",
            },
            {
                type: "md-contains",
                label: "raw & in zotflow destination",
                needle: "(obsidian://zotflow?type=open-note&libraryID=1&key=K)",
            },
            {
                type: "md-not-contains",
                label: "no \\& anywhere",
                needle: "\\&",
            },
            {
                type: "contains",
                label: "web href survives round trip",
                needle: 'href="https://example.com/?a=1&#x26;b=2"',
            },
        ],
    },
    // ── 1. Paragraph with inline marks ──
    {
        name: "paragraph-marks",
        html: `<p>Text - <strong>B</strong><em>I</em><u>U</u><span style="text-decoration: line-through">S</span><sub>2</sub><sup>2</sup><span style="color: #99CC00">T</span><span style="background-color: #99CC00">B</span><a href="g">L</a><code>C</code></p>`,
        checks: [
            {
                type: "contains",
                label: "<strong> preserved",
                needle: "<strong>",
            },
            { type: "contains", label: "<em> preserved", needle: "<em>" },
            { type: "contains", label: "<code> preserved", needle: "<code>" },
            {
                type: "contains",
                label: "link preserved",
                needle: '<a href="g">',
            },
            { type: "md-contains", label: "strikethrough ~~", needle: "~~S~~" },
        ],
    },

    // ── 2. Headings h1–h6 ──
    {
        name: "headings",
        html: `<h1>Heading 1 - <strong>B</strong><em>I</em></h1>
<h2>Heading 2</h2>
<h3>Heading 3</h3>
<h4>Heading 4</h4>
<h5>Heading 5</h5>
<h6>Heading 6</h6>`,
        checks: [
            { type: "contains", label: "h1", needle: "<h1>" },
            { type: "contains", label: "h6", needle: "<h6>" },
            { type: "md-contains", label: "# in MD", needle: "# Heading 1" },
            {
                type: "md-contains",
                label: "###### in MD",
                needle: "###### Heading 6",
            },
        ],
    },

    // ── 3. Math (inline + display) ──
    {
        name: "math",
        html: `<p><span class="math">$f(x)=1$</span> </p>
<pre class="math">$$f(x)=1$$</pre>`,
        checks: [
            {
                type: "contains",
                label: "Math inline span",
                needle: 'class="math"',
            },
            {
                type: "contains",
                label: "Math display pre",
                needle: '<pre class="math">',
            },
            {
                type: "md-contains",
                label: "Inline $…$ in MD",
                needle: "$f(x)=1$",
            },
            {
                type: "md-contains",
                label: "Display $$…$$ in MD",
                needle: "$$\nf(x)=1\n$$",
            },
        ],
    },

    // ── 4. Annotations (underline + citation + highlight) ──
    {
        name: "annotations",
        html: `<p><span class="underline" data-annotation="%7B%22attachmentURI%22%3A%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FC6IDLDLW%22%2C%22annotationKey%22%3A%222ESAYRD9%22%7D"><u style="text-decoration-color: #5fb236">"Commerce on the Internet"</u></span> <span class="citation" data-citation="%7B%22citationItems%22%3A%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FU285LCSS%22%5D%2C%22locator%22%3A%221%22%7D%5D%2C%22properties%22%3A%7B%7D%7D">(<span class="citation-item">Nakamoto, p. 1</span>)</span></p>
<blockquote><span class="highlight" data-annotation="%7B%22attachmentURI%22%3A%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FC6IDLDLW%22%2C%22annotationKey%22%3A%222ESAYRD9%22%7D">Commerce on the Internet</span> <span class="citation" data-citation="%7B%22citationItems%22%3A%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FU285LCSS%22%5D%2C%22locator%22%3A%221%22%7D%5D%2C%22properties%22%3A%7B%7D%7D">(<span class="citation-item">Nakamoto, p. 1</span>)</span></blockquote>`,
        checks: [
            {
                type: "contains",
                label: "Citation span",
                needle: 'class="citation"',
            },
            {
                type: "contains",
                label: "Highlight span",
                needle: 'class="highlight"',
            },
            {
                type: "contains",
                label: "Underline annotation",
                needle: 'class="underline"',
            },
        ],
    },

    // ── 5. Annotated image with <br> ──
    {
        name: "annotated-image",
        html: `<p><img alt="" data-attachment-key="DDAAFF11" data-annotation="%7B%22attachmentURI%22%3A%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FC6IDLDLW%22%2C%22annotationKey%22%3A%22AD4NKL28%22%7D" width="663" height="282"><br><span class="citation" data-citation="%7B%22citationItems%22%3A%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F4100175%2Fitems%2FU285LCSS%22%5D%2C%22locator%22%3A%225%22%7D%5D%2C%22properties%22%3A%7B%7D%7D">(<span class="citation-item">Nakamoto, p. 5</span>)</span></p>`,
        checks: [
            {
                type: "contains",
                label: "Annotated image attrs",
                needle: "data-attachment-key=",
            },
            { type: "contains", label: "<br> preserved", needle: "<br>" },
            {
                type: "md-contains",
                label: "MD image syntax",
                needle: "![<img ",
            },
            {
                type: "md-contains",
                label: "Width suffix in MD",
                needle: "| 663]",
            },
            {
                type: "md-contains",
                label: "Image URL in MD",
                needle: "(ZotFlow/images/DDAAFF11.png)",
            },
            {
                type: "md-not-contains",
                label: "No backslash break in MD",
                needle: "\\\n",
            },
        ],
    },

    // ── 6. External image ──
    {
        name: "external-image",
        html: `<p><img src="https://example.com/photo.jpg"/> </p>`,
        checks: [
            {
                type: "contains",
                label: "Image src",
                needle: "https://example.com/photo.jpg",
            },
            {
                type: "md-contains",
                label: "![…](…) in MD",
                needle: "![](https://example.com/photo.jpg)",
            },
        ],
    },

    // ── 7. Non-breaking spaces ──
    {
        name: "nbsp-spaces",
        html: `<p>Multiple     &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;spaces</p>`,
        checks: [
            {
                type: "contains",
                label: "Content preserved",
                needle: "Multiple",
            },
            { type: "contains", label: "Spaces text", needle: "spaces" },
        ],
    },

    // ── 8. Code block (pre) ──
    {
        name: "code-block",
        html: `<pre>cd ~/Desktop
line 2
line 3</pre>`,
        checks: [
            { type: "contains", label: "<pre> round-tripped", needle: "<pre>" },
            {
                type: "md-contains",
                label: "Fenced code in MD",
                needle: "```\ncd ~/Desktop",
            },
        ],
    },

    // ── 9. Blockquote ──
    {
        name: "blockquote",
        html: `<blockquote><p>Blockquote text</p>
<h1>Heading inside</h1>
<ol><li><p>numbered item</p></li></ol>
</blockquote>`,
        checks: [
            {
                type: "contains",
                label: "Blockquote tag",
                needle: "<blockquote>",
            },
            {
                type: "md-contains",
                label: "> prefix in MD",
                needle: "> Blockquote text",
            },
        ],
    },

    // ── 10. Nested list ──
    {
        name: "nested-list",
        html: `<ul>
<li><p>Top item</p>
    <ol>
        <li>Sub one</li>
        <li>Sub two</li>
    </ol>
</li>
</ul>`,
        checks: [
            { type: "contains", label: "Outer <ul>", needle: "<ul>" },
            { type: "contains", label: "Inner <ol>", needle: "<ol>" },
            {
                type: "md-contains",
                label: "Nested indent in MD",
                needle: "1. Sub one",
            },
        ],
    },

    // ── 11. Table with header ──
    {
        name: "table",
        html: `<table>
<thead><tr><th>Col A</th><th>Col B</th></tr></thead>
<tbody><tr><td><p>Cell 1</p></td><td><p>Cell 2</p></td></tr></tbody>
</table>`,
        checks: [
            { type: "contains", label: "<th> present", needle: "<th>" },
            {
                type: "md-contains",
                label: "Pipe table in MD",
                needle: "| Col A",
            },
        ],
    },

    // ── 12. Horizontal rule ──
    {
        name: "horizontal-rule",
        html: `<p>Before</p><hr/><p>After</p>`,
        checks: [
            { type: "contains", label: "<hr> tag", needle: "<hr" },
            {
                type: "md-regex",
                label: "HR syntax in MD",
                pattern: /^\*{3,}$/m,
            },
        ],
    },

    // ── 13. Marks list (strong, em, underline, strike, sub, sup, color) ──
    {
        name: "marks-list",
        html: `<ol>
<li><p><strong>strong</strong></p></li>
<li><p><em>emphasis</em></p></li>
<li><p><u>underline</u></p></li>
<li><p><span style="text-decoration: line-through">strike</span></p></li>
<li><p>O<sub>2</sub></p></li>
<li><p>X<sup>2</sup></p></li>
<li><p><code>inline</code> code</p></li>
<li><p><span style="color: #FF0000">text</span> color</p></li>
<li><p><span style="background-color: #99CC00">background</span> color</p></li>
</ol>`,
        checks: [
            { type: "contains", label: "Strong", needle: "<strong>" },
            { type: "contains", label: "Emphasis", needle: "<em>" },
            { type: "contains", label: "Color span", needle: "color:" },
            {
                type: "md-contains",
                label: "~~ strike in MD",
                needle: "~~strike~~",
            },
        ],
    },

    // ── 14. Wrapper div preservation ──
    {
        name: "wrapper",
        html: `<p>Simple content.</p>`,
        checks: [
            {
                type: "regex",
                label: "Wrapper <div> restored",
                pattern: /^<div /,
            },
            {
                type: "contains",
                label: "data-schema-version",
                needle: "data-schema-version=",
            },
            {
                type: "contains",
                label: "data-citation-items",
                needle: "data-citation-items=",
            },
        ],
    },

    // ── 15. Definition list ──
    {
        name: "definition-list",
        html: `<dl>
    <dt>Beast of Bodmin</dt>
    <dd>A large feline inhabiting Bodmin Moor.</dd>
    <dt>Morgawr</dt>
    <dd>A sea serpent.</dd>
</dl>`,
        checks: [
            {
                type: "contains",
                label: "DT content",
                needle: "Beast of Bodmin",
            },
            { type: "contains", label: "DD content", needle: "A large feline" },
        ],
    },
];

for (const point of testPoints) {
    describe(point.name, () => {
        let md: string;
        let htmlOut: string;

        beforeAll(async () => {
            md = await convert.html2md(wrap(point.html), HTML2MD_OPTS);
            htmlOut = await convert.md2html(md, MD2HTML_OPTS);
        });

        for (const check of point.checks) {
            test(check.label, () => {
                switch (check.type) {
                    case "contains":
                        expect(htmlOut).toContain(check.needle);
                        break;
                    case "not-contains":
                        expect(htmlOut).not.toContain(check.needle);
                        break;
                    case "md-contains":
                        expect(md).toContain(check.needle);
                        break;
                    case "md-not-contains":
                        expect(md).not.toContain(check.needle);
                        break;
                    case "regex":
                        expect(htmlOut).toMatch(check.pattern);
                        break;
                    case "md-regex":
                        expect(md).toMatch(check.pattern);
                        break;
                }
            });
        }

        test("double round-trip stable", async () => {
            expect(await convert.html2md(htmlOut, HTML2MD_OPTS)).toBe(md);
        });
    });
}
