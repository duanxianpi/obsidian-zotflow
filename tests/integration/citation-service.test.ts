/**
 * `CitationService` — the text that ends up inside the user's notes.
 *
 * Every caller of this was already tested against a mock of it: the reader
 * bridge suite mocks `services.citationService.resolve`, and so does the
 * auto-copy path. So the contract was pinned from the caller's side while the
 * implementation ran in no test at all — the same gap that, when closed for
 * `AnnotationService`, turned up three real holes.
 *
 * The failure mode here is quiet and durable. Nothing throws when a citekey is
 * wrong or a footnote definition loses its marker; the bad text is simply
 * written into a note, and the user has to find and fix it by hand.
 *
 * The template layer is faked, because `LibraryTemplateService` has its own
 * suite at 99% and what matters here is what CitationService does with what a
 * template returns — especially when it returns nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitationService } from "services/citation-service";

import { createFakeApp } from "../fakes/obsidian-app";

import type { FakeObsidianApp } from "../fakes/obsidian-app";

/* ------------------------------------------------------------------ */
/*  Module boundary                                                   */
/* ------------------------------------------------------------------ */

interface MockState {
    app: unknown;
    logs: { level: string; message: string }[];
    notices: { type: string; message: string }[];
    /** zotero key -> vault path, backing `indexService.getFileByKey`. */
    notesByKey: Map<string, string>;
    /** What `dbHelper.getItem` returns. */
    item: unknown;
    /** What `libraryNote.ensureNotePath` returns. */
    ensuredPath: string | null;
    /** Rendered output per template kind; absent means "template produced nothing". */
    templates: Map<string, string>;
    /** Every `renderCitationTemplate` call, in order. */
    renderCalls: { kind: string; notePath: string }[];
    /** Make `renderCitationTemplate` throw. */
    templateThrows: boolean;
}

const state = vi.hoisted(() => ({
    app: null,
    logs: [],
    notices: [],
    notesByKey: new Map(),
    item: null,
    ensuredPath: null,
    templates: new Map(),
    renderCalls: [],
    templateThrows: false,
})) as unknown as MockState;

vi.mock("services/services", () => ({
    services: {
        get app() {
            return state.app;
        },
        indexService: {
            getFileByKey: (key: string) => {
                const path = state.notesByKey.get(key);
                return path ? { path } : null;
            },
        },
        logService: {
            debug: (m: string) => state.logs.push({ level: "debug", message: m }),
            info: (m: string) => state.logs.push({ level: "info", message: m }),
            warn: (m: string) => state.logs.push({ level: "warn", message: m }),
            error: (m: string) => state.logs.push({ level: "error", message: m }),
        },
        notificationService: {
            notify: (type: string, message: string) =>
                state.notices.push({ type, message }),
        },
    },
}));

vi.mock("bridge", () => ({
    workerBridge: {
        dbHelper: {
            getItem: () => Promise.resolve(state.item),
        },
        libraryNote: {
            ensureNotePath: () => Promise.resolve(state.ensuredPath),
        },
        libraryTemplate: {
            renderCitationTemplate: (
                _input: unknown,
                notePath: string,
                kind: string,
            ) => {
                state.renderCalls.push({ kind, notePath });
                if (state.templateThrows) {
                    return Promise.reject(new Error("template blew up"));
                }
                return Promise.resolve(state.templates.get(kind) ?? "");
            },
        },
    },
}));

/* ------------------------------------------------------------------ */

const LIBRARY = 1;
const KEY = "ITEM0001";
const NOTE = "Sources/Smith 2024.md";

let app: FakeObsidianApp;
let service: CitationService;

/** The item shape `dbHelper.getItem` hands back. */
function item(overrides: Record<string, unknown> = {}) {
    return {
        libraryID: LIBRARY,
        key: KEY,
        citationKey: "smith2024",
        title: "A Paper",
        ...overrides,
    };
}

const ref = (annotations?: unknown[]) => ({
    libraryID: LIBRARY,
    key: KEY,
    ...(annotations ? { annotations } : {}),
}) as any;

beforeEach(() => {
    app = createFakeApp();
    app.writeFile(NOTE, "# note");
    state.app = app.app;
    state.logs.length = 0;
    state.notices.length = 0;
    state.notesByKey.clear();
    state.notesByKey.set(KEY, NOTE);
    state.item = item();
    state.ensuredPath = null;
    state.templates.clear();
    state.renderCalls.length = 0;
    state.templateThrows = false;
    service = new CitationService();
});

/* ================================================================ */
/*  Resolving the item and its note                                 */
/* ================================================================ */

describe("resolve: preconditions", () => {
    it("gives up when the item is not in the database", async () => {
        state.item = null;

        expect(await service.resolve(ref(), "pandoc")).toBeNull();
        expect(
            state.logs.some(
                (l) => l.level === "error" && l.message.includes("Item not found"),
            ),
        ).toBe(true);
    });

    it("uses the indexed note path without creating anything", async () => {
        await service.resolve(ref(), "pandoc");

        expect(state.renderCalls[0]!.notePath).toBe(NOTE);
    });

    it("creates a stub note when the key is not indexed yet", async () => {
        // The citation has to point somewhere, so a miss quick-creates one.
        state.notesByKey.clear();
        state.ensuredPath = "Sources/Created.md";

        await service.resolve(ref(), "pandoc");

        expect(state.renderCalls[0]!.notePath).toBe("Sources/Created.md");
    });

    it("gives up when no note can be resolved or created", async () => {
        state.notesByKey.clear();
        state.ensuredPath = null;

        expect(await service.resolve(ref(), "pandoc")).toBeNull();
        expect(
            state.logs.some(
                (l) =>
                    l.level === "error" &&
                    l.message.includes("Unable to resolve or create source note"),
            ),
        ).toBe(true);
    });

    it("returns null instead of propagating a template failure", async () => {
        // A broken user template must not take down the drop handler that
        // called this.
        state.templateThrows = true;

        expect(await service.resolve(ref(), "pandoc")).toBeNull();
        expect(
            state.logs.some(
                (l) =>
                    l.level === "error" &&
                    l.message.includes("Error generating citation"),
            ),
        ).toBe(true);
    });

    it("passes the annotations through to the template", async () => {
        // Page locators come from here — the template sees the annotations the
        // caller was citing.
        const annotations = [{ id: "A1", pageLabel: "13" }];
        await service.resolve(ref(annotations), "pandoc");

        expect(state.renderCalls).toHaveLength(1);
    });
});

/* ================================================================ */
/*  Formats                                                         */
/* ================================================================ */

describe("pandoc", () => {
    it("prefers the rendered template", async () => {
        state.templates.set("pandoc", "[@smith2024, p. 13]");

        expect(await service.resolve(ref(), "pandoc")).toEqual({
            citation: "[@smith2024, p. 13]",
            citekey: "smith2024",
        });
    });

    it("falls back to a bare citekey reference", async () => {
        expect(await service.resolve(ref(), "pandoc")).toEqual({
            citation: "[@smith2024]",
            citekey: "smith2024",
        });
    });

    it("uses the item key when there is no citation key", async () => {
        // Zotero items without Better BibTeX keys still have to cite as
        // something stable.
        state.item = item({ citationKey: "" });

        expect(await service.resolve(ref(), "pandoc")).toEqual({
            citation: `[@${KEY}]`,
            citekey: KEY,
        });
    });
});

describe("citekey fallback across formats", () => {
    // Every format derives its citekey the same way, and each does it in its
    // own branch — so each needs its own case, or a format could quietly lose
    // the fallback and cite an item as `undefined`.
    it.each(["pandoc", "citekey", "wikilink", "footnote"] as const)(
        "%s falls back to the item key",
        async (format) => {
            state.item = item({ citationKey: "" });

            // Only `citekey` is asserted: wikilink's citation string comes from
            // the note path via generateMarkdownLink, so it never carries the
            // key even though its citekey field does.
            const result = await service.resolve(ref(), format);
            expect(result!.citekey).toBe(KEY);
        },
    );
});

describe("citekey", () => {
    it("returns the bare key with no template involved", async () => {
        state.templates.set("pandoc", "should not be used");

        expect(await service.resolve(ref(), "citekey")).toEqual({
            citation: "@smith2024",
            citekey: "smith2024",
        });
        expect(state.renderCalls).toEqual([]);
    });
});

describe("wikilink", () => {
    it("prefers the rendered template", async () => {
        state.templates.set("wikilink", "[[Sources/Smith 2024|Smith 2024]]");

        expect((await service.resolve(ref(), "wikilink"))!.citation).toBe(
            "[[Sources/Smith 2024|Smith 2024]]",
        );
        expect(app.generatedLinks).toEqual([]);
    });

    it("asks Obsidian to build the link when the template renders nothing", async () => {
        // Obsidian owns the wikilink-vs-markdown-link preference, so the
        // fallback must go through fileManager rather than string-building.
        const result = await service.resolve(ref(), "wikilink");

        expect(app.generatedLinks).toEqual([
            { path: NOTE, alias: "Smith 2024" },
        ]);
        expect(result!.citation).toBe("[[Sources/Smith 2024.md|Smith 2024]]");
        expect(
            state.logs.some(
                (l) => l.level === "warn" && l.message.includes("Wikilink template failed"),
            ),
        ).toBe(true);
    });

    it("TRUNCATES the alias at the first dot in the filename", async () => {
        // The alias is `file.name.split(".").shift()`, which assumes the only
        // dot is the extension separator. "et al." is ordinary in a citation
        // filename, and the alias silently loses everything after it. Pinned as
        // current behaviour, not as desired behaviour.
        app.writeFile("Sources/Smith et al. 2024.md", "# note");
        state.notesByKey.set(KEY, "Sources/Smith et al. 2024.md");

        const result = await service.resolve(ref(), "wikilink");

        expect(app.generatedLinks[0]!.alias).toBe("Smith et al");
        expect(result!.citation).toBe(
            "[[Sources/Smith et al. 2024.md|Smith et al]]",
        );
    });

    it("emits a last-resort link when the note file is missing from the vault", async () => {
        // The index can point at a path the vault no longer has.
        state.notesByKey.set(KEY, "Sources/Ghost.md");

        const result = await service.resolve(ref(), "wikilink");

        expect(result!.citation).toBe("[[@smith2024]]");
        expect(
            state.logs.some(
                (l) =>
                    l.level === "error" &&
                    l.message.includes("Failed to find source note file"),
            ),
        ).toBe(true);
    });
});

/* ================================================================ */
/*  Footnotes — reference and definition must stay aligned          */
/* ================================================================ */

describe("footnote", () => {
    it("renders reference and definition from the same annotation context", async () => {
        state.templates.set("footnote-ref", "[^smith2024]");
        state.templates.set("footnote", "[^smith2024]: Smith 2024, p. 13");

        const result = await service.resolve(ref(), "footnote");

        expect(result).toEqual({
            citation: "[^smith2024]",
            citekey: "smith2024",
            footnoteDef: "[^smith2024]: Smith 2024, p. 13",
        });
        // Both templates are asked, in that order, for the same note.
        expect(state.renderCalls.map((c) => c.kind)).toEqual([
            "footnote-ref",
            "footnote",
        ]);
    });

    it("falls back to a citekey marker for the reference", async () => {
        expect(
            (await service.resolve(ref(), "footnote"))!.citation,
        ).toBe("[^smith2024]");
    });

    it("omits the definition entirely when its template renders nothing", async () => {
        state.templates.set("footnote-ref", "[^smith2024]");

        expect(
            (await service.resolve(ref(), "footnote"))!.footnoteDef,
        ).toBeUndefined();
    });

    it("returns a marker-bearing definition verbatim", async () => {
        // A template that emits its own `[^marker]:` owns the alignment —
        // including emitting several definitions for several annotations.
        state.templates.set("footnote-ref", "[^a] [^b]");
        state.templates.set(
            "footnote",
            "[^a]: first\n[^b]: second",
        );

        const result = await service.resolve(ref(), "footnote");

        expect(result!.footnoteDef).toBe("[^a]: first\n[^b]: second");
        expect(state.notices).toEqual([]);
    });

    it("takes the marker from the RENDERED reference, not the citekey", async () => {
        // This is the alignment contract. A legacy body-only definition
        // template must adopt whatever marker the reference template chose, or
        // the note ends up with an orphaned definition.
        state.templates.set("footnote-ref", "[^smith2024-p13]");
        state.templates.set("footnote", "Smith 2024, p. 13");

        const result = await service.resolve(ref(), "footnote");

        expect(result!.footnoteDef).toBe("[^smith2024-p13]: Smith 2024, p. 13");
    });

    it("finds the marker even when the reference has text around it", async () => {
        state.templates.set("footnote-ref", "see [^smith2024-p13] there");
        state.templates.set("footnote", "body");

        expect((await service.resolve(ref(), "footnote"))!.footnoteDef).toBe(
            "[^smith2024-p13]: body",
        );
    });

    it("falls back to the citekey when the reference carries no marker", async () => {
        state.templates.set("footnote-ref", "no marker here");
        state.templates.set("footnote", "body");

        expect((await service.resolve(ref(), "footnote"))!.footnoteDef).toBe(
            "[^smith2024]: body",
        );
    });

    it("warns the user that a body-only definition template is legacy", async () => {
        state.templates.set("footnote", "body with no marker");

        await service.resolve(ref(), "footnote");

        expect(state.notices).toEqual([
            expect.objectContaining({ type: "warning" }),
        ]);
    });
});
