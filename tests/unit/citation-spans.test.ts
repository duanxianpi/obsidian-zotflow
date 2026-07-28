/**
 * Citation/annotation span link wrap-strip tests, end-to-end through
 * ConvertService html2md/md2html.
 *
 * Migrated from scripts/_test-citation-spans-entry.ts.
 */
import { describe, test, expect } from "vitest";
import { ConvertService } from "worker/services/convert";
import { stripCitationSpanLinks } from "worker/convert/citation-span-links";

const convert = new ConvertService();

/** Real-world sample (user library 12985680). */
const ANNOTATION_PAYLOAD = encodeURIComponent(
    JSON.stringify({
        attachmentURI: "http://zotero.org/users/12985680/items/KPM4CY9J",
        annotationKey: "8U7YVR5M",
        color: "#ffd400",
        pageLabel: "1",
        position: { pageIndex: 0, rects: [[338.692, 547.223, 374.846, 557.683]] },
        citationItem: {
            uris: ["http://zotero.org/users/12985680/items/PI7B25T2"],
            locator: "1",
        },
    }),
);

const CITATION_PAYLOAD = encodeURIComponent(
    JSON.stringify({
        citationItems: [
            {
                uris: ["http://zotero.org/users/12985680/items/PI7B25T2"],
                locator: "1",
            },
        ],
        properties: {},
    }),
);

const NOTE_HTML =
    `<p><span class="highlight" data-annotation="${ANNOTATION_PAYLOAD}">“Niki Par”</span> ` +
    `<span class="citation" data-citation="${CITATION_PAYLOAD}">(<span class="citation-item">Vaswani et al., 2023, p. 1</span>)</span></p>`;

// NB: hast-util-to-html serializes `&` inside attribute values as
// `&#x26;` — the DOM decodes it back, so clicks receive the clean URL.
const EXPECTED_ANNO_HREF = `obsidian://zotflow?type=open-attachment&#x26;libraryID=12985680&#x26;key=KPM4CY9J&#x26;navigation=${encodeURIComponent(JSON.stringify({ annotationID: "8U7YVR5M" }))}`;
const EXPECTED_CITE_HREF =
    "obsidian://zotflow?type=open-note&#x26;libraryID=12985680&#x26;key=PI7B25T2";

describe("wrap (html2md with linkCitationSpans)", () => {
    test("highlight span content gets an annotation anchor", async () => {
        const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
        expect(md).toContain(
            `<a class="zotflow-span-link" href="${EXPECTED_ANNO_HREF}">“Niki Par”</a>`,
        );
    });

    test("citation span content gets an open-note anchor", async () => {
        const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
        expect(md).toContain(
            `<a class="zotflow-span-link" href="${EXPECTED_CITE_HREF}">(<span class="citation-item">Vaswani et al., 2023, p. 1</span>)</a>`,
        );
    });

    test("span payloads stay untouched", async () => {
        const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
        expect(md).toContain(`data-annotation="${ANNOTATION_PAYLOAD}"`);
        expect(md).toContain(`data-citation="${CITATION_PAYLOAD}"`);
    });

    test("disabled option leaves spans inert", async () => {
        const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: false });
        expect(md).not.toContain("zotflow-span-link");
    });

    test("group-library URI maps to group libraryID", async () => {
        const payload = encodeURIComponent(
            JSON.stringify({
                attachmentURI: "http://zotero.org/groups/777/items/ATT1",
                annotationKey: "ANNO1",
            }),
        );
        const html = `<p><span class="highlight" data-annotation="${payload}">x</span></p>`;
        const md = await convert.html2md(html, { linkCitationSpans: true });
        expect(md).toContain("libraryID=777&#x26;key=ATT1");
    });

    test("unresolvable payload stays unwrapped", async () => {
        const payload = encodeURIComponent(JSON.stringify({ color: "#ffd400" }));
        const html = `<p><span class="highlight" data-annotation="${payload}">x</span></p>`;
        const md = await convert.html2md(html, { linkCitationSpans: true });
        expect(md).not.toContain("zotflow-span-link");
    });
});

describe("strip (md2html) and round trip", () => {
    test("md2html strips anchors and restores original spans", async () => {
        const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
        const html = await convert.md2html(md, {});

        expect(html).not.toContain("zotflow-span-link");
        expect(html).not.toContain("obsidian://zotflow");
        expect(html).toContain(`data-annotation="${ANNOTATION_PAYLOAD}"`);
        expect(html).toContain(`data-citation="${CITATION_PAYLOAD}"`);
        expect(html).toContain(
            `<span class="citation-item">Vaswani et al., 2023, p. 1</span>`,
        );
        expect(html).toContain("“Niki Par”");
    });

    test("double cycle is stable", async () => {
        const md1 = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
        const html1 = await convert.md2html(md1, {});
        const md2 = await convert.html2md(html1, { linkCitationSpans: true });
        const html2 = await convert.md2html(md2, {});
        expect(html2).toBe(html1);
    });

    test("strip tolerates shuffled attribute order", () => {
        const html = `<p><span class="highlight" data-annotation="x"><a href="obsidian://zotflow?x" class="zotflow-span-link extra">text</a></span></p>`;
        const out = stripCitationSpanLinks(html);
        expect(out).not.toContain("<a");
        expect(out).toContain(">text</span>");
    });
});
