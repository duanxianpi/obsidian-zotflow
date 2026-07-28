/**
 * Vendored CSL core (src/worker/csl).
 *
 * Real style/locale fixtures (apa, ieee, nature, …) drive the renderer, but
 * every fetch the service makes goes through an in-memory `StubFetcher` — the
 * code under test never touches the network.
 *
 * Migrated from scripts/test-csl.mjs.
 */
import { describe, test, expect, beforeAll } from "vitest";
import {
    CslRenderService,
    MemoryKVStore,
    UnavailableStyleError,
    extractStyleMeta,
    slugFromStyleUri,
} from "worker/csl";
import { loadCslFixtures } from "../fixtures/csl";

import type { ResourceFetcher } from "worker/csl";
import type { CSLItem } from "worker/csl";
import type { CslFixtures } from "../fixtures/csl";

/* ================================================================ */
/*  Stubs                                                           */
/* ================================================================ */

class StubFetcher implements ResourceFetcher {
    readonly calls: string[] = [];
    offline = false;

    constructor(public routes: Record<string, string> = {}) {}

    async fetchText(url: string): Promise<string> {
        // Update refetches append a cache-busting query param; routes and
        // call counting work on the clean URL.
        const clean = url.split("?")[0]!;
        this.calls.push(clean);
        if (this.offline) throw new Error(`offline: ${clean}`);
        const body = this.routes[clean];
        if (body === undefined) throw new Error(`404: ${clean}`);
        return body;
    }

    /** How many times a given URL was requested. */
    countOf(url: string): number {
        return this.calls.filter((u) => u === url).length;
    }
}

const ORPHAN_DEPENDENT = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" default-locale="en-US">
  <info>
    <title>Orphan Journal Style</title>
    <id>http://www.zotero.org/styles/orphan-journal</id>
    <link href="http://www.zotero.org/styles/does-not-exist-parent" rel="independent-parent"/>
  </info>
</style>`;

const CYCLE_A = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info><title>Cycle A</title><id>http://www.zotero.org/styles/cycle-a</id>
  <link href="http://www.zotero.org/styles/cycle-b" rel="independent-parent"/></info>
</style>`;

const CYCLE_B = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info><title>Cycle B</title><id>http://www.zotero.org/styles/cycle-b</id>
  <link href="http://www.zotero.org/styles/cycle-a" rel="independent-parent"/></info>
</style>`;

/** Minimal dependent style (alias) pointing at the given parent slug. */
const makeAlias = (id: string, parent: string) => `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info><title>${id} Journal</title><id>http://www.zotero.org/styles/${id}</id>
  <category citation-format="numeric"/>
  <link href="http://www.zotero.org/styles/${parent}" rel="independent-parent"/></info>
</style>`;

/** Independent note-only style: has <citation> but deliberately no <bibliography>. */
const NOTE_ONLY = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="note" version="1.0" default-locale="en-US">
  <info><title>Notes Only</title><id>http://www.zotero.org/styles/notes-only</id>
  <category citation-format="note"/></info>
  <citation><layout><text variable="title"/></layout></citation>
</style>`;

const ITEMS: Record<string, CSLItem> = {
    doe2020: {
        id: "doe2020",
        type: "article-journal",
        title: "A study of underscores_and_brackets [not a link]",
        author: [{ family: "Doe", given: "Jane" }],
        "container-title": "Journal of Testing",
        volume: "12",
        issue: "3",
        page: "45-67",
        issued: { "date-parts": [[2020]] },
        DOI: "10.1000/test.2020",
    },
    roe2021: {
        id: "roe2021",
        type: "book",
        title: "Handbook of Examples",
        author: [{ family: "Roe", given: "Richard" }],
        publisher: "Example Press",
        issued: { "date-parts": [[2021, 5, 4]] },
    },
    vaswaniNoDate: {
        id: "vaswani",
        type: "paper-conference",
        title: "Attention is all you need",
        author: [
            { family: "Vaswani", given: "Ashish" },
            { family: "Shazeer", given: "Noam" },
            { family: "Parmar", given: "Niki" },
        ],
        "container-title": "Advances in Neural Information Processing Systems",
    },
    johnSmith: {
        id: "smith-john",
        type: "article-journal",
        title: "First study",
        author: [{ family: "Smith", given: "John" }],
        issued: { "date-parts": [[2020]] },
    },
    robertSmith: {
        id: "smith-robert",
        type: "article-journal",
        title: "Second study",
        author: [{ family: "Smith", given: "Robert" }],
        issued: { "date-parts": [[2020]] },
    },
};

let fx: CslFixtures;

beforeAll(async () => {
    fx = await loadCslFixtures();
});

function makeService(routes: Record<string, string> = {}) {
    const fetcher = new StubFetcher(routes);
    const service = new CslRenderService({
        fetcher,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
    });
    return { service, fetcher };
}

/** Same, plus a sample URL template — only the sample tests need it. */
function makeSampleService(routes: Record<string, string> = {}) {
    const fetcher = new StubFetcher(routes);
    const service = new CslRenderService({
        fetcher,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
        styleSampleUrlTemplate: "sample://{path}",
    });
    return { service, fetcher };
}

/* ================================================================ */
/*  Rendering                                                       */
/* ================================================================ */

describe("rendering", () => {
    test("APA bibliography: (n.d.), author order, plain text", async () => {
        const { service } = makeService();
        const [entry] = await service.renderBibliography([ITEMS.vaswaniNoDate!], {
            styleXml: fx.apa,
            format: "text",
        });
        expect(entry).toMatch(/^Vaswani, A\., Shazeer, N\., & Parmar, N\./);
        expect(entry).toContain("(n.d.)");
        expect(entry).not.toMatch(/<\/?\w+/); // no HTML in text output
    });

    test("IEEE numbered style flattens to [n] entry", async () => {
        const { service } = makeService();
        const entries = await service.renderBibliography(
            [ITEMS.doe2020!, ITEMS.roe2021!],
            { styleXml: fx.ieee, format: "text" },
        );
        expect(entries[0]).toMatch(/^\[1\] /);
        expect(entries[1]).toMatch(/^\[2\] /);
        expect(entries[0]).not.toContain("\n");
    });

    test("HTML format: wrappers kept, strip option flattens", async () => {
        const { service } = makeService();
        const [kept] = await service.renderBibliography([ITEMS.doe2020!], {
            styleXml: fx.apa,
            format: "html",
        });
        expect(kept).toMatch(/^<div class="csl-entry">/);

        const [stripped] = await service.renderBibliography([ITEMS.doe2020!], {
            styleXml: fx.ieee,
            format: "html",
            htmlContainer: "strip",
        });
        expect(stripped).not.toContain("csl-entry");
        expect(stripped).toMatch(/^\[1\] /);
    });

    test("markdown format: italics + escaping", async () => {
        const { service } = makeService();
        const [entry] = await service.renderBibliography([ITEMS.doe2020!], {
            styleXml: fx.apa,
            format: "markdown",
        });
        expect(entry).toContain("*Journal of Testing*");
        expect(entry).toContain("underscores\\_and\\_brackets");
        expect(entry).toContain("\\[not a link\\]");
    });

    test("citation clusters", async () => {
        const { service } = makeService();
        const opts = { styleXml: fx.apa, format: "text" } as const;

        expect(
            await service.renderCitation([ITEMS.doe2020!, ITEMS.roe2021!], opts),
        ).toBe("(Doe, 2020; Roe, 2021)");

        // Locators are per-cite data (CiteProps), not CSL-JSON item fields.
        expect(
            await service.renderCitation([ITEMS.doe2020!], opts, {
                locator: "23",
                label: "page",
            }),
        ).toBe("(Doe, 2020, p. 23)");

        expect(
            await service.renderCitation([ITEMS.doe2020!], opts, {
                locator: "23-25",
                label: "page",
            }),
        ).toContain("pp. 23"); // range pluralizes the label

        expect(await service.renderCitation([ITEMS.doe2020!], opts)).toBe(
            "(Doe, 2020)",
        );

        // Per-cite props: an array is matched by position (sparse allowed).
        expect(
            await service.renderCitation(
                [ITEMS.doe2020!, ITEMS.roe2021!],
                opts,
                [{ locator: "5", label: "page" }, undefined],
            ),
        ).toBe("(Doe, 2020, p. 5; Roe, 2021)");
    });

    test("multi-context disambiguation isolation + pool reset", async () => {
        const { service } = makeService();

        const ctxA = await service.createContext({
            styleXml: fx.apa,
            format: "text",
        });
        ctxA.registerItems([ITEMS.johnSmith!]);
        expect(ctxA.addCitation(["smith-john"])).toBe("(Smith, 2020)");

        const ctxB = await service.createContext({
            styleXml: fx.apa,
            format: "text",
        });
        ctxB.registerItems([ITEMS.johnSmith!, ITEMS.robertSmith!]);
        expect(ctxB.addCitation(["smith-john"])).toBe("(J. Smith, 2020)");

        // A must not see B's disambiguation state.
        expect(ctxA.addCitation(["smith-john"])).toBe("(Smith, 2020)");
        expect(ctxA.makeBibliography()).toHaveLength(1);
        expect(ctxB.makeBibliography()).toHaveLength(2);

        ctxA.dispose();
        ctxB.dispose();

        // A fresh context reuses a pooled engine and must see none of the state.
        const ctxC = await service.createContext({
            styleXml: fx.apa,
            format: "text",
        });
        ctxC.registerItems([ITEMS.johnSmith!]);
        expect(ctxC.addCitation(["smith-john"])).toBe("(Smith, 2020)");
        ctxC.dispose();
    });
});

/* ================================================================ */
/*  Style resolution                                                */
/* ================================================================ */

describe("style resolution", () => {
    test("remote style fetched once, then served from cache", async () => {
        const { service, fetcher } = makeService({ "style://apa": fx.apa });

        expect((await service.ensureStyle("apa")).status).toBe("ready");
        await service.renderBibliography([ITEMS.doe2020!], { styleId: "apa" });

        fetcher.offline = true; // must still render from cache
        const [entry] = await service.renderBibliography([ITEMS.doe2020!], {
            styleId: "apa",
        });
        expect(entry).toContain("Doe, J. (2020).");
        expect(fetcher.countOf("style://apa")).toBe(1);
    });

    test("dependent style resolves through its parent", async () => {
        const { service } = makeService({
            "style://nature-neuroscience": fx.natureNeuro,
            "style://nature": fx.nature,
            "locale://en-GB": fx.enUS, // stand-in body for en-GB
        });

        expect((await service.ensureStyle("nature-neuroscience")).status).toBe(
            "ready",
        );
        const [entry] = await service.renderBibliography([ITEMS.doe2020!], {
            styleId: "nature-neuroscience",
        });
        expect(entry).toContain("Doe, J.");
    });

    test("unresolved parent → structured error, no broken output", async () => {
        const { service } = makeService({ "style://orphan": ORPHAN_DEPENDENT });

        // One assertion over the whole union member: `parent` only exists on
        // the "unresolved-parent" variant, so checking status separately would
        // not narrow it.
        expect(await service.ensureStyle("orphan")).toMatchObject({
            status: "unresolved-parent",
            parent: "does-not-exist-parent",
        });

        const caught = await service
            .renderBibliography([ITEMS.doe2020!], { styleId: "orphan" })
            .then(
                () => null,
                (e: unknown) => e,
            );
        expect(caught).toBeInstanceOf(UnavailableStyleError);
        expect((caught as UnavailableStyleError).availability.status).toBe(
            "unresolved-parent",
        );
    });

    test("dependent cycle detected as invalid (no infinite loop)", async () => {
        const { service } = makeService({
            "style://cycle-a": CYCLE_A,
            "style://cycle-b": CYCLE_B,
        });
        expect(await service.ensureStyle("cycle-a")).toMatchObject({
            status: "invalid",
            reason: expect.stringMatching(/cycle/i),
        });
    });

    test("custom styles: folder overrides remote, invalid flagged", async () => {
        const { service } = makeService({ "style://apa": fx.apa });
        await service.ensureStyle("apa");

        // Register IEEE under the id "apa": the folder version must win.
        expect((await service.registerCustomStyle("apa", fx.ieee)).status).toBe(
            "ready",
        );
        const [entry] = await service.renderBibliography([ITEMS.doe2020!], {
            styleId: "apa",
        });
        expect(entry).toMatch(/^\[1\] /); // IEEE output, not APA

        expect(
            (await service.registerCustomStyle("broken", "<style>oops")).status,
        ).toBe("invalid");
        expect(
            (await service.registerCustomStyle("orphan", ORPHAN_DEPENDENT)).status,
        ).toBe("unresolved-parent");
    });

    test("style id: query params stripped, style's own id preferred", async () => {
        expect(
            slugFromStyleUri("https://www.zotero.org/styles/nature?source=1"),
        ).toBe("nature");
        expect(
            slugFromStyleUri("https://www.zotero.org/styles/nature#frag"),
        ).toBe("nature");

        const { service } = makeSampleService({
            "https://example.com/some/path/whatever": fx.nature,
            "style://nature": fx.nature,
        });

        // URL input with tracking params: fetched from the given URL, but the
        // id comes from the style's own <info><id> declaration.
        const fromUrl = await service.previewStyle(
            "https://example.com/some/path/whatever?source=1",
        );
        expect(fromUrl.id).toBe("nature");

        // Plain id input with a stray query suffix.
        expect((await service.previewStyle("nature?source=1")).id).toBe("nature");
    });

    test("meta extraction: citation-format + hasBibliography (never inferred)", () => {
        const apaMeta = extractStyleMeta(fx.apa);
        expect(apaMeta.citationFormat).toBe("author-date");
        expect(apaMeta.hasBibliography).toBe(true);

        expect(extractStyleMeta(fx.ieee).citationFormat).toBe("numeric");

        const noteMeta = extractStyleMeta(NOTE_ONLY);
        expect(noteMeta.citationFormat).toBe("note");
        // Absence recorded, not guessed.
        expect(noteMeta.hasBibliography).toBe(false);

        // Dependent style: unknown, inherited from the parent.
        expect(extractStyleMeta(fx.natureNeuro).hasBibliography).toBeUndefined();
    });
});

/* ================================================================ */
/*  Locales                                                         */
/* ================================================================ */

describe("locales", () => {
    test("lazy load, cache, unresolved-locale", async () => {
        const { service, fetcher } = makeService({
            "style://apa": fx.apa,
            "locale://de-DE": fx.deDE,
        });

        await service.renderBibliography([ITEMS.doe2020!], {
            styleId: "apa",
            locale: "de-DE",
        });
        await service.renderBibliography([ITEMS.doe2020!], {
            styleId: "apa",
            locale: "de", // bare tag normalizes to de-DE, already cached
        });
        expect(fetcher.countOf("locale://de-DE")).toBe(1);

        const caught = await service
            .renderBibliography([ITEMS.doe2020!], {
                styleId: "apa",
                locale: "fr-FR",
            })
            .then(
                () => null,
                (e: unknown) => e,
            );
        expect((caught as UnavailableStyleError).availability?.status).toBe(
            "unresolved-locale",
        );

        const locales = await service.listLocales();
        expect(locales).toContainEqual(
            expect.objectContaining({ tag: "en-US", source: "builtin" }),
        );
        expect(locales).toContainEqual(
            expect.objectContaining({ tag: "de-DE", source: "remote-cache" }),
        );

        await service.removeLocale("de-DE");
        expect((await service.listLocales()).map((l) => l.tag)).not.toContain(
            "de-DE",
        );
    });

    test("preview/add/update with provenance", async () => {
        const { service, fetcher } = makeService({ "locale://de-DE": fx.deDE });

        const preview = await service.previewLocale("de"); // bare tag normalizes
        expect(preview.tag).toBe("de-DE");
        expect(preview.sourceUrl).toBe("locale://de-DE");
        await service.addLocale(preview);

        const de = (await service.listLocales()).find((l) => l.tag === "de-DE");
        expect(de).toMatchObject({
            source: "remote-cache",
            sourceUrl: "locale://de-DE",
        });

        expect((await service.updateLocale("de-DE")).updated).toBe(false);
        fetcher.routes["locale://de-DE"] = fx.deDE.replace("<locale", "<locale  ");
        expect((await service.updateLocale("de-DE")).updated).toBe(true);

        // Never downloaded: refuse rather than silently fetch.
        await expect(service.updateLocale("fr-FR")).rejects.toThrow();
    });

    test("bundled en-US is updatable; overlay survives a restart", async () => {
        // A recognisably different repo copy: rewrite the "no date" term.
        const modified = fx.enUS.split("n.d.").join("X.Y.");
        const store = new MemoryKVStore();
        const service = new CslRenderService({
            fetcher: new StubFetcher({ "locale://en-US": modified }),
            store,
            styleUrlTemplate: "style://{id}",
            localeUrlTemplate: "locale://{lang}",
        });

        expect((await service.updateLocale("en-US")).updated).toBe(true);

        const en = (await service.listLocales()).find((l) => l.tag === "en-US");
        expect(en?.source).toBe("builtin"); // still listed as builtin
        expect(typeof en?.fetchedAt).toBe("number"); // overlay provenance surfaced

        // A fresh service over the same store (= plugin restart) must serve
        // the overlay, not the bundled asset.
        const restarted = new CslRenderService({
            fetcher: new StubFetcher(),
            store,
            styleUrlTemplate: "style://{id}",
            localeUrlTemplate: "locale://{lang}",
        });
        const [entry] = await restarted.renderBibliography(
            [ITEMS.vaswaniNoDate!],
            { styleXml: fx.apa, format: "text" },
        );
        expect(entry).toContain("(X.Y.)");
    });
});

/* ================================================================ */
/*  Install / update / remove                                       */
/* ================================================================ */

describe("install, update, remove", () => {
    test("preview + add: provenance recorded, chain + locale auto-added", async () => {
        const { service } = makeService({
            "style://nature-neuroscience": fx.natureNeuro,
            "style://nature": fx.nature,
            "locale://en-GB": fx.enUS, // stand-in body for en-GB
        });

        const preview = await service.previewStyle("nature-neuroscience");
        expect(preview).toMatchObject({
            id: "nature-neuroscience",
            dependent: true,
            parent: "nature",
            sourceUrl: "style://nature-neuroscience",
            alreadyInstalled: false,
        });
        expect(await service.listStyles()).toHaveLength(0); // preview caches nothing

        expect((await service.addStyle(preview)).status).toBe("ready");

        const styles = await service.listStyles();
        const leaf = styles.find((s) => s.id === "nature-neuroscience");
        const parent = styles.find((s) => s.id === "nature");
        expect(leaf?.remote?.sourceUrl).toBe("style://nature-neuroscience");
        expect(typeof leaf?.remote?.fetchedAt).toBe("number");
        expect(parent?.remote?.sourceUrl).toBe("style://nature");

        const enGB = (await service.listLocales()).find((l) => l.tag === "en-GB");
        expect(enGB).toMatchObject({
            source: "remote-cache",
            sourceUrl: "locale://en-GB",
        });
    });

    test("updateStyle refetches the whole dependency chain", async () => {
        const { service, fetcher } = makeService({
            "style://nature-neuroscience": fx.natureNeuro,
            "style://nature": fx.nature,
            "locale://en-GB": fx.enUS,
        });
        await service.addStyle(await service.previewStyle("nature-neuroscience"));

        // Upstream revises the parent; the leaf is unchanged. (A whitespace-only
        // change keeps the fixture parseable but alters the cached text.)
        fetcher.routes["style://nature"] = fx.nature.replace("<style", "<style  ");
        const report = await service.updateStyle("nature-neuroscience");
        expect(report.updated).toContain("nature");
        expect(report.unchanged).toContain("nature-neuroscience");
        expect(report.failed).toHaveLength(0);
        expect(report.availability.status).toBe("ready");

        // A folder style has no source url to update from.
        await service.registerCustomStyle("my-folder-style", fx.ieee);
        await expect(service.updateStyle("my-folder-style")).rejects.toThrow();

        // Offline update must report a failure, never "up to date".
        fetcher.offline = true;
        const offline = await service.updateStyle("nature-neuroscience");
        expect(offline.failed.length).toBeGreaterThan(0);
        expect(offline.updated).toHaveLength(0);
        expect(offline.unchanged).toHaveLength(0);

        fetcher.offline = false;
        const [entry] = await service.renderBibliography([ITEMS.doe2020!], {
            styleId: "nature-neuroscience",
        });
        expect(entry).toContain("Doe"); // cached copy still renders
    });

    test("ref-counted removal: aliases share an implicit parent", async () => {
        const { service } = makeService({
            "style://alias-one": makeAlias("alias-one", "nature"),
            "style://alias-two": makeAlias("alias-two", "nature"),
            "style://nature": fx.nature,
            "locale://en-GB": fx.enUS,
        });
        await service.addStyle(await service.previewStyle("alias-one"));
        await service.addStyle(await service.previewStyle("alias-two"));

        const styles = await service.listStyles();
        expect(styles.find((s) => s.id === "nature")?.explicit).toBe(false);
        expect(styles.find((s) => s.id === "alias-one")?.explicit).toBe(true);

        await service.removeStyle("alias-one");
        expect((await service.listStyles()).map((s) => s.id)).toContain("nature");

        await service.removeStyle("alias-two");
        expect(await service.listStyles()).toHaveLength(0);
    });

    test("ref-counted removal: explicitly installed parent survives", async () => {
        const { service } = makeService({
            "style://alias-one": makeAlias("alias-one", "nature"),
            "style://nature": fx.nature,
            "locale://en-GB": fx.enUS,
        });
        // User installs the parent directly, then an alias of it.
        await service.addStyle(await service.previewStyle("nature"));
        await service.addStyle(await service.previewStyle("alias-one"));

        await service.removeStyle("alias-one");
        expect((await service.listStyles()).map((s) => s.id)).toContain("nature");
    });

    test("updateAllStyles: shared parent refetched once, checkedAt persisted", async () => {
        const { service, fetcher } = makeService({
            "style://alias-one": makeAlias("alias-one", "nature"),
            "style://alias-two": makeAlias("alias-two", "nature"),
            "style://nature": fx.nature,
            "locale://en-GB": fx.enUS,
        });
        await service.addStyle(await service.previewStyle("alias-one"));
        await service.addStyle(await service.previewStyle("alias-two"));

        const before = fetcher.countOf("style://nature");
        const report = await service.updateAllStyles();
        expect(fetcher.countOf("style://nature") - before).toBe(1);
        expect(report.unchanged.filter((id) => id === "nature")).toHaveLength(1);
        expect(typeof report.checkedAt).toBe("number");

        const status = await service.getUpdateStatus();
        expect(status.stylesCheckedAt).toBe(report.checkedAt);
        expect(status.localesCheckedAt).toBeUndefined();

        const locReport = await service.updateAllLocales();
        expect(locReport.unchanged).toContain("en-GB");
        // Bundled en-US is included in update-all; it fails here for want of a route.
        expect(locReport.failed).toContainEqual(
            expect.objectContaining({ id: "en-US" }),
        );
        expect((await service.getUpdateStatus()).localesCheckedAt).toBe(
            locReport.checkedAt,
        );
    });
});

/* ================================================================ */
/*  Rendered samples                                                */
/* ================================================================ */

describe("rendered samples", () => {
    const sampleJson = JSON.stringify({
        citation: ["(Doe, 2020)", "(Roe, 2021)"],
        bibliography:
            '<div class="csl-bib-body"><div class="csl-entry">Doe, J. (2020).</div></div>',
    });

    test("fetched during preview when available", async () => {
        const { service } = makeSampleService({
            "style://apa": fx.apa,
            "sample://apa": sampleJson,
            "style://nature-neuroscience": fx.natureNeuro,
            "sample://dependent/nature-neuroscience": sampleJson,
        });

        const independent = await service.previewStyle("apa");
        expect(independent.sample?.citations).toHaveLength(2);
        expect(independent.sample?.bibliographyHtml).toContain("csl-bib-body");

        // Dependent styles publish their samples under dependent/.
        const dependent = await service.previewStyle("nature-neuroscience");
        expect(dependent.sample?.bibliographyHtml).toContain("csl-bib-body");
    });

    test("missing sample tolerated", async () => {
        const { service } = makeSampleService({ "style://apa": fx.apa });
        expect((await service.previewStyle("apa")).sample).toBeUndefined();
    });

    test("persist for offline Details and refresh on update", async () => {
        const sampleV1 = JSON.stringify({
            citation: ["(One, 2020)"],
            bibliography: '<div class="csl-bib-body">v1</div>',
        });
        const sampleV2 = JSON.stringify({
            citation: ["(Two, 2021)"],
            bibliography: '<div class="csl-bib-body">v2</div>',
        });
        const { service, fetcher } = makeSampleService({
            "style://apa": fx.apa,
            "sample://apa": sampleV1,
        });

        await service.addStyle(await service.previewStyle("apa"));

        fetcher.offline = true;
        expect((await service.styleSample("apa"))?.bibliographyHtml).toContain(
            "v1",
        );
        fetcher.offline = false;

        fetcher.routes["sample://apa"] = sampleV2;
        await service.updateStyle("apa");
        fetcher.offline = true;
        expect((await service.styleSample("apa"))?.bibliographyHtml).toContain(
            "v2",
        );
        fetcher.offline = false;

        await service.removeStyle("apa");
        fetcher.offline = true;
        expect(await service.styleSample("apa")).toBeUndefined();
    });

    test("adding an alias caches the auto-fetched parent's sample too", async () => {
        const sample = (v: string) =>
            JSON.stringify({
                citation: ["[1]"],
                bibliography: `<div class="csl-bib-body">${v}</div>`,
            });
        const { service, fetcher } = makeSampleService({
            "style://nature-neuroscience": fx.natureNeuro,
            "style://nature": fx.nature,
            "locale://en-GB": fx.enUS,
            "sample://dependent/nature-neuroscience": sample("alias"),
            "sample://nature": sample("parent"),
        });
        await service.addStyle(await service.previewStyle("nature-neuroscience"));

        fetcher.offline = true;
        expect(
            (await service.styleSample("nature-neuroscience"))?.bibliographyHtml,
        ).toContain("alias");
        expect((await service.styleSample("nature"))?.bibliographyHtml).toContain(
            "parent",
        );
    });
});
