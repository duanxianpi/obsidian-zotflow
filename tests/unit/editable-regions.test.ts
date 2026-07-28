/**
 * Editable-region parser tests (pure CM6 Text, no Obsidian).
 *
 * Migrated from scripts/_test-editable-regions-entry.ts.
 */
import { describe, test, expect } from "vitest";
import { Text } from "@codemirror/state";
import { parseEditableRegions } from "ui/editor/editable-region-parser";

import type { EditableRegion } from "ui/editor/editable-region-parser";

function parse(str: string): {
    regions: EditableRegion[];
    content: (r: EditableRegion) => string;
} {
    const doc = Text.of(str.split("\n"));
    return {
        regions: parseEditableRegions(doc),
        content: (r) => doc.sliceString(r.from, r.to),
    };
}

const B = (t: string, k: string) => `<!-- ZF_${t}_BEG_${k} -->`;
const E = (t: string, k: string) => `<!-- ZF_${t}_END_${k} -->`;

describe("block form", () => {
    test("NOTE region content between marker lines", () => {
        const str = `# T\n${B("NOTE", "K1")}\nline one\nline two\n${E("NOTE", "K1")}\ntail`;
        const { regions, content } = parse(str);
        expect(regions).toHaveLength(1);
        expect(regions[0]!.type).toBe("NOTE");
        expect(regions[0]!.key).toBe("K1");
        expect(content(regions[0]!)).toBe("line one\nline two");
    });

    test("marker spans cover exactly the marker text", () => {
        const str = `${B("NOTE", "K1")}\nx\n${E("NOTE", "K1")}`;
        const doc = Text.of(str.split("\n"));
        const r = parseEditableRegions(doc)[0]!;
        expect(doc.sliceString(r.begFrom, r.begTo)).toBe(B("NOTE", "K1"));
        expect(doc.sliceString(r.endFrom, r.endTo)).toBe(E("NOTE", "K1"));
    });

    test("ANNO inside blockquote keeps `> ` prefix in content", () => {
        const str = `> ${B("ANNO", "K1")}\n> comment\n> ${E("ANNO", "K1")}`;
        const { regions, content } = parse(str);
        expect(regions).toHaveLength(1);
        expect(content(regions[0]!)).toBe("> comment");
    });

    test("adjacent markers form a zero-width region", () => {
        const str = `${B("PERSIST", "summary")}\n${E("PERSIST", "summary")}`;
        const { regions } = parse(str);
        expect(regions).toHaveLength(1);
        expect(regions[0]!.from).toBe(regions[0]!.to);
    });

    test("single blank line region is editable", () => {
        const str = `${B("PERSIST", "summary")}\n\n${E("PERSIST", "summary")}`;
        const { regions, content } = parse(str);
        expect(regions).toHaveLength(1);
        expect(content(regions[0]!)).toBe("");
    });
});

describe("inline form", () => {
    test("ANNO markers and content on one line", () => {
        const str = `> ${B("ANNO", "K1")}my comment${E("ANNO", "K1")}`;
        const { regions, content } = parse(str);
        expect(regions).toHaveLength(1);
        expect(content(regions[0]!)).toBe("my comment");
    });

    test("empty region is zero-width at the marker seam", () => {
        const str = `> ${B("ANNO", "K1")}${E("ANNO", "K1")}`;
        const { regions } = parse(str);
        expect(regions).toHaveLength(1);
        expect(regions[0]!.from).toBe(regions[0]!.to);
    });

    test("marker spans exclude content", () => {
        const str = `> ${B("ANNO", "K1")}abc${E("ANNO", "K1")}`;
        const doc = Text.of(str.split("\n"));
        const r = parseEditableRegions(doc)[0]!;
        expect(doc.sliceString(r.begFrom, r.begTo)).toBe(B("ANNO", "K1"));
        expect(doc.sliceString(r.endFrom, r.endTo)).toBe(E("ANNO", "K1"));
        expect(doc.sliceString(r.from, r.to)).toBe("abc");
    });
});

describe("mixed forms (multi-line paste into an inline region)", () => {
    test("inline BEG, content continues to line with inline END", () => {
        const str = `> ${B("ANNO", "K1")}line1\n> line2${E("ANNO", "K1")}`;
        const { regions, content } = parse(str);
        expect(regions).toHaveLength(1);
        expect(content(regions[0]!)).toBe("line1\n> line2");
    });

    test("inline BEG with block END line", () => {
        const str = `> ${B("ANNO", "K1")}line1\n> ${E("ANNO", "K1")}`;
        const { regions, content } = parse(str);
        expect(content(regions[0]!)).toBe("line1");
    });

    test("block BEG with inline END", () => {
        const str = `> ${B("ANNO", "K1")}\n> line1${E("ANNO", "K1")}`;
        const { regions, content } = parse(str);
        expect(content(regions[0]!)).toBe("> line1");
    });
});

describe("meta, ids, pairing", () => {
    test("ZF_NOTE_META line moves content start", () => {
        const str = `${B("NOTE", "K1")}\n<!-- ZF_NOTE_META data -->\nbody\n${E("NOTE", "K1")}`;
        const { regions, content } = parse(str);
        const r = regions[0]!;
        expect(r.metaFrom).not.toBeNull();
        expect(r.metaTo).not.toBeNull();
        expect(content(r)).toBe("body");
    });

    test("hyphenated persist ids parse", () => {
        const str = `${B("PERSIST", "reading-todo")}\nx\n${E("PERSIST", "reading-todo")}`;
        const { regions } = parse(str);
        expect(regions).toHaveLength(1);
        expect(regions[0]!.key).toBe("reading-todo");
    });

    test("multiple regions, unmatched markers ignored", () => {
        const str = [
            `> ${B("ANNO", "A1")}c1${E("ANNO", "A1")}`,
            B("NOTE", "N1"),
            "note body",
            E("NOTE", "N1"),
            E("ANNO", "STRAY"),
            `> ${B("ANNO", "A2")}c2${E("ANNO", "A2")}`,
        ].join("\n");
        const { regions, content } = parse(str);
        expect(regions).toHaveLength(3);
        expect(content(regions[0]!)).toBe("c1");
        expect(content(regions[1]!)).toBe("note body");
        expect(content(regions[2]!)).toBe("c2");
    });

    test("type/key mismatch does not cross-pair", () => {
        const str = `${B("NOTE", "K1")}\nx\n${E("ANNO", "K1")}\n${E("NOTE", "K1")}`;
        const { regions } = parse(str);
        expect(regions).toHaveLength(1);
        expect(regions[0]!.type).toBe("NOTE");
    });
});
