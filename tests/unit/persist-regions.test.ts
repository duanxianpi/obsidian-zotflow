/**
 * Persist-region splice utils — pure functions, no Obsidian, no DB.
 *
 * Migrated from scripts/_test-persist-regions-entry.ts.
 */
import { describe, test, expect } from "vitest";
import {
    extractPersistRegions,
    reinsertPersistRegions,
    ORPHAN_BEG_MARKER,
    ORPHAN_END_MARKER,
    ORPHAN_HEADING,
} from "utils/persist-regions";

const beg = (id: string) => `<!-- ZF_PERSIST_BEG_${id} -->`;
const end = (id: string) => `<!-- ZF_PERSIST_END_${id} -->`;

const EMPTY_EXTRACT = { regions: [], orphanSectionInner: null };

describe("extract", () => {
    test("no markers fast path", () => {
        const r = extractPersistRegions("# Note\n\nplain text\n");
        expect(r.regions).toHaveLength(0);
        expect(r.orphanSectionInner).toBeNull();
    });

    test("basic region content verbatim", () => {
        const doc = `# T\n${beg("summary")}\nline one\n\nline two\n${end("summary")}\ntail\n`;
        const r = extractPersistRegions(doc);
        expect(r.regions).toHaveLength(1);
        expect(r.regions[0]!.id).toBe("summary");
        expect(r.regions[0]!.content).toBe("line one\n\nline two");
    });

    test("empty region", () => {
        const r = extractPersistRegions(`${beg("a")}\n${end("a")}\n`);
        expect(r.regions[0]!.content).toBe("");
    });

    test("prose mention of ZF_PERSIST is ignored", () => {
        const r = extractPersistRegions(
            "The ZF_PERSIST_BEG_x token is documented here.\n",
        );
        expect(r.regions).toHaveLength(0);
    });

    test("marker text inside frontmatter is ignored", () => {
        const doc = `---\nnote: "${beg("fm")}"\n---\nbody\n`;
        expect(extractPersistRegions(doc).regions).toHaveLength(0);
    });

    test("CRLF document", () => {
        const doc = `# T\r\n${beg("a")}\r\nhello\r\nworld\r\n${end("a")}\r\n`;
        expect(extractPersistRegions(doc).regions[0]!.content).toBe(
            "hello\r\nworld",
        );
    });

    test("code fence limitation — markers matched anywhere", () => {
        const doc = `\`\`\`\n${beg("fenced")}\nx\n${end("fenced")}\n\`\`\`\n`;
        // Documented v1 limitation: fenced markers are still parsed.
        expect(extractPersistRegions(doc).regions).toHaveLength(1);
    });
});

describe("extract — throw cases", () => {
    test("missing id", () => {
        expect(() =>
            extractPersistRegions("<!-- ZF_PERSIST_BEG_ -->\n"),
        ).toThrow(/Malformed/);
    });

    test("invalid id chars", () => {
        expect(() =>
            extractPersistRegions("<!-- ZF_PERSIST_BEG_bad id -->\n"),
        ).toThrow(/Malformed/);
    });

    test("marker not on its own line", () => {
        expect(() =>
            extractPersistRegions(`text ${beg("a")}\nx\n${end("a")}\n`),
        ).toThrow(/Malformed/);
    });

    test("malformed comment syntax", () => {
        expect(() =>
            extractPersistRegions("<!--ZF_PERSIST_BEG_a-->\n"),
        ).toThrow(/Malformed/);
    });

    test("duplicate id", () => {
        const doc = `${beg("a")}\nx\n${end("a")}\n${beg("a")}\ny\n${end("a")}\n`;
        expect(() => extractPersistRegions(doc)).toThrow(/Duplicate/);
    });

    test("unclosed BEG", () => {
        expect(() => extractPersistRegions(`${beg("a")}\nx\n`)).toThrow(
            /Unclosed/,
        );
    });

    test("unmatched END", () => {
        expect(() => extractPersistRegions(`x\n${end("a")}\n`)).toThrow(
            /Unmatched/,
        );
    });

    test("nested regions", () => {
        const doc = `${beg("a")}\n${beg("b")}\nx\n${end("b")}\n${end("a")}\n`;
        expect(() => extractPersistRegions(doc)).toThrow(/Nested/);
    });

    test("mismatched END id", () => {
        expect(() =>
            extractPersistRegions(`${beg("a")}\nx\n${end("b")}\n`),
        ).toThrow(/Mismatched/);
    });

    test("error carries line number", () => {
        expect(() =>
            extractPersistRegions("line1\nline2\n<!-- ZF_PERSIST_BEG_ -->\n"),
        ).toThrow(/line 3/);
    });
});

const TPL = `---\nzotero-key: K\n---\n# Title\n\n${beg("summary")}\n\n${end("summary")}\n\nrendered tail\n`;

describe("reinsert — id match", () => {
    test("matched id replaces rendered default", () => {
        const old = `---\nzotero-key: K\n---\n# Old\n\n${beg("summary")}\nmy precious notes\n${end("summary")}\n`;
        const r = reinsertPersistRegions(TPL, extractPersistRegions(old));
        expect(r.content).toContain(
            `${beg("summary")}\nmy precious notes\n${end("summary")}`,
        );
        expect(r.content).not.toContain(ORPHAN_BEG_MARKER);
        expect(r.newOrphans).toHaveLength(0);
    });

    test("fresh region keeps rendered default", () => {
        const tpl = `${beg("summary")}\nDefault text\n${end("summary")}\n`;
        expect(reinsertPersistRegions(tpl, EMPTY_EXTRACT).content).toContain(
            "Default text",
        );
    });

    test("user-cleared region stays empty", () => {
        const old = `${beg("summary")}\n\n${end("summary")}\n`;
        const tpl = `${beg("summary")}\nDefault text\n${end("summary")}\n`;
        const r = reinsertPersistRegions(tpl, extractPersistRegions(old));
        expect(r.content).not.toContain("Default text");
    });

    test("multiple regions, order independent", () => {
        const old = `${beg("a")}\nAAA\n${end("a")}\n${beg("b")}\nBBB\n${end("b")}\n`;
        const tpl = `${beg("b")}\n\n${end("b")}\nmiddle\n${beg("a")}\n\n${end("a")}\n`;
        const r = reinsertPersistRegions(tpl, extractPersistRegions(old));
        // Contents land at their template positions, not their source order.
        expect(r.content.indexOf("BBB")).toBeLessThan(r.content.indexOf("AAA"));
    });

    test("idempotent across cycles", () => {
        const old = `${beg("summary")}\nkeep me\n${end("summary")}\n`;
        const first = reinsertPersistRegions(TPL, extractPersistRegions(old));
        const second = reinsertPersistRegions(
            TPL,
            extractPersistRegions(first.content),
        );
        expect(second.content).toBe(first.content);
    });

    test("CRLF render uses CRLF for spliced lines", () => {
        const old = `${beg("a")}\nuser text\n${end("a")}\n`;
        const tpl = `# T\r\n${beg("a")}\r\n\r\n${end("a")}\r\n`;
        const r = reinsertPersistRegions(tpl, extractPersistRegions(old));
        expect(r.content).toContain(`${beg("a")}\r\nuser text\r\n${end("a")}`);
    });
});

describe("reinsert — orphans", () => {
    test("empty orphan silently dropped", () => {
        const old = `${beg("gone")}\n   \n${end("gone")}\n`;
        const r = reinsertPersistRegions(
            "# fresh render\n",
            extractPersistRegions(old),
        );
        expect(r.newOrphans).toHaveLength(0);
        expect(r.content).not.toContain(ORPHAN_BEG_MARKER);
        expect(r.content).not.toContain("gone");
    });

    test("non-empty demoted to bare labelled content", () => {
        const old = `${beg("gone")}\nsave this\n${end("gone")}\n`;
        const r = reinsertPersistRegions(
            "# fresh render\n",
            extractPersistRegions(old),
        );
        expect(r.newOrphans).toHaveLength(1);
        expect(r.newOrphans[0]!.id).toBe("gone");
        expect(r.content).toContain(ORPHAN_BEG_MARKER);
        expect(r.content).toContain(ORPHAN_END_MARKER);
        expect(r.content).toContain(ORPHAN_HEADING);
        expect(r.content).toContain("**`gone`**");
        expect(r.content).toContain("save this");
        expect(r.content).not.toContain(beg("gone"));
    });

    test("section round-trips verbatim, new orphans appended after", () => {
        // Cycle 1: region "a" orphaned.
        const old1 = `${beg("a")}\nfirst orphan\n${end("a")}\n`;
        const c1 = reinsertPersistRegions(
            "render\n",
            extractPersistRegions(old1),
        );

        // Cycle 2: nothing new — section must survive byte-identically and the
        // existing orphan must NOT be re-reported (the Notice fires once).
        const c2 = reinsertPersistRegions(
            "render\n",
            extractPersistRegions(c1.content),
        );
        expect(c2.content).toBe(c1.content);
        expect(c2.newOrphans).toHaveLength(0);

        // Cycle 3: region "b" orphaned too.
        const old3 =
            `${beg("b")}\nsecond orphan\n${end("b")}\nrender\n` +
            c2.content.slice("render\n".length);
        const c3 = reinsertPersistRegions(
            "render\n",
            extractPersistRegions(old3),
        );
        expect(c3.newOrphans).toHaveLength(1);
        expect(c3.content.indexOf("first orphan")).toBeLessThan(
            c3.content.indexOf("second orphan"),
        );
        expect(c3.content.split(ORPHAN_BEG_MARKER)).toHaveLength(2);
    });

    test("marker-like text inside section is plain text", () => {
        const doc = `body\n${ORPHAN_BEG_MARKER}\n${ORPHAN_HEADING}\n\n**\`x\`**\n<!-- ZF_PERSIST_BEG_ -->\nbroken marker as content\n${ORPHAN_END_MARKER}\n`;
        const ex = extractPersistRegions(doc); // must NOT throw
        expect(ex.orphanSectionInner).toContain("<!-- ZF_PERSIST_BEG_ -->");
        expect(reinsertPersistRegions("render\n", ex).content).toContain(
            "broken marker as content",
        );
    });

    test("emptied section is dropped", () => {
        const doc = `body\n${ORPHAN_BEG_MARKER}\n${ORPHAN_HEADING}\n\n**\`x\`**\n\n${ORPHAN_END_MARKER}\n`;
        const r = reinsertPersistRegions("render\n", extractPersistRegions(doc));
        expect(r.content).not.toContain(ORPHAN_BEG_MARKER);
    });

    test("dangling sentinel degrades to no span", () => {
        const doc = `body\n${ORPHAN_BEG_MARKER}\nstranded\n`;
        const ex = extractPersistRegions(doc); // must NOT throw
        expect(ex.orphanSectionInner).toBeNull();
        expect(reinsertPersistRegions("render\n", ex).content).not.toContain(
            ORPHAN_BEG_MARKER,
        );
    });
});

describe("reinsert — render validation", () => {
    test("template emitting orphan sentinel throws", () => {
        const tpl = `${ORPHAN_BEG_MARKER}\n${ORPHAN_END_MARKER}\n`;
        expect(() => reinsertPersistRegions(tpl, EMPTY_EXTRACT)).toThrow(
            /must not emit/,
        );
    });

    test("duplicate id in render throws", () => {
        const tpl = `${beg("a")}\n\n${end("a")}\n${beg("a")}\n\n${end("a")}\n`;
        expect(() => reinsertPersistRegions(tpl, EMPTY_EXTRACT)).toThrow(
            /Duplicate/,
        );
    });

    test("marker text via synced content throws, not garbles", () => {
        // e.g. a Zotero note body contained a lone END marker that survived html2md
        const tpl = `# T\n${end("evil")}\n`;
        expect(() => reinsertPersistRegions(tpl, EMPTY_EXTRACT)).toThrow(
            /Unmatched/,
        );
    });
});
