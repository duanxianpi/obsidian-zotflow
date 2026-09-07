import { describe, expect, test } from "vitest";

import {
    SearchService,
    type SearchableRecord,
} from "worker/services/search";

const search = new SearchService();

function record(
    id: string,
    overrides: Partial<SearchableRecord> = {},
): SearchableRecord {
    return {
        id,
        name: `Item ${id}`,
        ...overrides,
    };
}

function match(raw: string, records: SearchableRecord[]): SearchableRecord[] {
    return search.matchAndRank(search.parse(raw), records);
}

describe("SearchService diacritic folding", () => {
    test("matches plain and accented free text in both directions", () => {
        const accented = record("accented", { creators: ["Lämmermann"] });
        const plain = record("plain", { creators: ["Lammermann"] });

        expect(match("Lammermann", [accented])).toEqual([accented]);
        expect(match("Lämmermann", [plain])).toEqual([plain]);
    });

    test("normalizes decomposed Unicode before folding", () => {
        const decomposed = record("decomposed", {
            creators: ["La\u0308mmermann"],
        });
        const precomposed = record("precomposed", {
            creators: ["Lämmermann"],
        });

        expect(match("Lammermann", [decomposed])).toEqual([decomposed]);
        expect(match("La\u0308mmermann", [precomposed])).toEqual([
            precomposed,
        ]);
    });

    test.each<[string, Partial<SearchableRecord>]>([
        ["creator:lammermann", { creators: ["Lämmermann"] }],
        ["tag:cafe", { tags: ["Café"] }],
        ["collection:etudes", { collections: ["Études"] }],
        ["library:universite", { libraryName: "Université" }],
    ])("folds structured filter %s", (query, overrides) => {
        const accented = record("accented", overrides);

        expect(match(query, [accented])).toEqual([accented]);
    });

    test("applies folding before evaluating a negated filter", () => {
        const accented = record("accented", { creators: ["Lämmermann"] });
        const other = record("other", { creators: ["Nakamoto"] });

        expect(match("-creator:lammermann", [accented, other])).toEqual([
            other,
        ]);
    });

    test("leaves non-Latin structured filters working", () => {
        const cjk = record("cjk", { tags: ["中文"] });

        expect(match("tag:中文", [cjk])).toEqual([cjk]);
    });
});
