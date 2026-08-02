/**
 * `ui/editor/citation-helper.ts` — the drag-drop path that writes citations
 * into a note.
 *
 * It sat at 15% of statements and 12.5% of functions, and none of that was
 * deliberate: it was incidental coverage from the reader-bridge suite, which
 * imports the module for its MIME constant. Nothing targeted it. Its output is
 * text the user then owns — a duplicated footnote definition or a citation
 * dropped at the wrong offset is silent and hand-fixed.
 *
 * The `Editor` is faked as a plain string document, which is enough for every
 * position API this module uses and keeps the offset arithmetic honest.
 *
 * Mutation round: 34 of 35 anchors killed. The survivor is equivalent —
 * deleting the `if (!raw) return` guard in `handleEditorDrop` changes nothing,
 * because `parseZotFlowCitationPayload("")` throws inside its own `JSON.parse`,
 * is caught there, and returns null, which the `!payload` guard below already
 * handles. It saves a call, not a wrong answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    handleEditorDrop,
    insertCitationResult,
    parseZotFlowCitationPayload,
    resolveFormatFromModifiers,
    stripAnnotationForPayload,
    ZOTFLOW_CITATION_MIME,
} from "ui/editor/citation-helper";

import type { AnnotationJSON } from "types/zotero-reader";

/* ------------------------------------------------------------------ */
/*  Module boundary                                                   */
/* ------------------------------------------------------------------ */

interface MockState {
    defaultCitationFormat: string;
    citation: { citation: string; citekey: string; footnoteDef?: string } | null;
    resolveRejects: boolean;
    resolveCalls: { payload: unknown; format: string }[];
    logs: { level: string; message: string }[];
    notices: { type: string; message: string }[];
}

const state = vi.hoisted(() => ({
    defaultCitationFormat: "pandoc",
    citation: null,
    resolveRejects: false,
    resolveCalls: [],
    logs: [],
    notices: [],
})) as unknown as MockState;

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return { defaultCitationFormat: state.defaultCitationFormat };
        },
        citationService: {
            resolve: (payload: unknown, format: string) => {
                state.resolveCalls.push({ payload, format });
                return state.resolveRejects
                    ? Promise.reject(new Error("resolve blew up"))
                    : Promise.resolve(state.citation);
            },
        },
        logService: {
            error: (m: string) => state.logs.push({ level: "error", message: m }),
        },
        notificationService: {
            notify: (type: string, message: string) =>
                state.notices.push({ type, message }),
        },
    },
}));

/* ------------------------------------------------------------------ */
/*  A string-backed Editor                                            */
/* ------------------------------------------------------------------ */

interface Pos {
    line: number;
    ch: number;
}

function createEditor(initial = "") {
    let doc = initial;
    let cursor: Pos = { line: 0, ch: 0 };

    const lines = () => doc.split("\n");

    const posToOffset = (p: Pos) => {
        const ls = lines();
        let off = 0;
        for (let i = 0; i < p.line; i++) off += (ls[i] ?? "").length + 1;
        return off + p.ch;
    };

    const offsetToPos = (offset: number): Pos => {
        const ls = lines();
        let remaining = offset;
        for (let line = 0; line < ls.length; line++) {
            const len = (ls[line] ?? "").length;
            if (remaining <= len) return { line, ch: remaining };
            remaining -= len + 1;
        }
        return { line: ls.length - 1, ch: (ls.at(-1) ?? "").length };
    };

    return {
        get doc() {
            return doc;
        },
        get cursor() {
            return cursor;
        },
        getValue: () => doc,
        getCursor: () => cursor,
        setCursor: (p: Pos) => {
            cursor = p;
        },
        posToOffset,
        offsetToPos,
        lastLine: () => lines().length - 1,
        getLine: (n: number) => lines()[n] ?? "",
        replaceRange: (text: string, from: Pos, to?: Pos) => {
            const start = posToOffset(from);
            const end = to ? posToOffset(to) : start;
            doc = doc.slice(0, start) + text + doc.slice(end);
        },
        /** Move the cursor by (line, ch), as a drop at a position would. */
        placeCursor: (p: Pos) => {
            cursor = p;
        },
    } as any;
}

/** A DragEvent-shaped object carrying a ZotFlow payload. */
function createDropEvent(
    raw: string | null,
    modifiers: Partial<{
        shiftKey: boolean;
        ctrlKey: boolean;
        metaKey: boolean;
        altKey: boolean;
    }> = {},
    defaultPrevented = false,
) {
    const event = {
        defaultPrevented,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        ...modifiers,
        prevented: false,
        preventDefault() {
            event.prevented = true;
        },
        dataTransfer: {
            getData: (mime: string) =>
                mime === ZOTFLOW_CITATION_MIME ? (raw ?? "") : "",
        },
    };
    return event;
}

const annotation = (
    overrides: Partial<AnnotationJSON> = {},
): AnnotationJSON => ({
        id: "ANNO0001",
        libraryID: 1,
        parentItem: "ATTACH01",
        type: "highlight",
        text: "quoted",
        comment: "note",
        color: "#ffd400",
        pageLabel: "13",
        authorName: "Ada",
        sortIndex: "00013|000000|00000",
        position: { pageIndex: 12, rects: [[1, 2, 3, 4]] },
        tags: [{ name: "method" }],
        dateAdded: "2026-01-01T00:00:00Z",
        dateModified: "2026-01-02T00:00:00Z",
    ...overrides,
});

beforeEach(() => {
    state.defaultCitationFormat = "pandoc";
    state.citation = null;
    state.resolveRejects = false;
    state.resolveCalls.length = 0;
    state.logs.length = 0;
    state.notices.length = 0;
});

/* ================================================================ */
/*  stripAnnotationForPayload                                       */
/* ================================================================ */

describe("stripAnnotationForPayload", () => {
    it("keeps the fields a citation template reads", () => {
        expect(stripAnnotationForPayload(annotation())).toMatchObject({
            id: "ANNO0001",
            libraryID: 1,
            parentItem: "ATTACH01",
            type: "highlight",
            text: "quoted",
            comment: "note",
            color: "#ffd400",
            pageLabel: "13",
            authorName: "Ada",
            tags: [{ name: "method" }],
        });
    });

    it("drops the heavy and non-serializable fields", () => {
        // The payload crosses dataTransfer and the clipboard; a base64 image or
        // a full rect list would bloat or break the transfer.
        const stripped = stripAnnotationForPayload(
            annotation({ image: "data:image/png;base64,AAAA" }),
        );

        expect("image" in stripped).toBe(false);
        expect("sortIndex" in stripped).toBe(false);
        expect(stripped.position.rects).toEqual([]);
    });

    it("keeps the page index, which is what a locator needs", () => {
        // Rects go, pageIndex stays — it is the only positional fact a
        // citation template uses.
        expect(stripAnnotationForPayload(annotation()).position).toEqual({
            pageIndex: 12,
            rects: [],
        });
    });

    it("survives an annotation with no optional fields", () => {
        const bare: AnnotationJSON = {
            id: "A1",
            type: "note",
            position: { pageIndex: 0, rects: [] },
            tags: [],
            dateAdded: "x",
            dateModified: "y",
        };

        expect(() => stripAnnotationForPayload(bare)).not.toThrow();
    });
});

/* ================================================================ */
/*  parseZotFlowCitationPayload                                     */
/* ================================================================ */

describe("parseZotFlowCitationPayload", () => {
    const valid = {
        type: "zotflow-citation",
        libraryID: 1,
        key: "ITEM0001",
        annotations: [{ id: "A1" }],
    };

    it("accepts a well-formed payload and keeps only the known fields", () => {
        const parsed = parseZotFlowCitationPayload(
            JSON.stringify({ ...valid, extra: "ignored" }),
        );

        expect(parsed).toEqual(valid);
        expect(parsed).not.toHaveProperty("extra");
    });

    it("accepts a payload with no annotations", () => {
        const { annotations: _drop, ...noAnnotations } = valid;

        expect(parseZotFlowCitationPayload(JSON.stringify(noAnnotations))).toEqual(
            { ...noAnnotations, annotations: undefined },
        );
    });

    it.each([
        ["not JSON at all", "{ not json"],
        ["empty string", ""],
        ["a bare string", '"hello"'],
        ["null", "null"],
        ["an array", "[]"],
    ])("rejects %s", (_label, raw) => {
        expect(parseZotFlowCitationPayload(raw)).toBeNull();
    });

    it.each([
        ["wrong type tag", { ...valid, type: "something-else" }],
        ["missing type", { libraryID: 1, key: "K" }],
        ["libraryID as a string", { ...valid, libraryID: "1" }],
        ["missing libraryID", { type: "zotflow-citation", key: "K" }],
        ["key as a number", { ...valid, key: 42 }],
        ["missing key", { type: "zotflow-citation", libraryID: 1 }],
    ])("rejects a payload with %s", (_label, obj) => {
        // A foreign drag could carry anything under this MIME; the shape check
        // is what stops it reaching the citation service.
        expect(parseZotFlowCitationPayload(JSON.stringify(obj))).toBeNull();
    });

    it("accepts libraryID 0", () => {
        // Falsy but valid — a `typeof === "number"` check is required here,
        // and a truthiness check would reject it.
        expect(
            parseZotFlowCitationPayload(
                JSON.stringify({ ...valid, libraryID: 0 }),
            ),
        ).toMatchObject({ libraryID: 0 });
    });
});

/* ================================================================ */
/*  resolveFormatFromModifiers                                      */
/* ================================================================ */

describe("resolveFormatFromModifiers", () => {
    const mods = (m: Partial<Record<string, boolean>> = {}) => ({
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        ...m,
    });

    it.each([
        ["ctrl+shift", { ctrlKey: true, shiftKey: true }, "citekey"],
        ["cmd+shift", { metaKey: true, shiftKey: true }, "citekey"],
        ["shift", { shiftKey: true }, "wikilink"],
        ["ctrl", { ctrlKey: true }, "footnote"],
        ["cmd", { metaKey: true }, "footnote"],
        ["alt", { altKey: true }, "pandoc"],
    ])("%s selects %s", (_label, m, expected) => {
        // The configured default must differ from the expected outcome, or a
        // deleted modifier branch would fall through to it and look correct.
        state.defaultCitationFormat =
            expected === "citekey" ? "wikilink" : "citekey";

        expect(resolveFormatFromModifiers(mods(m))).toBe(expected);
    });

    it("falls back to the configured default with no modifiers", () => {
        state.defaultCitationFormat = "wikilink";

        expect(resolveFormatFromModifiers(mods())).toBe("wikilink");
    });

    it("checks the combination before the single keys", () => {
        // ctrl+shift must not be read as plain shift or plain ctrl.
        expect(
            resolveFormatFromModifiers(mods({ ctrlKey: true, shiftKey: true })),
        ).toBe("citekey");
    });

    it("ignores alt once a higher-priority modifier is held", () => {
        expect(
            resolveFormatFromModifiers(mods({ shiftKey: true, altKey: true })),
        ).toBe("wikilink");
    });
});

/* ================================================================ */
/*  insertCitationResult                                            */
/* ================================================================ */

describe("insertCitationResult", () => {
    it("inserts at the given position, not at the cursor", () => {
        const editor = createEditor("hello world");

        insertCitationResult(editor, { line: 0, ch: 5 }, {
            citation: "[@smith]",
            citekey: "smith",
        });

        expect(editor.doc).toBe("hello[@smith] world");
    });

    it("leaves the cursor after the inserted citation", () => {
        // So the user can keep typing where the text ended.
        const editor = createEditor("hello world");

        insertCitationResult(editor, { line: 0, ch: 5 }, {
            citation: "[@smith]",
            citekey: "smith",
        });

        expect(editor.cursor).toEqual({ line: 0, ch: 13 });
    });

    it("adds no footnote block when the result has no definition", () => {
        const editor = createEditor("body");

        insertCitationResult(editor, { line: 0, ch: 4 }, {
            citation: "[@smith]",
            citekey: "smith",
        });

        expect(editor.doc).toBe("body[@smith]");
    });

    it("appends the definition at the end of the document", () => {
        const editor = createEditor("body");

        insertCitationResult(editor, { line: 0, ch: 4 }, {
            citation: "[^smith]",
            citekey: "smith",
            footnoteDef: "[^smith]: Smith 2024",
        });

        expect(editor.doc).toBe("body[^smith]\n[^smith]: Smith 2024\n");
    });

    it("does not add a leading blank line when the document ends empty", () => {
        const editor = createEditor("body\n");

        insertCitationResult(editor, { line: 0, ch: 4 }, {
            citation: "[^smith]",
            citekey: "smith",
            footnoteDef: "[^smith]: Smith 2024",
        });

        expect(editor.doc).toBe("body[^smith]\n[^smith]: Smith 2024\n");
    });

    it("does not duplicate a definition already in the document", () => {
        // Citing the same work twice must not append the definition again —
        // duplicate footnote markers render as an error in most previewers.
        const editor = createEditor("body\n[^smith]: Smith 2024\n");

        insertCitationResult(editor, { line: 0, ch: 4 }, {
            citation: "[^smith]",
            citekey: "smith",
            footnoteDef: "[^smith]: Smith 2024",
        });

        expect(editor.doc.match(/\[\^smith\]:/g)).toHaveLength(1);
    });

    it("recognises a definition sitting on the first line", () => {
        // `includes("\n[^smith]:")` would miss it, hence the startsWith check.
        const editor = createEditor("[^smith]: Smith 2024\nbody");

        insertCitationResult(editor, { line: 1, ch: 4 }, {
            citation: "[^smith]",
            citekey: "smith",
            footnoteDef: "[^smith]: Smith 2024",
        });

        expect(editor.doc.match(/\[\^smith\]:/g)).toHaveLength(1);
    });

    it("appends only the definitions that are missing", () => {
        // One template render can emit several definitions, one per annotation.
        const editor = createEditor("body\n[^a]: first\n");

        insertCitationResult(editor, { line: 0, ch: 4 }, {
            citation: "[^a] [^b]",
            citekey: "smith",
            footnoteDef: "[^a]: first\n[^b]: second",
        });

        expect(editor.doc.match(/\[\^a\]:/g)).toHaveLength(1);
        expect(editor.doc.match(/\[\^b\]:/g)).toHaveLength(1);
    });

    it("keeps a multi-line definition body together", () => {
        const editor = createEditor("body");

        insertCitationResult(editor, { line: 0, ch: 4 }, {
            citation: "[^a]",
            citekey: "smith",
            footnoteDef: "[^a]: line one\n    continued\n[^b]: second",
        });

        expect(editor.doc).toContain("[^a]: line one\n    continued");
        expect(editor.doc).toContain("[^b]: second");
    });

    it("falls back to the citekey when the definition carries no marker", () => {
        // A legacy body-only template. The dedup check has to use *something*,
        // and the citekey is what the reference will have used.
        const editor = createEditor("body\n[^smith]: already here\n");

        insertCitationResult(editor, { line: 0, ch: 4 }, {
            citation: "[^smith]",
            citekey: "smith",
            footnoteDef: "already here",
        });

        // Recognised as present, so nothing is appended.
        expect(editor.doc).toBe("body[^smith]\n[^smith]: already here\n");
    });
});

/* ================================================================ */
/*  handleEditorDrop                                                */
/* ================================================================ */

describe("handleEditorDrop", () => {
    const info = {} as never;

    it("ignores a drop another handler already claimed", async () => {
        const editor = createEditor("body");
        const evt = createDropEvent(
            JSON.stringify({
                type: "zotflow-citation",
                libraryID: 1,
                key: "K",
            }),
            {},
            true,
        );

        handleEditorDrop(evt as never, editor, info);

        expect(state.resolveCalls).toEqual([]);
        expect(evt.prevented).toBe(false);
    });

    it("ignores a drop carrying no ZotFlow payload", () => {
        // Plain text and file drops must keep Obsidian's own behaviour.
        const editor = createEditor("body");
        const evt = createDropEvent(null);

        handleEditorDrop(evt as never, editor, info);

        expect(evt.prevented).toBe(false);
        expect(state.resolveCalls).toEqual([]);
    });

    it("ignores a payload that does not parse", () => {
        const editor = createEditor("body");
        const evt = createDropEvent("{ not json");

        handleEditorDrop(evt as never, editor, info);

        expect(evt.prevented).toBe(false);
        expect(state.resolveCalls).toEqual([]);
    });

    it("claims the drop and resolves the citation", async () => {
        state.citation = { citation: "[@smith]", citekey: "smith" };
        const editor = createEditor("body");
        editor.placeCursor({ line: 0, ch: 4 });
        const evt = createDropEvent(
            JSON.stringify({
                type: "zotflow-citation",
                libraryID: 1,
                key: "ITEM0001",
            }),
        );

        handleEditorDrop(evt as never, editor, info);

        expect(evt.prevented).toBe(true);
        await vi.waitFor(() => expect(editor.doc).toBe("body[@smith]"));
        expect(state.resolveCalls[0]!.payload).toMatchObject({
            libraryID: 1,
            key: "ITEM0001",
        });
    });

    it("uses the format the modifier keys selected", async () => {
        state.citation = { citation: "@smith", citekey: "smith" };
        const editor = createEditor("body");
        const evt = createDropEvent(
            JSON.stringify({
                type: "zotflow-citation",
                libraryID: 1,
                key: "K",
            }),
            { ctrlKey: true, shiftKey: true },
        );

        handleEditorDrop(evt as never, editor, info);

        await vi.waitFor(() =>
            expect(state.resolveCalls[0]!.format).toBe("citekey"),
        );
    });

    it("inserts nothing when the citation cannot be resolved", async () => {
        state.citation = null;
        const editor = createEditor("body");
        const evt = createDropEvent(
            JSON.stringify({
                type: "zotflow-citation",
                libraryID: 1,
                key: "K",
            }),
        );

        handleEditorDrop(evt as never, editor, info);

        await vi.waitFor(() => expect(state.resolveCalls).toHaveLength(1));
        expect(editor.doc).toBe("body");
    });

    it("reports a failed resolve without throwing into the event handler", async () => {
        state.resolveRejects = true;
        const editor = createEditor("body");
        const evt = createDropEvent(
            JSON.stringify({
                type: "zotflow-citation",
                libraryID: 1,
                key: "K",
            }),
        );

        expect(() =>
            handleEditorDrop(evt as never, editor, info),
        ).not.toThrow();

        await vi.waitFor(() =>
            expect(state.notices).toEqual([
                { type: "error", message: "Failed to insert citation." },
            ]),
        );
        expect(
            state.logs.some((l) =>
                l.message.includes("Failed to resolve citation on drop"),
            ),
        ).toBe(true);
    });

    it("re-anchors to the live cursor when the document changed while resolving", async () => {
        // Resolution is async and the user may have kept typing. Inserting at
        // the remembered offset would land in the middle of their new text.
        state.citation = { citation: "[@smith]", citekey: "smith" };
        const editor = createEditor("body");
        editor.placeCursor({ line: 0, ch: 4 });
        const evt = createDropEvent(
            JSON.stringify({
                type: "zotflow-citation",
                libraryID: 1,
                key: "K",
            }),
        );

        handleEditorDrop(evt as never, editor, info);
        // The user types before the promise settles.
        editor.replaceRange(" more", { line: 0, ch: 4 });
        editor.placeCursor({ line: 0, ch: 9 });

        await vi.waitFor(() => expect(editor.doc).toContain("[@smith]"));
        expect(editor.doc).toBe("body more[@smith]");
    });
});
