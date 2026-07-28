/**
 * Note link conversion tests (pure functions, fake resolver).
 *
 * Migrated from scripts/_test-note-links-entry.ts.
 */
import { describe, test, expect } from "vitest";
import {
    zotflowToZoteroLinks,
    zoteroToZotflowLinks,
} from "worker/convert/note-links";

import type { NoteLinkResolver } from "worker/convert/note-links";

/** Personal library 1; group library 777; annotation ANNO1 → attachment ATT1. */
const resolver: NoteLinkResolver = {
    async getAnnotationParentKey(_libraryID, annotationKey) {
        return annotationKey === "ANNO1" ? "ATT1" : null;
    },
    async isGroupLibrary(libraryID) {
        if (libraryID === 1) return false;
        if (libraryID === 777) return true;
        return null;
    },
    async getPersonalLibraryID() {
        return 1;
    },
};

/** Resolver that knows nothing — everything should be left untouched. */
const blindResolver: NoteLinkResolver = {
    getAnnotationParentKey: async () => null,
    isGroupLibrary: async () => null,
    getPersonalLibraryID: async () => null,
};

const zf = (q: string) => `obsidian://zotflow?${q}`;

describe("outbound: ZotFlow → Zotero", () => {
    test("open-note → select (personal)", async () => {
        const html = `<a href="${zf("type=open-note&libraryID=1&key=ITEM1")}">x</a>`;
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            `<a href="zotero://select/library/items/ITEM1">x</a>`,
        );
    });

    test("open-note → select (group prefix)", async () => {
        const html = zf("type=open-note&libraryID=777&key=ITEM1");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            "zotero://select/groups/777/items/ITEM1",
        );
    });

    test("open-attachment → open-pdf", async () => {
        const html = zf("type=open-attachment&libraryID=1&key=ATT1");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            "zotero://open-pdf/library/items/ATT1",
        );
    });

    test("open-annotation resolves parent attachment", async () => {
        const html = zf("type=open-annotation&libraryID=1&key=ANNO1");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            "zotero://open-pdf/library/items/ATT1?annotation=ANNO1",
        );
    });

    test("unresolvable annotation left untouched", async () => {
        const html = zf("type=open-annotation&libraryID=1&key=GHOST");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(html);
    });

    test("navigation with annotationID → ?annotation", async () => {
        const nav = encodeURIComponent(JSON.stringify({ annotationID: "ANNO1" }));
        const html = zf(
            `type=open-attachment&libraryID=1&key=ATT1&navigation=${nav}`,
        );
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            "zotero://open-pdf/library/items/ATT1?annotation=ANNO1",
        );
    });

    test("navigation with position.pageIndex → ?page (1-based)", async () => {
        const nav = encodeURIComponent(
            JSON.stringify({
                position: { pageIndex: 0, rects: [[184.5, 347.0, 273.9, 355.7]] },
                selectedText: "g models also connec",
                pageLabel: 1,
            }),
        );
        const html = zf(
            `type=open-attachment&libraryID=1&key=KPM4CY9J&navigation=${nav}`,
        );
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            "zotero://open-pdf/library/items/KPM4CY9J?page=1",
        );
    });

    test("html-escaped &amp; separators are parsed", async () => {
        const html = `<a href="obsidian://zotflow?type=open-attachment&amp;libraryID=1&amp;key=ATT1">x</a>`;
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            `<a href="zotero://open-pdf/library/items/ATT1">x</a>`,
        );
    });

    test("numeric-entity &#x26; separators are parsed (md2html output)", async () => {
        const html = `<a href="obsidian://zotflow?type=open-note&#x26;libraryID=1&#x26;key=PI7B25T2">Ashish Vaswani (2023)</a>`;
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            `<a href="zotero://select/library/items/PI7B25T2">Ashish Vaswani (2023)</a>`,
        );
    });

    test("unknown library left untouched", async () => {
        const html = zf("type=open-attachment&libraryID=99&key=ATT1");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(html);
    });

    test("unknown type left untouched", async () => {
        const html = zf("type=open-something&libraryID=1&key=K");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(html);
    });
});

describe("inbound: Zotero → ZotFlow", () => {
    test("select → open-note (personal)", async () => {
        const html = `<a href="zotero://select/library/items/ITEM1">x</a>`;
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            `<a href="${zf("type=open-note&libraryID=1&key=ITEM1")}">x</a>`,
        );
    });

    test("select with group prefix", async () => {
        const html = "zotero://select/groups/777/items/ITEM1";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            zf("type=open-note&libraryID=777&key=ITEM1"),
        );
    });

    test("open-pdf?annotation → open-annotation", async () => {
        const html = "zotero://open-pdf/library/items/ATT1?annotation=ANNO1";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            zf("type=open-annotation&libraryID=1&key=ANNO1"),
        );
    });

    test("open-pdf?page → open-attachment with navigation", async () => {
        const html = "zotero://open-pdf/library/items/ATT1?page=3";
        const navigation = encodeURIComponent(JSON.stringify({ pageIndex: 2 }));
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            zf(
                `type=open-attachment&libraryID=1&key=ATT1&navigation=${navigation}`,
            ),
        );
    });

    test("bare open-pdf → open-attachment", async () => {
        const html = "zotero://open-pdf/groups/777/items/ATT1";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            zf("type=open-attachment&libraryID=777&key=ATT1"),
        );
    });

    test("unknown query param left untouched", async () => {
        const html = "zotero://open-pdf/library/items/ATT1?sel=abc";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(html);
    });

    test("unknown personal library left untouched", async () => {
        const html = "zotero://select/library/items/ITEM1";
        expect(await zoteroToZotflowLinks(html, blindResolver)).toBe(html);
    });

    test("markdown link destination terminates at closing paren", async () => {
        const md = "see [item](zotero://select/library/items/ITEM1) here";
        expect(await zoteroToZotflowLinks(md, resolver)).toBe(
            `see [item](${zf("type=open-note&libraryID=1&key=ITEM1")}) here`,
        );
    });
});

describe("Zotero 7 generic `open` + Better Notes note links", () => {
    test("zotero://open behaves like open-pdf (annotation)", async () => {
        const html = "zotero://open/library/items/ATT1?annotation=ANNO1";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            zf("type=open-annotation&libraryID=1&key=ANNO1"),
        );
    });

    test("zotero://open bare and with page", async () => {
        expect(
            await zoteroToZotflowLinks(
                "zotero://open/groups/777/items/ATT1",
                resolver,
            ),
        ).toBe(zf("type=open-attachment&libraryID=777&key=ATT1"));

        const navigation = encodeURIComponent(JSON.stringify({ pageIndex: 4 }));
        expect(
            await zoteroToZotflowLinks(
                "zotero://open/library/items/ATT1?page=5",
                resolver,
            ),
        ).toBe(
            zf(
                `type=open-attachment&libraryID=1&key=ATT1&navigation=${navigation}`,
            ),
        );
    });

    test("zotero://open with unknown param left untouched", async () => {
        const html = "zotero://open/library/items/ATT1?cfi=epubcfi(/6/4)";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(html);
    });

    test("Better Notes u-form → open-note (anchors dropped)", async () => {
        const html = `<a href="zotero://note/u/NOTE1/?ignore=1&line=5#sel">note</a>`;
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            `<a href="${zf("type=open-item-note&libraryID=1&key=NOTE1")}">note</a>`,
        );
    });

    test("Better Notes bare u-form without trailing slash", async () => {
        const html = "zotero://note/u/NOTE1";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            zf("type=open-item-note&libraryID=1&key=NOTE1"),
        );
    });

    test("Better Notes numeric (internal group id) form untouched", async () => {
        const html = "zotero://note/12345/NOTE1/?line=2";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(html);
    });

    test("unexpected deeper note path left fully untouched", async () => {
        const html = "zotero://note/u/NOTE1/extra/segments";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(html);
    });

    test("deeper standard path left fully untouched", async () => {
        const html = "zotero://select/library/items/ITEM1/extra";
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(html);
    });

    test("autolink becomes a resource link keeping zotero text", async () => {
        // html2md emits <url> when a link's text equals its URL (Zotero
        // "Copy Link" pastes) — the visible text must NOT become a raw
        // zotflow URL.
        const md = "<zotero://open-pdf/library/items/KPM4CY9J?annotation=KRVQWZXH>";
        expect(await zoteroToZotflowLinks(md, resolver)).toBe(
            `[zotero://open-pdf/library/items/KPM4CY9J?annotation=KRVQWZXH](${zf("type=open-annotation&libraryID=1&key=KRVQWZXH")})`,
        );
    });

    test("unconvertible autolink stays an autolink", async () => {
        const md = "<zotero://open-pdf/library/items/ATT1?cfi=x>";
        expect(await zoteroToZotflowLinks(md, resolver)).toBe(md);
    });

    test("Better Notes autolink converts too", async () => {
        const md = "<zotero://note/u/NOTE1/?line=3>";
        expect(await zoteroToZotflowLinks(md, resolver)).toBe(
            `[zotero://note/u/NOTE1/?line=3](${zf("type=open-item-note&libraryID=1&key=NOTE1")})`,
        );
    });

    test("outbound open-item-note (personal) emits Better Notes form", async () => {
        const html = zf("type=open-item-note&libraryID=1&key=NOTE1");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            "zotero://note/u/NOTE1/",
        );
    });

    test("outbound open-item-note (group) falls back to select", async () => {
        const html = zf("type=open-item-note&libraryID=777&key=NOTE1");
        expect(await zotflowToZoteroLinks(html, resolver)).toBe(
            "zotero://select/groups/777/items/NOTE1",
        );
    });

    test("Better Notes link is stable after first anchor drop", async () => {
        const original = "zotero://note/u/NOTE1/?line=5";
        const displayed = await zoteroToZotflowLinks(original, resolver);
        const stored = await zotflowToZoteroLinks(displayed, resolver);
        expect(stored).toBe("zotero://note/u/NOTE1/");

        const displayed2 = await zoteroToZotflowLinks(stored, resolver);
        expect(await zotflowToZoteroLinks(displayed2, resolver)).toBe(stored);
    });
});

describe("round trips", () => {
    test("annotation link is stable", async () => {
        const stored = "zotero://open-pdf/library/items/ATT1?annotation=ANNO1";
        const displayed = await zoteroToZotflowLinks(stored, resolver);
        expect(await zotflowToZoteroLinks(displayed, resolver)).toBe(stored);
    });

    test("page link is stable", async () => {
        const stored = "zotero://open-pdf/library/items/ATT1?page=5";
        const displayed = await zoteroToZotflowLinks(stored, resolver);
        expect(await zotflowToZoteroLinks(displayed, resolver)).toBe(stored);
    });

    test("select link is stable", async () => {
        const stored = "zotero://select/groups/777/items/ITEM1";
        const displayed = await zoteroToZotflowLinks(stored, resolver);
        expect(await zotflowToZoteroLinks(displayed, resolver)).toBe(stored);
    });

    test("multiple links and surrounding prose convert independently", async () => {
        const html =
            `<p>see <a href="zotero://select/library/items/A1">item</a> and ` +
            `<a href="zotero://open-pdf/groups/777/items/B2?annotation=ANNO1">note</a>, ` +
            `plus plain text zotero://unrelated/thing</p>`;
        expect(await zoteroToZotflowLinks(html, resolver)).toBe(
            `<p>see <a href="${zf("type=open-note&libraryID=1&key=A1")}">item</a> and ` +
                `<a href="${zf("type=open-annotation&libraryID=777&key=ANNO1")}">note</a>, ` +
                `plus plain text zotero://unrelated/thing</p>`,
        );
    });
});
