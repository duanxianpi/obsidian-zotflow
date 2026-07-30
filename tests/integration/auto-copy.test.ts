/**
 * `copyAnnotationOnCreate` — what lands on the clipboard the moment a user
 * finishes highlighting.
 *
 * Small, but it is the other half of the citation story and the reason the two
 * reader views pass deliberately different `AutoCopyContext` shapes: a local
 * vault file has no Zotero item, so it cannot supply `libraryID`/`parentItemKey`,
 * and that absence is what makes citation mode degrade to an embed instead of
 * silently producing nothing. That degradation is the behaviour worth pinning —
 * it is invisible from either view on its own.
 *
 * The function is documented as never throwing. A clipboard rejection has to
 * become a log plus a notice, because the alternative is an unhandled rejection
 * inside the reader's save handler.
 *
 * Mutation round (with `citation-service`): 26 of 27 anchors killed. The
 * survivor is equivalent — deleting the `!mode || mode === "off"` early return
 * changes nothing, because the three positive branches below it match none of
 * `off`/`""`/`undefined` and control simply falls off the end. It is an intent
 * guard and a fast path, not behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { copyAnnotationOnCreate } from "ui/reader/auto-copy";

import type { AnnotationJSON } from "types/zotero-reader";

/* ------------------------------------------------------------------ */
/*  Module boundary                                                   */
/* ------------------------------------------------------------------ */

interface MockState {
    autoCopyAnnotation: string;
    defaultCitationFormat: string;
    logs: { level: string; message: string }[];
    notices: { type: string; message: string }[];
    clipboard: string[];
    clipboardRejects: boolean;
    /** What `citationService.resolve` returns. */
    citation: { citation: string; footnoteDef?: string } | null;
    /** Every `citationService.resolve` call, in order. */
    resolveCalls: { ref: Record<string, unknown>; format: string }[];
}

const state = vi.hoisted(() => ({
    autoCopyAnnotation: "off",
    defaultCitationFormat: "pandoc",
    logs: [],
    notices: [],
    clipboard: [],
    clipboardRejects: false,
    citation: null,
    resolveCalls: [],
})) as unknown as MockState;

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return {
                autoCopyAnnotation: state.autoCopyAnnotation,
                defaultCitationFormat: state.defaultCitationFormat,
            };
        },
        logService: {
            error: (m: string) => state.logs.push({ level: "error", message: m }),
            warn: (m: string) => state.logs.push({ level: "warn", message: m }),
            info: (m: string) => state.logs.push({ level: "info", message: m }),
            debug: (m: string) => state.logs.push({ level: "debug", message: m }),
        },
        notificationService: {
            notify: (type: string, message: string) =>
                state.notices.push({ type, message }),
        },
        citationService: {
            resolve: (ref: Record<string, unknown>, format: string) => {
                state.resolveCalls.push({ ref, format });
                return Promise.resolve(state.citation);
            },
        },
    },
}));

/* ------------------------------------------------------------------ */

const NOTE = "Sources/Paper.md";

function anno(overrides: Partial<AnnotationJSON> = {}): AnnotationJSON {
    return {
        id: "ANNO0001",
        type: "highlight",
        text: "the quoted sentence",
        comment: "",
        color: "#ffd400",
        pageLabel: "13",
        sortIndex: "00013|000000|00000",
        position: { pageIndex: 12, rects: [] },
        tags: [],
        dateAdded: "2026-01-01T00:00:00Z",
        dateModified: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

/** What `ZoteroReaderView` passes — a cloud attachment knows its Zotero item. */
const CLOUD_CTX = {
    sourceNotePath: NOTE,
    parentItemKey: "PAPER001",
    libraryID: 1,
    attachmentKey: "ATTACH01",
};

/** What `LocalReaderView` passes — no Zotero item exists. */
const LOCAL_CTX = { sourceNotePath: NOTE };

beforeEach(() => {
    state.autoCopyAnnotation = "off";
    state.defaultCitationFormat = "pandoc";
    state.logs.length = 0;
    state.notices.length = 0;
    state.clipboard.length = 0;
    state.clipboardRejects = false;
    state.citation = null;
    state.resolveCalls.length = 0;

    vi.stubGlobal("navigator", {
        ...globalThis.navigator,
        clipboard: {
            writeText: (text: string) => {
                if (state.clipboardRejects) {
                    return Promise.reject(new Error("clipboard denied"));
                }
                state.clipboard.push(text);
                return Promise.resolve();
            },
        },
    });
});

/* ================================================================ */
/*  The setting gates everything                                    */
/* ================================================================ */

describe("the autoCopyAnnotation setting", () => {
    it.each(["off", "", undefined])(
        "copies nothing when the setting is %s",
        async (mode) => {
            state.autoCopyAnnotation = mode as string;

            await copyAnnotationOnCreate(anno(), CLOUD_CTX);

            expect(state.clipboard).toEqual([]);
            expect(state.resolveCalls).toEqual([]);
        },
    );
});

/* ================================================================ */
/*  embed                                                           */
/* ================================================================ */

describe("embed mode", () => {
    beforeEach(() => {
        state.autoCopyAnnotation = "embed";
    });

    it("copies a block embed pointing at the annotation", async () => {
        await copyAnnotationOnCreate(anno({ id: "ABC" }), CLOUD_CTX);

        expect(state.clipboard).toEqual([`![[${NOTE}#^ABC]]`]);
    });

    it("copies nothing when there is no source note to point at", async () => {
        await copyAnnotationOnCreate(anno(), { sourceNotePath: undefined });

        expect(state.clipboard).toEqual([]);
    });

    it("never consults the citation service", async () => {
        await copyAnnotationOnCreate(anno(), CLOUD_CTX);
        expect(state.resolveCalls).toEqual([]);
    });
});

/* ================================================================ */
/*  text                                                            */
/* ================================================================ */

describe("text mode", () => {
    beforeEach(() => {
        state.autoCopyAnnotation = "text";
    });

    it("copies the annotation's own text", async () => {
        await copyAnnotationOnCreate(anno({ text: "  spaced out  " }), CLOUD_CTX);

        expect(state.clipboard).toEqual(["spaced out"]);
    });

    it.each([
        ["empty", ""],
        ["whitespace only", "   "],
        ["null", null],
        ["absent", undefined],
    ])("copies nothing when the text is %s", async (_label, text) => {
        // An image or ink annotation has no text; copying an empty string would
        // silently clear whatever the user already had on the clipboard.
        await copyAnnotationOnCreate(
            anno({ text: text as string | null }),
            CLOUD_CTX,
        );

        expect(state.clipboard).toEqual([]);
    });
});

/* ================================================================ */
/*  citation — and the local degradation                            */
/* ================================================================ */

describe("citation mode", () => {
    beforeEach(() => {
        state.autoCopyAnnotation = "citation";
        state.citation = { citation: "[@smith2024, p. 13]" };
    });

    it("resolves the citation for the parent item", async () => {
        await copyAnnotationOnCreate(anno(), CLOUD_CTX);

        expect(state.clipboard).toEqual(["[@smith2024, p. 13]"]);
        expect(state.resolveCalls).toHaveLength(1);
        expect(state.resolveCalls[0]!.ref).toMatchObject({
            libraryID: 1,
            key: "PAPER001",
        });
        expect(state.resolveCalls[0]!.format).toBe("pandoc");
    });

    it("uses the configured default format", async () => {
        state.defaultCitationFormat = "footnote";

        await copyAnnotationOnCreate(anno(), CLOUD_CTX);

        expect(state.resolveCalls[0]!.format).toBe("footnote");
    });

    it("restores the ids the reader stripped, so page locators resolve", async () => {
        // The annotation reaching this point has no libraryID/parentItem; the
        // citation template needs both to find the page it is citing.
        await copyAnnotationOnCreate(anno({ id: "ABC" }), CLOUD_CTX);

        const annotations = state.resolveCalls[0]!.ref["annotations"] as Record<
            string,
            unknown
        >[];
        expect(annotations[0]).toMatchObject({
            id: "ABC",
            libraryID: 1,
            parentItem: "ATTACH01",
        });
    });

    it("appends the footnote definition below the reference", async () => {
        state.citation = {
            citation: "[^smith2024]",
            footnoteDef: "[^smith2024]: Smith 2024, p. 13",
        };

        await copyAnnotationOnCreate(anno(), CLOUD_CTX);

        expect(state.clipboard).toEqual([
            "[^smith2024]\n[^smith2024]: Smith 2024, p. 13",
        ]);
    });

    it("copies nothing when the citation cannot be resolved", async () => {
        state.citation = null;

        await copyAnnotationOnCreate(anno(), CLOUD_CTX);

        expect(state.clipboard).toEqual([]);
    });

    /* -------------------------------------------------------------- */

    it("DEGRADES to an embed for a local file", async () => {
        // This is why LocalReaderView passes a narrower context. There is no
        // Zotero item to cite, so citation mode quietly becomes embed rather
        // than producing nothing.
        await copyAnnotationOnCreate(anno({ id: "ABC" }), LOCAL_CTX);

        expect(state.clipboard).toEqual([`![[${NOTE}#^ABC]]`]);
        expect(state.resolveCalls).toEqual([]);
    });

    it.each([
        ["no libraryID", { sourceNotePath: NOTE, parentItemKey: "PAPER001" }],
        ["no parentItemKey", { sourceNotePath: NOTE, libraryID: 1 }],
    ])("degrades on a partial context: %s", async (_label, ctx) => {
        await copyAnnotationOnCreate(anno({ id: "ABC" }), ctx);

        expect(state.clipboard).toEqual([`![[${NOTE}#^ABC]]`]);
        expect(state.resolveCalls).toEqual([]);
    });

    it("copies nothing when it can neither cite nor embed", async () => {
        await copyAnnotationOnCreate(anno(), {});

        expect(state.clipboard).toEqual([]);
        expect(state.resolveCalls).toEqual([]);
    });

    it("treats libraryID 0 as present, not missing", async () => {
        // A falsy-but-valid id: `=== undefined` is the right check, `!ctx.libraryID`
        // would send a real library-0 item down the embed path.
        await copyAnnotationOnCreate(anno(), { ...CLOUD_CTX, libraryID: 0 });

        expect(state.resolveCalls).toHaveLength(1);
        expect(state.resolveCalls[0]!.ref).toMatchObject({ libraryID: 0 });
    });
});

/* ================================================================ */
/*  Failure handling                                                */
/* ================================================================ */

describe("clipboard failures", () => {
    it.each(["embed", "text", "citation"] as const)(
        "reports rather than throws in %s mode",
        async (mode) => {
            // Called from the reader's save handler — an unhandled rejection
            // here would surface as a broken save.
            state.autoCopyAnnotation = mode;
            state.citation = { citation: "[@x]" };
            state.clipboardRejects = true;

            await expect(
                copyAnnotationOnCreate(anno(), CLOUD_CTX),
            ).resolves.toBeUndefined();

            expect(
                state.logs.some(
                    (l) =>
                        l.level === "error" &&
                        l.message.includes("Failed to auto-copy annotation"),
                ),
            ).toBe(true);
            expect(state.notices).toEqual([
                {
                    type: "warning",
                    message: "Failed to copy annotation to clipboard",
                },
            ]);
        },
    );
});
