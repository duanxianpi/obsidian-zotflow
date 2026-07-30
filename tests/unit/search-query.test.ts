/**
 * Search-query parser and autocomplete helpers.
 *
 * `SearchService` reports ~96% coverage without a suite of its own — that is
 * `db-helper`'s tests reaching *through* it — while the parser it delegates to
 * had 10% of its functions ever called. A parser that mis-reads a query does
 * not throw; it silently returns the wrong set, and the user sees an empty tree
 * and blames sync. So these tests are about the grammar's edges: quoting,
 * aliases, negation, and what happens to input the grammar does not accept.
 *
 * Pure module — no fakes, no DB, no Obsidian.
 *
 * Mutation round: 16 of 18 anchors killed. The two survivors are equivalent
 * mutants — defensive code that cannot change an observable result — so no test
 * chases them:
 *
 *  - Deleting `TOKEN_RE.lastIndex = 0` changes nothing, because `exec` resets
 *    `lastIndex` to 0 itself once it returns null, and the parse loop has no
 *    `break` — it always runs to null. The reset only starts earning its keep if
 *    someone adds an early exit.
 *  - Deleting the `bare.includes(":")` early return changes nothing, because the
 *    alias filter below it already yields `[]`: no alias contains a colon, so
 *    `alias.startsWith("tag:")` is false for every operator. It is a fast path,
 *    not behaviour.
 *
 * The zero-width-match guard in `parseSearchQuery` (`if (m[0] === "")`) is
 * unreachable for the same class of reason — both value branches of TOKEN_RE
 * consume at least one character — which is why coverage stops at 98%.
 */
import { describe, expect, it } from "vitest";

import {
    analyzeInput,
    applyOperatorToken,
    applyValueCompletion,
    getActiveToken,
    getOperatorHints,
    getOperatorHintsForInput,
    isEmptyQuery,
    parseSearchQuery,
    replaceActiveToken,
    SEARCH_OPERATORS,
    splitHighlight,
} from "utils/search-query";

/* ================================================================ */
/*  parseSearchQuery — filters                                      */
/* ================================================================ */

describe("parseSearchQuery: filters", () => {
    it("reads a bare filter", () => {
        expect(parseSearchQuery("tag:draft")).toEqual({
            free: "",
            freeTokens: [],
            filters: [{ field: "tag", value: "draft", negate: false }],
        });
    });

    it("reads a negated filter", () => {
        expect(parseSearchQuery("-tag:draft").filters).toEqual([
            { field: "tag", value: "draft", negate: true },
        ]);
    });

    it("reads a quoted multi-word value", () => {
        expect(
            parseSearchQuery('collection:"Machine Learning"').filters,
        ).toEqual([
            { field: "collection", value: "machine learning", negate: false },
        ]);
    });

    it.each([
        ["collection:x", "collection"],
        ["coll:x", "collection"],
        ["tag:x", "tag"],
        ["type:x", "type"],
        ["itemtype:x", "type"],
        ["creator:x", "creator"],
        ["author:x", "creator"],
        ["library:x", "library"],
        ["lib:x", "library"],
    ])("resolves the alias in %s to %s", (raw, field) => {
        expect(parseSearchQuery(raw).filters[0]?.field).toBe(field);
    });

    it("matches the field alias case-insensitively and lower-cases the value", () => {
        expect(parseSearchQuery("TAG:Draft").filters).toEqual([
            { field: "tag", value: "draft", negate: false },
        ]);
    });

    it("keeps every filter when several are stacked", () => {
        expect(parseSearchQuery("tag:ai -type:book lib:7").filters).toEqual([
            { field: "tag", value: "ai", negate: false },
            { field: "type", value: "book", negate: true },
            { field: "library", value: "7", negate: false },
        ]);
    });

    it("keeps repeated filters on one field as separate entries", () => {
        // How to combine them is the engine's decision; the parser must not
        // collapse them and silently drop one.
        expect(parseSearchQuery("tag:ai tag:ml").filters).toHaveLength(2);
    });
});

/* ================================================================ */
/*  parseSearchQuery — free text                                    */
/* ================================================================ */

describe("parseSearchQuery: free text", () => {
    it("splits on whitespace and preserves case", () => {
        // Case survives because the fuzzy engine does its own folding.
        expect(parseSearchQuery("Hello World")).toEqual({
            free: "Hello World",
            freeTokens: ["Hello", "World"],
            filters: [],
        });
    });

    it("keeps a quoted phrase as one token", () => {
        const q = parseSearchQuery('"deep learning" neural');
        expect(q.freeTokens).toEqual(["deep learning", "neural"]);
        // `free` is what reaches the fuzzy engine — quoting is not part of it.
        expect(q.free).toBe("deep learning neural");
    });

    it("collapses runs of whitespace", () => {
        expect(parseSearchQuery("  a \t b  ").freeTokens).toEqual(["a", "b"]);
    });

    it("mixes filters and free text without either swallowing the other", () => {
        const q = parseSearchQuery('tag:ai neural -type:book "deep learning"');
        expect(q.filters).toEqual([
            { field: "tag", value: "ai", negate: false },
            { field: "type", value: "book", negate: true },
        ]);
        expect(q.freeTokens).toEqual(["neural", "deep learning"]);
    });
});

/* ================================================================ */
/*  parseSearchQuery — input the grammar does not accept            */
/* ================================================================ */

describe("parseSearchQuery: input the grammar does not accept", () => {
    // Unrecognized `field:` syntax folds back into free text so a term is never
    // reinterpreted as something else. Two inputs are exceptions and are
    // dropped on purpose; both are asserted below.

    it("folds an unknown field back into free text, colon included", () => {
        expect(parseSearchQuery("publisher:acm")).toEqual({
            free: "publisher:acm",
            freeTokens: ["publisher:acm"],
            filters: [],
        });
    });

    it("treats a field name containing digits as free text", () => {
        // `[A-Za-z]+` cannot match `abc1`, so the whole run becomes one token.
        expect(parseSearchQuery("abc1:x").freeTokens).toEqual(["abc1:x"]);
    });

    it("treats a trailing colon with no value as free text", () => {
        // The value branch needs at least one non-space character, so the field
        // prefix is backtracked and `tag:` survives whole.
        expect(parseSearchQuery("tag:")).toEqual({
            free: "tag:",
            freeTokens: ["tag:"],
            filters: [],
        });
    });

    it("drops a negation it cannot attach to a filter", () => {
        // `-` is only meaningful before a recognized `field:`. There is no
        // negated free text — `SearchService` honours `negate` only for filters
        // and runs one positive fuzzy pass over `free` — so the hyphen is
        // dropped and `-word` searches for `word`. Consequence worth knowing:
        // a literal leading hyphen cannot be searched for.
        expect(parseSearchQuery("-word").freeTokens).toEqual(["word"]);
        expect(parseSearchQuery("-publisher:acm").freeTokens).toEqual([
            "publisher:acm",
        ]);
    });

    it("drops an empty quoted value entirely", () => {
        // Better than the alternatives: `tag:""` would otherwise become a
        // filter that can never match, and an empty free-text token would widen
        // every highlight regex to match at every position.
        expect(parseSearchQuery('tag:""')).toEqual({
            free: "",
            freeTokens: [],
            filters: [],
        });
        expect(parseSearchQuery('""').freeTokens).toEqual([]);
    });

    it("returns an empty result for empty or blank input", () => {
        expect(parseSearchQuery("")).toEqual({
            free: "",
            freeTokens: [],
            filters: [],
        });
        expect(parseSearchQuery("   ").freeTokens).toEqual([]);
    });

    it("is not left in a bad state by the previous call", () => {
        // TOKEN_RE is a module-level /g regex; `lastIndex` has to be reset or
        // the second parse starts mid-string.
        parseSearchQuery("tag:ai neural network");
        expect(parseSearchQuery("tag:ai").filters).toEqual([
            { field: "tag", value: "ai", negate: false },
        ]);
    });
});

describe("isEmptyQuery", () => {
    it.each([
        ["", true],
        ["   ", true],
        ['tag:""', true],
        ["word", false],
        ["tag:ai", false],
        ["-tag:ai", false],
    ])("%s -> %s", (raw, expected) => {
        expect(isEmptyQuery(parseSearchQuery(raw))).toBe(expected);
    });
});

/* ================================================================ */
/*  splitHighlight                                                  */
/* ================================================================ */

describe("splitHighlight", () => {
    /** Matched runs wrapped in [], for readable assertions. */
    const render = (text: string, tokens: string[]) =>
        splitHighlight(text, tokens)
            .map((s) => (s.match ? `[${s.text}]` : s.text))
            .join("");

    it("marks a case-insensitive occurrence", () => {
        expect(render("Hello World", ["world"])).toBe("Hello [World]");
    });

    it("marks every occurrence", () => {
        expect(render("aXbXc", ["x"])).toBe("a[X]b[X]c");
    });

    it("marks a match at the start and at the end", () => {
        expect(render("abc", ["abc"])).toBe("[abc]");
        expect(render("ab", ["a"])).toBe("[a]b");
        expect(render("ab", ["b"])).toBe("a[b]");
    });

    it("prefers the longest token when tokens overlap", () => {
        // Without the longest-first sort, "foo" wins and "bar" is left plain.
        expect(render("foobar", ["foo", "foobar"])).toBe("[foobar]");
    });

    it("treats regex metacharacters in a token literally", () => {
        // An unescaped "." would match the "a" instead.
        expect(render("a.c", ["."])).toBe("a[.]c");
        expect(render("a+b", ["+"])).toBe("a[+]b");
        expect(render("f(x)", ["(x)"])).toBe("f[(x)]");
    });

    it("highlights a quoted phrase word by word", () => {
        // Tokens are re-split on whitespace so the words still light up even
        // when they are not adjacent in a given result.
        expect(render("deep learning", ["deep learning"])).toBe(
            "[deep] [learning]",
        );
    });

    it("returns the text unmarked when nothing matches", () => {
        expect(splitHighlight("abc", ["zzz"])).toEqual([
            { text: "abc", match: false },
        ]);
    });

    it.each([
        ["no tokens", [] as string[]],
        ["blank tokens", ["", "   "]],
    ])("returns a single unmatched segment for %s", (_label, tokens) => {
        expect(splitHighlight("abc", tokens)).toEqual([
            { text: "abc", match: false },
        ]);
    });

    it("handles empty text", () => {
        expect(splitHighlight("", ["a"])).toEqual([{ text: "", match: false }]);
    });

    it("feeds straight from parseSearchQuery", () => {
        const { freeTokens } = parseSearchQuery('tag:ai "deep learning"');
        // Only free text highlights — the filter value must not.
        expect(render("ai and deep learning", freeTokens)).toBe(
            "ai and [deep] [learning]",
        );
    });
});

/* ================================================================ */
/*  Active-token helpers                                            */
/* ================================================================ */

describe("getActiveToken", () => {
    it.each([
        ["", "", 0],
        ["abc", "abc", 0],
        ["a b", "b", 2],
        ["tag:dr", "tag:dr", 0],
        ["foo -tag:dr", "-tag:dr", 4],
    ])("%s -> %s at %s", (input, text, start) => {
        expect(getActiveToken(input)).toEqual({ text, start });
    });

    it("is empty, and positioned at the end, after a trailing space", () => {
        // This is what makes a fresh operator hint list appear after a space.
        expect(getActiveToken("a ")).toEqual({ text: "", start: 2 });
    });
});

describe("replaceActiveToken", () => {
    it.each([
        ["", "X", "X"],
        ["abc", "X", "X"],
        ["a b", "X", "a X"],
        ["a ", "X", "a X"],
        ["tag:ai neu", "X", "tag:ai X"],
    ])("(%s, %s) -> %s", (input, replacement, expected) => {
        expect(replaceActiveToken(input, replacement)).toBe(expected);
    });
});

/* ================================================================ */
/*  Operator hints                                                  */
/* ================================================================ */

describe("getOperatorHints", () => {
    it("lists every operator, then the negation note", () => {
        expect(getOperatorHints().map((r) => r.token)).toEqual([
            ...SEARCH_OPERATORS.map((o) => o.token),
            "-",
        ]);
    });

    it("makes only the negation row info-only", () => {
        const rows = getOperatorHints();
        // No insertToken → the suggest UI must not try to insert it.
        expect(rows.at(-1)!.token).toBe("-");
        expect(rows.at(-1)!.insertToken).toBeUndefined();
        expect(rows.slice(0, -1).every((r) => !!r.insertToken)).toBe(true);
    });
});

describe("getOperatorHintsForInput", () => {
    const tokens = (input: string) =>
        getOperatorHintsForInput(input).map((r) => r.token);

    it("offers everything when the active token is empty", () => {
        const all = getOperatorHints().map((r) => r.token);
        expect(tokens("")).toEqual(all);
        expect(tokens("tag:ai ")).toEqual(all);
    });

    it("filters by prefix while an operator name is being typed", () => {
        expect(tokens("ta")).toEqual(["tag:"]);
        expect(tokens("l")).toEqual(["library:"]);
    });

    it("matches any alias, not just the canonical name", () => {
        expect(tokens("au")).toEqual(["creator:"]);
        expect(tokens("item")).toEqual(["type:"]);
    });

    it("keeps display order when a prefix hits several operators", () => {
        // "c" matches collection/coll and creator.
        expect(tokens("c")).toEqual(["collection:", "creator:"]);
    });

    it("omits the negation note once filtering has started", () => {
        expect(tokens("ta")).not.toContain("-");
    });

    it("looks past a leading hyphen", () => {
        expect(tokens("-ta")).toEqual(["tag:"]);
    });

    it("goes quiet once a field has been committed", () => {
        expect(tokens("tag:")).toEqual([]);
        expect(tokens("tag:dra")).toEqual([]);
        expect(tokens("-tag:dra")).toEqual([]);
    });

    it("offers nothing for a prefix no operator starts with", () => {
        expect(tokens("zzz")).toEqual([]);
    });

    it("is case-insensitive", () => {
        expect(tokens("TA")).toEqual(["tag:"]);
    });
});

describe("applyOperatorToken", () => {
    it.each([
        ["", "tag:", "tag:"],
        ["ta", "tag:", "tag:"],
        ["foo ta", "tag:", "foo tag:"],
        ["foo ", "tag:", "foo tag:"],
    ])("(%s, %s) -> %s", (input, token, expected) => {
        expect(applyOperatorToken(input, token)).toBe(expected);
    });

    it.each([
        ["-", "tag:", "-tag:"],
        ["-ta", "tag:", "-tag:"],
        ["foo -ta", "tag:", "foo -tag:"],
    ])("keeps the negation: (%s, %s) -> %s", (input, token, expected) => {
        expect(applyOperatorToken(input, token)).toBe(expected);
    });
});

/* ================================================================ */
/*  analyzeInput                                                    */
/* ================================================================ */

describe("analyzeInput", () => {
    it("switches to value completion once a known field is typed", () => {
        expect(analyzeInput("tag:dr")).toEqual({
            mode: "value",
            field: "tag",
            partial: "dr",
            negate: false,
        });
    });

    it("reports the negation alongside the field", () => {
        expect(analyzeInput("-tag:dr")).toMatchObject({
            mode: "value",
            field: "tag",
            negate: true,
        });
    });

    it("resolves the field through its alias", () => {
        expect(analyzeInput("author:kn")).toMatchObject({
            mode: "value",
            field: "creator",
            partial: "kn",
        });
    });

    it("reports an empty partial right after the colon", () => {
        expect(analyzeInput("tag:")).toMatchObject({
            mode: "value",
            field: "tag",
            partial: "",
        });
    });

    it("strips an opening quote from the partial", () => {
        expect(analyzeInput('tag:"dr')).toMatchObject({
            mode: "value",
            partial: "dr",
        });
    });

    it("gives up on a quoted value once it contains a space", () => {
        // A real limitation: the active token is the last whitespace-delimited
        // run, so `collection:"Machine Le` is analysed as the bare word `Le`
        // and value completion stops working mid-phrase.
        expect(analyzeInput('collection:"Machine Le')).toEqual({
            mode: "none",
        });
    });

    it("offers operator hints for a bare word", () => {
        const result = analyzeInput("ta");
        expect(result.mode).toBe("operator");
        expect(
            result.mode === "operator" && result.hints.map((h) => h.token),
        ).toEqual(["tag:"]);
    });

    it("offers the full hint list for empty input", () => {
        const result = analyzeInput("");
        expect(result.mode).toBe("operator");
        expect(result.mode === "operator" && result.hints).toHaveLength(
            SEARCH_OPERATORS.length + 1,
        );
    });

    it("stays silent on an unknown field", () => {
        expect(analyzeInput("publisher:ac")).toEqual({ mode: "none" });
    });

    it("stays silent on a word matching no operator", () => {
        expect(analyzeInput("zzz")).toEqual({ mode: "none" });
    });
});

/* ================================================================ */
/*  applyValueCompletion                                            */
/* ================================================================ */

describe("applyValueCompletion", () => {
    it("replaces the active token and leaves a trailing space", () => {
        // The space is what lets the next hint list open immediately.
        expect(applyValueCompletion("tag:dr", "tag", "draft")).toBe(
            "tag:draft ",
        );
    });

    it("leaves earlier tokens alone", () => {
        expect(applyValueCompletion("neural tag:dr", "tag", "draft")).toBe(
            "neural tag:draft ",
        );
    });

    it("keeps the negation", () => {
        expect(applyValueCompletion("-tag:dr", "tag", "draft")).toBe(
            "-tag:draft ",
        );
    });

    it("quotes a value containing whitespace", () => {
        expect(
            applyValueCompletion("coll:mac", "collection", "Machine Learning"),
        ).toBe('collection:"Machine Learning" ');
    });

    it("normalises a typed alias to the canonical token", () => {
        // The user typed `au`; the committed query says `creator:`.
        expect(applyValueCompletion("au", "creator", "knuth")).toBe(
            "creator:knuth ",
        );
    });

    it("preserves the value's case", () => {
        // Filter values are lower-cased at parse time, not while typing.
        expect(applyValueCompletion("tag:D", "tag", "Draft")).toBe(
            "tag:Draft ",
        );
    });

    it("round-trips into a filter the parser understands", () => {
        // The whole point of the completion: what it writes must parse back.
        const committed = applyValueCompletion(
            "-coll:mac",
            "collection",
            "Machine Learning",
        );
        expect(parseSearchQuery(committed).filters).toEqual([
            { field: "collection", value: "machine learning", negate: true },
        ]);
    });
});
