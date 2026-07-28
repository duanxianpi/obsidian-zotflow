/**
 * Real CSL style/locale fixtures.
 *
 * Downloaded once into tests/.csl-fixtures/ (gitignored) and reused, so repeat
 * runs work offline. Only this helper touches the network — the code under
 * test is always driven through an in-memory `StubFetcher`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", ".csl-fixtures");

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
} as const;

export interface CslFixtures {
    apa: string;
    ieee: string;
    nature: string;
    natureNeuro: string;
    deDE: string;
    enUS: string;
}

/**
 * Download anything not already cached, then read all six fixtures.
 *
 * Uses the real `fetch`, so call it from `beforeAll` before any test installs
 * a fetch fake.
 */
export async function loadCslFixtures(): Promise<CslFixtures> {
    await mkdir(FIXTURE_DIR, { recursive: true });

    for (const [name, url] of Object.entries(REMOTE_FIXTURES)) {
        const path = join(FIXTURE_DIR, name);
        if (existsSync(path)) continue;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Cannot download CSL fixture ${name} (HTTP ${res.status}). ` +
                    `Run once with network access; fixtures are cached afterwards.`,
            );
        }
        await writeFile(path, await res.text(), "utf8");
    }

    const read = (name: string) => readFile(join(FIXTURE_DIR, name), "utf8");
    const [apa, ieee, nature, natureNeuro, deDE, enUS] = await Promise.all([
        read("apa.csl"),
        read("ieee.csl"),
        read("nature.csl"),
        read("nature-neuroscience.csl"),
        read("locales-de-DE.xml"),
        read("locales-en-US.xml"),
    ]);

    return { apa, ieee, nature, natureNeuro, deDE, enUS };
}
