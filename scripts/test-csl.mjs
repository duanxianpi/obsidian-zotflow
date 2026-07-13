/**
 * Standalone test runner for the vendored CSL core (src/worker/csl).
 *
 * No test framework needed:
 *   node scripts/test-csl.mjs
 *
 * Real CSL fixtures (apa, ieee, nature, …) are downloaded once into
 * scripts/.csl-fixtures/ and reused afterwards, so repeat runs work offline.
 * All assertions run against in-memory stubs — the network is never touched
 * by the code under test.
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "scripts", ".csl-fixtures");
const BUNDLE = join(FIXTURES, "csl-core.test-bundle.mjs");

const REMOTE_FIXTURES = {
    "apa.csl":
        "https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl",
    "ieee.csl":
        "https://raw.githubusercontent.com/citation-style-language/styles/master/ieee.csl",
    "nature.csl":
        "https://raw.githubusercontent.com/citation-style-language/styles/master/nature.csl",
    "nature-neuroscience.csl":
        "https://raw.githubusercontent.com/citation-style-language/styles/master/dependent/nature-neuroscience.csl",
    "locales-de-DE.xml":
        "https://raw.githubusercontent.com/citation-style-language/locales/master/locales-de-DE.xml",
    "locales-en-US.xml":
        "https://raw.githubusercontent.com/citation-style-language/locales/master/locales-en-US.xml",
};

/* ---------------------------------------------------------------- */
/* Tiny test harness                                                 */
/* ---------------------------------------------------------------- */

let passed = 0;
const failures = [];
let current = "";

function check(condition, label) {
    if (condition) {
        passed++;
    } else {
        failures.push(`${current}: ${label}`);
        console.error(`  ✗ ${label}`);
    }
}

async function test(name, fn) {
    current = name;
    try {
        await fn();
        console.log(`✓ ${name}`);
    } catch (e) {
        failures.push(`${name}: threw ${e && e.message}`);
        console.error(`✗ ${name} — threw: ${e && e.stack}`);
    }
}

/* ---------------------------------------------------------------- */
/* Fixtures + bundle                                                 */
/* ---------------------------------------------------------------- */

async function ensureFixtures() {
    await mkdir(FIXTURES, { recursive: true });
    for (const [name, url] of Object.entries(REMOTE_FIXTURES)) {
        const path = join(FIXTURES, name);
        if (existsSync(path)) continue;
        console.log(`fetching fixture ${name} …`);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Cannot download fixture ${name} (HTTP ${res.status}). ` +
                    `Run once with network access; fixtures are cached afterwards.`,
            );
        }
        await writeFile(path, await res.text(), "utf8");
    }
}

async function bundleCore() {
    await build({
        entryPoints: [join(ROOT, "src", "worker", "csl", "index.ts")],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "es2022",
        outfile: BUNDLE,
        logLevel: "silent",
    });
    return import(pathToFileURL(BUNDLE).href);
}

/* ---------------------------------------------------------------- */
/* Stubs                                                             */
/* ---------------------------------------------------------------- */

class StubFetcher {
    constructor(routes = {}) {
        this.routes = routes;
        this.calls = [];
        this.offline = false;
    }
    async fetchText(url) {
        // Update refetches append a cache-busting query param; routes and
        // call counting work on the clean URL.
        const clean = url.split("?")[0];
        this.calls.push(clean);
        if (this.offline) throw new Error(`offline: ${clean}`);
        const body = this.routes[clean];
        if (body === undefined) throw new Error(`404: ${clean}`);
        return body;
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
const makeAlias = (id, parent) => `<?xml version="1.0" encoding="utf-8"?>
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

const ITEMS = {
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

/* ---------------------------------------------------------------- */
/* Main                                                              */
/* ---------------------------------------------------------------- */

await ensureFixtures();
const core = await bundleCore();
const {
    CslRenderService,
    MemoryKVStore,
    UnavailableStyleError,
    extractStyleMeta,
    slugFromStyleUri,
} = core;

const fx = async (name) => readFile(join(FIXTURES, name), "utf8");
const apa = await fx("apa.csl");
const ieee = await fx("ieee.csl");
const nature = await fx("nature.csl");
const natureNeuro = await fx("nature-neuroscience.csl");
const deDE = await fx("locales-de-DE.xml");
const enUS = await fx("locales-en-US.xml");

function makeService(routes = {}) {
    const fetcher = new StubFetcher(routes);
    const service = new CslRenderService({
        fetcher,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
    });
    return { service, fetcher };
}

await test("APA bibliography: (n.d.), author order, plain text", async () => {
    const { service } = makeService();
    const [entry] = await service.renderBibliography([ITEMS.vaswaniNoDate], {
        styleXml: apa,
        format: "text",
    });
    check(
        entry.startsWith("Vaswani, A., Shazeer, N., & Parmar, N."),
        "author order",
    );
    check(entry.includes("(n.d.)"), "missing date renders as (n.d.)");
    check(!/<\/?\w+/.test(entry), "no HTML in text output");
});

await test("IEEE numbered style flattens to [n] entry", async () => {
    const { service } = makeService();
    const entries = await service.renderBibliography(
        [ITEMS.doe2020, ITEMS.roe2021],
        { styleXml: ieee, format: "text" },
    );
    check(/^\[1\] /.test(entries[0]), "first entry starts with [1]");
    check(/^\[2\] /.test(entries[1]), "second entry starts with [2]");
    check(!entries[0].includes("\n"), "entry is a single line");
});

await test("HTML format: wrappers kept, strip option flattens", async () => {
    const { service } = makeService();
    const [kept] = await service.renderBibliography([ITEMS.doe2020], {
        styleXml: apa,
        format: "html",
    });
    check(kept.startsWith('<div class="csl-entry">'), "csl-entry wrapper kept");
    const [stripped] = await service.renderBibliography([ITEMS.doe2020], {
        styleXml: ieee,
        format: "html",
        htmlContainer: "strip",
    });
    check(!stripped.includes("csl-entry"), "wrapper stripped");
    check(stripped.startsWith("[1] "), "numbered flattened in stripped html");
});

await test("markdown format: italics + escaping", async () => {
    const { service } = makeService();
    const [entry] = await service.renderBibliography([ITEMS.doe2020], {
        styleXml: apa,
        format: "markdown",
    });
    check(entry.includes("*Journal of Testing*"), "italics as *…*");
    check(entry.includes("underscores\\_and\\_brackets"), "underscores escaped");
    check(entry.includes("\\[not a link\\]"), "brackets escaped");
});

await test("citation clusters", async () => {
    const { service } = makeService();
    const cite = await service.renderCitation(
        [ITEMS.doe2020, ITEMS.roe2021],
        { styleXml: apa, format: "text" },
    );
    check(cite === "(Doe, 2020; Roe, 2021)", `multi-item cluster (got "${cite}")`);

    // Locators are per-cite data (CiteProps), not CSL-JSON item fields.
    const paged = await service.renderCitation(
        [ITEMS.doe2020],
        { styleXml: apa, format: "text" },
        { locator: "23", label: "page" },
    );
    check(paged === "(Doe, 2020, p. 23)", `page locator (got "${paged}")`);

    const ranged = await service.renderCitation(
        [ITEMS.doe2020],
        { styleXml: apa, format: "text" },
        { locator: "23-25", label: "page" },
    );
    check(
        ranged.includes("pp. 23"),
        `page range pluralizes the label (got "${ranged}")`,
    );

    const plain = await service.renderCitation(
        [ITEMS.doe2020],
        { styleXml: apa, format: "text" },
    );
    check(plain === "(Doe, 2020)", `no props -> unchanged (got "${plain}")`);

    // Per-cite props: an array is matched by position (sparse allowed).
    const mixed = await service.renderCitation(
        [ITEMS.doe2020, ITEMS.roe2021],
        { styleXml: apa, format: "text" },
        [{ locator: "5", label: "page" }, undefined],
    );
    check(
        mixed === "(Doe, 2020, p. 5; Roe, 2021)",
        `per-cite locator array (got "${mixed}")`,
    );
});

await test("remote style fetched once, then served from cache", async () => {
    const { service, fetcher } = makeService({ "style://apa": apa });
    const avail = await service.ensureStyle("apa");
    check(avail.status === "ready", "ensureStyle -> ready");
    await service.renderBibliography([ITEMS.doe2020], { styleId: "apa" });
    fetcher.offline = true; // must still render from cache
    const [entry] = await service.renderBibliography([ITEMS.doe2020], {
        styleId: "apa",
    });
    check(entry.includes("Doe, J. (2020)."), "offline render from cache");
    check(
        fetcher.calls.filter((u) => u === "style://apa").length === 1,
        "style fetched exactly once",
    );
});

await test("dependent style resolves through its parent", async () => {
    const { service } = makeService({
        "style://nature-neuroscience": natureNeuro,
        "style://nature": nature,
        "locale://en-GB": enUS, // stand-in body for en-GB
    });
    const avail = await service.ensureStyle("nature-neuroscience");
    check(avail.status === "ready", "dependent chain closes");
    const [entry] = await service.renderBibliography([ITEMS.doe2020], {
        styleId: "nature-neuroscience",
    });
    check(entry.includes("Doe, J."), "renders via parent style");
});

await test("unresolved parent -> structured error, no broken output", async () => {
    const { service } = makeService({ "style://orphan": ORPHAN_DEPENDENT });
    const avail = await service.ensureStyle("orphan");
    check(avail.status === "unresolved-parent", "availability status");
    check(avail.parent === "does-not-exist-parent", "missing parent named");
    let caught;
    try {
        await service.renderBibliography([ITEMS.doe2020], { styleId: "orphan" });
    } catch (e) {
        caught = e;
    }
    check(caught instanceof UnavailableStyleError, "throws UnavailableStyleError");
    check(
        caught && caught.availability.status === "unresolved-parent",
        "availability attached to error",
    );
});

await test("dependent cycle detected as invalid (no infinite loop)", async () => {
    const { service } = makeService({
        "style://cycle-a": CYCLE_A,
        "style://cycle-b": CYCLE_B,
    });
    const avail = await service.ensureStyle("cycle-a");
    check(avail.status === "invalid", "cycle -> invalid");
    check(/cycle/i.test(avail.reason || ""), "reason mentions the cycle");
});

await test("locales: lazy load, cache, unresolved-locale", async () => {
    const { service, fetcher } = makeService({
        "style://apa": apa,
        "locale://de-DE": deDE,
    });
    await service.renderBibliography([ITEMS.doe2020], {
        styleId: "apa",
        locale: "de-DE",
    });
    await service.renderBibliography([ITEMS.doe2020], {
        styleId: "apa",
        locale: "de", // bare tag normalizes to de-DE, already cached
    });
    check(
        fetcher.calls.filter((u) => u === "locale://de-DE").length === 1,
        "locale fetched exactly once",
    );
    let caught;
    try {
        await service.renderBibliography([ITEMS.doe2020], {
            styleId: "apa",
            locale: "fr-FR",
        });
    } catch (e) {
        caught = e;
    }
    check(
        caught && caught.availability?.status === "unresolved-locale",
        "unfetchable locale -> unresolved-locale error",
    );
    const locales = await service.listLocales();
    check(
        locales.some((l) => l.tag === "en-US" && l.source === "builtin"),
        "en-US listed as builtin",
    );
    check(
        locales.some((l) => l.tag === "de-DE" && l.source === "remote-cache"),
        "de-DE listed as cached",
    );
    await service.removeLocale("de-DE");
    const after = await service.listLocales();
    check(!after.some((l) => l.tag === "de-DE"), "removeLocale removes it");
});

await test("custom styles: folder overrides remote, invalid flagged", async () => {
    const { service } = makeService({ "style://apa": apa });
    await service.ensureStyle("apa");
    // Register IEEE under the id "apa": the folder version must win.
    const avail = await service.registerCustomStyle("apa", ieee);
    check(avail.status === "ready", "folder style ready");
    const [entry] = await service.renderBibliography([ITEMS.doe2020], {
        styleId: "apa",
    });
    check(/^\[1\] /.test(entry), "folder style shadows remote (IEEE output)");

    const bad = await service.registerCustomStyle("broken", "<style>oops");
    check(bad.status === "invalid", "broken XML flagged invalid at registration");

    const orphan = await service.registerCustomStyle("orphan", ORPHAN_DEPENDENT);
    check(
        orphan.status === "unresolved-parent",
        "dependent custom style with unreachable parent flagged",
    );
});

await test("multi-context disambiguation isolation + pool reset", async () => {
    const { service } = makeService();

    const ctxA = await service.createContext({ styleXml: apa, format: "text" });
    ctxA.registerItems([ITEMS.johnSmith]);
    check(
        ctxA.addCitation(["smith-john"]) === "(Smith, 2020)",
        "context A: no disambiguation needed",
    );

    const ctxB = await service.createContext({ styleXml: apa, format: "text" });
    ctxB.registerItems([ITEMS.johnSmith, ITEMS.robertSmith]);
    check(
        ctxB.addCitation(["smith-john"]) === "(J. Smith, 2020)",
        "context B: initials disambiguate",
    );

    check(
        ctxA.addCitation(["smith-john"]) === "(Smith, 2020)",
        "context A unaffected by B",
    );
    check(ctxA.makeBibliography().length === 1, "A bibliography has 1 entry");
    check(ctxB.makeBibliography().length === 2, "B bibliography has 2 entries");

    ctxA.dispose();
    ctxB.dispose();

    // A fresh context reuses a pooled engine and must see none of the state.
    const ctxC = await service.createContext({ styleXml: apa, format: "text" });
    ctxC.registerItems([ITEMS.johnSmith]);
    check(
        ctxC.addCitation(["smith-john"]) === "(Smith, 2020)",
        "pooled engine fully reset",
    );
    ctxC.dispose();
});

await test("preview + add: provenance recorded, chain + locale auto-added", async () => {
    const { service } = makeService({
        "style://nature-neuroscience": natureNeuro,
        "style://nature": nature,
        "locale://en-GB": enUS, // stand-in body for en-GB
    });

    const preview = await service.previewStyle("nature-neuroscience");
    check(preview.id === "nature-neuroscience", "preview id from input");
    check(preview.dependent === true, "preview reports dependent");
    check(preview.parent === "nature", "preview names the parent");
    check(
        preview.sourceUrl === "style://nature-neuroscience",
        "preview carries the source url",
    );
    check(preview.alreadyInstalled === false, "not installed before add");
    check((await service.listStyles()).length === 0, "preview caches nothing");

    const avail = await service.addStyle(preview);
    check(avail.status === "ready", "addStyle closes the chain");

    const styles = await service.listStyles();
    const leaf = styles.find((s) => s.id === "nature-neuroscience");
    const parent = styles.find((s) => s.id === "nature");
    check(
        leaf?.remote?.sourceUrl === "style://nature-neuroscience",
        "leaf records its source url",
    );
    check(typeof leaf?.remote?.fetchedAt === "number", "leaf records fetchedAt");
    check(
        parent?.remote?.sourceUrl === "style://nature",
        "auto-fetched parent records its source url",
    );

    const locales = await service.listLocales();
    const enGB = locales.find((l) => l.tag === "en-GB");
    check(
        enGB?.source === "remote-cache" && enGB.sourceUrl === "locale://en-GB",
        "style default locale auto-added with provenance",
    );
});

await test("updateStyle refetches the whole dependency chain", async () => {
    const routes = {
        "style://nature-neuroscience": natureNeuro,
        "style://nature": nature,
        "locale://en-GB": enUS,
    };
    const { service, fetcher } = makeService(routes);
    await service.addStyle(await service.previewStyle("nature-neuroscience"));

    // Upstream revises the parent; the leaf is unchanged. (A whitespace-only
    // change keeps the fixture parseable but alters the cached text.)
    fetcher.routes["style://nature"] = nature.replace("<style", "<style  ");
    const report = await service.updateStyle("nature-neuroscience");
    check(report.updated.includes("nature"), "parent detected as updated");
    check(
        report.unchanged.includes("nature-neuroscience"),
        "unchanged leaf reported as such",
    );
    check(report.failed.length === 0, "no failures");
    check(report.availability.status === "ready", "still ready after update");

    let threw = false;
    try {
        await service.registerCustomStyle("my-folder-style", ieee);
        await service.updateStyle("my-folder-style");
    } catch {
        threw = true;
    }
    check(threw, "updateStyle refuses styles without a source url");

    // Offline update must report a failure, never "up to date".
    fetcher.offline = true;
    const offline = await service.updateStyle("nature-neuroscience");
    check(offline.failed.length > 0, "offline update reports failures");
    check(
        offline.updated.length === 0 && offline.unchanged.length === 0,
        "offline update reports nothing as checked",
    );
    fetcher.offline = false;
    const [entry] = await service.renderBibliography([ITEMS.doe2020], {
        styleId: "nature-neuroscience",
    });
    check(entry.includes("Doe"), "cached copy still renders after failed update");
});

await test("locale preview/add/update with provenance", async () => {
    const { service, fetcher } = makeService({ "locale://de-DE": deDE });

    const preview = await service.previewLocale("de"); // bare tag normalizes
    check(preview.tag === "de-DE", "tag normalized in preview");
    check(preview.sourceUrl === "locale://de-DE", "preview carries source url");
    await service.addLocale(preview);

    const locales = await service.listLocales();
    const de = locales.find((l) => l.tag === "de-DE");
    check(
        de?.source === "remote-cache" && de.sourceUrl === "locale://de-DE",
        "added locale records provenance",
    );

    check(
        (await service.updateLocale("de-DE")).updated === false,
        "unchanged locale reports updated: false",
    );
    fetcher.routes["locale://de-DE"] = deDE.replace("<locale", "<locale  ");
    check(
        (await service.updateLocale("de-DE")).updated === true,
        "changed locale reports updated: true",
    );
    let threw = false;
    try {
        await service.updateLocale("fr-FR");
    } catch {
        threw = true;
    }
    check(threw, "updateLocale refuses locales that were never downloaded");
});

await test("style preview: rendered sample fetched when available", async () => {
    const sampleJson = JSON.stringify({
        citation: ["(Doe, 2020)", "(Roe, 2021)"],
        bibliography:
            '<div class="csl-bib-body"><div class="csl-entry">Doe, J. (2020).</div></div>',
    });
    const fetcher = new StubFetcher({
        "style://apa": apa,
        "sample://apa": sampleJson,
        "style://nature-neuroscience": natureNeuro,
        "sample://dependent/nature-neuroscience": sampleJson,
    });
    const service = new CslRenderService({
        fetcher,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
        styleSampleUrlTemplate: "sample://{path}",
    });

    const independent = await service.previewStyle("apa");
    check(
        independent.sample?.citations.length === 2,
        "independent style sample citations",
    );
    check(
        independent.sample?.bibliographyHtml.includes("csl-bib-body") === true,
        "independent style sample bibliography",
    );

    const dependent = await service.previewStyle("nature-neuroscience");
    check(
        dependent.sample?.bibliographyHtml.includes("csl-bib-body") === true,
        "dependent style sample found under dependent/",
    );

    // No sample published: preview still succeeds, sample is undefined.
    const bare = new StubFetcher({ "style://apa": apa });
    const bareService = new CslRenderService({
        fetcher: bare,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
        styleSampleUrlTemplate: "sample://{path}",
    });
    const noSample = await bareService.previewStyle("apa");
    check(noSample.sample === undefined, "missing sample tolerated");
});

await test("samples persist for offline Details and refresh on update", async () => {
    const sampleV1 = JSON.stringify({
        citation: ["(One, 2020)"],
        bibliography: '<div class="csl-bib-body">v1</div>',
    });
    const sampleV2 = JSON.stringify({
        citation: ["(Two, 2021)"],
        bibliography: '<div class="csl-bib-body">v2</div>',
    });
    const fetcher = new StubFetcher({
        "style://apa": apa,
        "sample://apa": sampleV1,
    });
    const service = new CslRenderService({
        fetcher,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
        styleSampleUrlTemplate: "sample://{path}",
    });

    await service.addStyle(await service.previewStyle("apa"));

    fetcher.offline = true;
    const offline = await service.styleSample("apa");
    check(
        offline?.bibliographyHtml.includes("v1") === true,
        "sample served from cache while offline",
    );
    fetcher.offline = false;

    fetcher.routes["sample://apa"] = sampleV2;
    await service.updateStyle("apa");
    fetcher.offline = true;
    const refreshed = await service.styleSample("apa");
    check(
        refreshed?.bibliographyHtml.includes("v2") === true,
        "update refreshed the cached sample",
    );
    fetcher.offline = false;

    await service.removeStyle("apa");
    fetcher.offline = true;
    check(
        (await service.styleSample("apa")) === undefined,
        "sample cleared on remove",
    );
});

await test("adding an alias caches the auto-fetched parent's sample too", async () => {
    const sample = (v) =>
        JSON.stringify({
            citation: ["[1]"],
            bibliography: `<div class="csl-bib-body">${v}</div>`,
        });
    const fetcher = new StubFetcher({
        "style://nature-neuroscience": natureNeuro,
        "style://nature": nature,
        "locale://en-GB": enUS,
        "sample://dependent/nature-neuroscience": sample("alias"),
        "sample://nature": sample("parent"),
    });
    const service = new CslRenderService({
        fetcher,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
        styleSampleUrlTemplate: "sample://{path}",
    });
    await service.addStyle(await service.previewStyle("nature-neuroscience"));

    fetcher.offline = true;
    const aliasSample = await service.styleSample("nature-neuroscience");
    const parentSample = await service.styleSample("nature");
    check(
        aliasSample?.bibliographyHtml.includes("alias") === true,
        "alias sample cached offline",
    );
    check(
        parentSample?.bibliographyHtml.includes("parent") === true,
        "parent sample cached offline",
    );
});

await test("style id: query params stripped, style's own id preferred", async () => {
    check(
        slugFromStyleUri("https://www.zotero.org/styles/nature?source=1") ===
            "nature",
        "slugFromStyleUri strips query params",
    );
    check(
        slugFromStyleUri("https://www.zotero.org/styles/nature#frag") ===
            "nature",
        "slugFromStyleUri strips fragments",
    );

    const fetcher = new StubFetcher({
        "https://example.com/some/path/whatever": nature,
        "style://nature": nature,
    });
    const service = new CslRenderService({
        fetcher,
        store: new MemoryKVStore(),
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
        styleSampleUrlTemplate: "sample://{path}",
    });

    // URL input with tracking params: fetched from the given URL, but the
    // id comes from the style's own <info><id> declaration.
    const fromUrl = await service.previewStyle(
        "https://example.com/some/path/whatever?source=1",
    );
    check(fromUrl.id === "nature", "id derived from the style's declared id");

    // Plain id input with a stray query suffix.
    const fromId = await service.previewStyle("nature?source=1");
    check(fromId.id === "nature", "query stripped from plain id input");
});

await test("meta extraction: citation-format + hasBibliography (never inferred)", async () => {
    const apaMeta = extractStyleMeta(apa);
    check(apaMeta.citationFormat === "author-date", "apa citation-format");
    check(apaMeta.hasBibliography === true, "apa declares <bibliography>");

    const ieeeMeta = extractStyleMeta(ieee);
    check(ieeeMeta.citationFormat === "numeric", "ieee citation-format");

    const noteMeta = extractStyleMeta(NOTE_ONLY);
    check(noteMeta.citationFormat === "note", "note-only citation-format");
    check(
        noteMeta.hasBibliography === false,
        "note-only style: <bibliography> absence recorded, not guessed",
    );

    const aliasMeta = extractStyleMeta(natureNeuro);
    check(
        aliasMeta.hasBibliography === undefined,
        "dependent style: hasBibliography unknown (inherited from parent)",
    );
});

await test("ref-counted removal: aliases share an implicit parent", async () => {
    const { service } = makeService({
        "style://alias-one": makeAlias("alias-one", "nature"),
        "style://alias-two": makeAlias("alias-two", "nature"),
        "style://nature": nature,
        "locale://en-GB": enUS,
    });
    await service.addStyle(await service.previewStyle("alias-one"));
    await service.addStyle(await service.previewStyle("alias-two"));

    const styles = await service.listStyles();
    const parent = styles.find((s) => s.id === "nature");
    check(parent?.explicit === false, "auto-fetched parent is implicit");
    check(
        styles.find((s) => s.id === "alias-one")?.explicit === true,
        "directly added alias is explicit",
    );

    await service.removeStyle("alias-one");
    let ids = (await service.listStyles()).map((s) => s.id);
    check(ids.includes("nature"), "parent kept while another alias needs it");

    await service.removeStyle("alias-two");
    ids = (await service.listStyles()).map((s) => s.id);
    check(!ids.includes("nature"), "orphaned implicit parent pruned");
    check(ids.length === 0, "nothing left installed");
});

await test("ref-counted removal: explicitly installed parent survives", async () => {
    const { service } = makeService({
        "style://alias-one": makeAlias("alias-one", "nature"),
        "style://nature": nature,
        "locale://en-GB": enUS,
    });
    // User installs the parent directly, then an alias of it.
    await service.addStyle(await service.previewStyle("nature"));
    await service.addStyle(await service.previewStyle("alias-one"));

    await service.removeStyle("alias-one");
    const ids = (await service.listStyles()).map((s) => s.id);
    check(
        ids.includes("nature"),
        "explicit parent survives alias removal (no mis-delete)",
    );
});

await test("updateAllStyles: shared parent refetched once, checkedAt persisted", async () => {
    const routes = {
        "style://alias-one": makeAlias("alias-one", "nature"),
        "style://alias-two": makeAlias("alias-two", "nature"),
        "style://nature": nature,
        "locale://en-GB": enUS,
    };
    const { service, fetcher } = makeService(routes);
    await service.addStyle(await service.previewStyle("alias-one"));
    await service.addStyle(await service.previewStyle("alias-two"));

    const before = fetcher.calls.filter((u) => u === "style://nature").length;
    const report = await service.updateAllStyles();
    const after = fetcher.calls.filter((u) => u === "style://nature").length;
    check(after - before === 1, "shared parent refetched exactly once");
    check(
        report.unchanged.filter((id) => id === "nature").length === 1,
        "shared parent reported once",
    );
    check(typeof report.checkedAt === "number", "checkedAt returned");

    const status = await service.getUpdateStatus();
    check(
        status.stylesCheckedAt === report.checkedAt,
        "styles checkedAt persisted",
    );
    check(status.localesCheckedAt === undefined, "locales never checked yet");

    const locReport = await service.updateAllLocales();
    check(
        locReport.unchanged.includes("en-GB"),
        "updateAllLocales walks cached locales",
    );
    check(
        locReport.failed.some((f) => f.id === "en-US"),
        "bundled en-US included in update-all (fails here: no route)",
    );
    check(
        (await service.getUpdateStatus()).localesCheckedAt ===
            locReport.checkedAt,
        "locales checkedAt persisted",
    );
});

await test("bundled en-US is updatable; overlay survives a restart", async () => {
    // A recognisably different repo copy: rewrite the "no date" term.
    const modified = enUS.split("n.d.").join("X.Y.");
    const store = new MemoryKVStore();
    const service = new CslRenderService({
        fetcher: new StubFetcher({ "locale://en-US": modified }),
        store,
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
    });

    const { updated } = await service.updateLocale("en-US");
    check(updated === true, "overlay differs from the bundled asset");

    const en = (await service.listLocales()).find((l) => l.tag === "en-US");
    check(en?.source === "builtin", "en-US stays listed as builtin");
    check(typeof en?.fetchedAt === "number", "overlay provenance surfaced");

    // A fresh service over the same store (= plugin restart) must serve
    // the overlay, not the bundled asset.
    const restarted = new CslRenderService({
        fetcher: new StubFetcher(),
        store,
        styleUrlTemplate: "style://{id}",
        localeUrlTemplate: "locale://{lang}",
    });
    const [entry] = await restarted.renderBibliography(
        [ITEMS.vaswaniNoDate],
        { styleXml: apa, format: "text" },
    );
    check(entry.includes("(X.Y.)"), "updated en-US terms used after restart");
});

/* ---------------------------------------------------------------- */

await rm(BUNDLE, { force: true });

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
