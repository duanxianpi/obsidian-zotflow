/**
 * Shared search-query parser and highlight helpers.
 *
 * This module is intentionally dependency-free (no uFuzzy, no Dexie, no
 * Obsidian) so it can be imported from BOTH the main thread (for highlight
 * token extraction) and the Web Worker (for matching). The actual fuzzy
 * engine lives in `worker/services/search.ts` and stays worker-only.
 *
 * Grammar (implicit AND between every term):
 *   - `field:value`            → structured filter
 *   - `field:"two words"`      → quoted filter value
 *   - `-field:value`           → negated filter
 *   - `word` / `"two words"`   → free text (fuzzy-matched)
 *
 * Only whitelisted fields are treated as filters. An unrecognized `field:` is
 * folded back into the free-text portion with its colon intact, so a term is
 * never silently reinterpreted as something else.
 *
 * Two inputs are deliberately discarded rather than preserved:
 *
 *   - **A stray `-` is dropped.** It is only meaningful in front of a
 *     recognized `field:`; negated free text does not exist, because
 *     `SearchService` honours `negate` only while evaluating filters and runs a
 *     single positive fuzzy pass over `free`. So `-word` searches for `word`,
 *     and a literal leading hyphen is not searchable. The operator hint list
 *     says as much ("prefix a filter to exclude").
 *   - **An empty quoted value drops the whole term.** `tag:""` yields no filter
 *     rather than one that can never match, and a bare `""` yields no token —
 *     an empty free-text token would widen every highlight regex.
 */

/** A single structured filter such as `collection:AI` or `-tag:draft`. */
export interface SearchFilter {
    field: SearchFilterField;
    value: string; // already lower-cased
    negate: boolean;
}

/** Whitelisted filter fields (canonical names). */
export type SearchFilterField =
    | "collection"
    | "tag"
    | "type"
    | "creator"
    | "library";

/** Result of parsing a raw query string. */
export interface ParsedQuery {
    /** Free-text portion, joined with spaces (fed to the fuzzy engine). */
    free: string;
    /** Individual free-text tokens (used for highlighting). */
    freeTokens: string[];
    /** Structured filters. */
    filters: SearchFilter[];
}

/** Maps user-typed field aliases → canonical filter field. */
const FIELD_ALIASES: Record<string, SearchFilterField> = {
    collection: "collection",
    coll: "collection",
    tag: "tag",
    type: "type",
    itemtype: "type",
    creator: "creator",
    author: "creator",
    library: "library",
    lib: "library",
};

/** Metadata describing a single supported search operator. */
export interface SearchOperator {
    field: SearchFilterField;
    /** Canonical token, e.g. `collection:`. */
    token: string;
    /** Display label (the field name without the colon). */
    label: string;
    /** All typed prefixes that resolve to this operator. */
    aliases: string[];
    /** Short human-readable description shown in the hint list. */
    description: string;
}

/** The operators surfaced in the reminder hint list, in display order. */
export const SEARCH_OPERATORS: SearchOperator[] = [
    {
        field: "library",
        token: "library:",
        label: "library",
        aliases: ["library", "lib"],
        description: "items in a library",
    },
    {
        field: "collection",
        token: "collection:",
        label: "collection",
        aliases: ["collection", "coll"],
        description: "items in a collection",
    },
    {
        field: "tag",
        token: "tag:",
        label: "tag",
        aliases: ["tag"],
        description: "items with a tag",
    },
    {
        field: "creator",
        token: "creator:",
        label: "creator",
        aliases: ["creator", "author"],
        description: "items by an author / creator",
    },
    {
        field: "type",
        token: "type:",
        label: "type",
        aliases: ["type", "itemtype"],
        description: "items of an item type",
    },
];

/**
 * Tokenizer: matches an optional leading `-`, an optional `field:` prefix,
 * and then either a "quoted value" or a run of non-space characters.
 */
const TOKEN_RE = /(-?)(?:([A-Za-z]+):)?(?:"([^"]*)"|(\S+))/g;

/** Parse a raw search string into filters + free text. */
export function parseSearchQuery(raw: string): ParsedQuery {
    const filters: SearchFilter[] = [];
    const freeTokens: string[] = [];

    if (raw) {
        TOKEN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOKEN_RE.exec(raw)) !== null) {
            // Guard against zero-width matches causing an infinite loop.
            if (m[0] === "") {
                TOKEN_RE.lastIndex++;
                continue;
            }

            const negate = m[1] === "-";
            const rawField = m[2];
            const value = m[3] !== undefined ? m[3] : (m[4] ?? "");
            if (value === "") continue;

            const field = rawField
                ? FIELD_ALIASES[rawField.toLowerCase()]
                : undefined;

            if (field) {
                filters.push({ field, value: value.toLowerCase(), negate });
            } else if (rawField) {
                // Unknown field → keep the literal text as free text.
                freeTokens.push(`${rawField}:${value}`);
            } else {
                freeTokens.push(value);
            }
        }
    }

    return {
        free: freeTokens.join(" "),
        freeTokens,
        filters,
    };
}

/** True when the query has neither free text nor filters. */
export function isEmptyQuery(query: ParsedQuery): boolean {
    return query.free === "" && query.filters.length === 0;
}

/** A single segment produced by {@link splitHighlight}. */
export interface HighlightSegment {
    text: string;
    match: boolean;
}

/**
 * Split `text` into highlighted / non-highlighted segments based on
 * case-insensitive occurrences of any free-text token (tokens are further
 * split on whitespace so quoted multi-word tokens still highlight per word).
 *
 * This is a best-effort visual aid — it is independent of the fuzzy matcher,
 * so a fuzzy-matched result with no literal substring simply renders without
 * highlights.
 */
export function splitHighlight(
    text: string,
    freeTokens: string[],
): HighlightSegment[] {
    if (!text) return [{ text, match: false }];

    const words = freeTokens
        .flatMap((t) => t.split(/\s+/))
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

    if (words.length === 0) return [{ text, match: false }];

    const escaped = words
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .sort((a, b) => b.length - a.length); // longer tokens first
    const regex = new RegExp(`(${escaped.join("|")})`, "gi");

    const segments: HighlightSegment[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        if (m.index > lastIndex) {
            segments.push({
                text: text.slice(lastIndex, m.index),
                match: false,
            });
        }
        segments.push({ text: m[0], match: true });
        lastIndex = m.index + m[0].length;
        if (m[0] === "") regex.lastIndex++; // safety
    }
    if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), match: false });
    }
    return segments;
}
/* ================================================================ */
/*  Operator reminder helpers (no value autocomplete)              */
/* ================================================================ */

/** A single row in the operator reminder list. */
export interface SearchHintRow {
    /** Token shown in the hint, e.g. `collection:` or `-`. */
    token: string;
    /** Short description of what the operator does. */
    description: string;
    /** Operator token to insert when the row is chosen; omit for info-only rows. */
    insertToken?: string;
}

/** The negation reminder row, always shown last. */
const NEGATION_HINT: SearchHintRow = {
    token: "-",
    description: "prefix a filter to exclude, e.g. -tag:draft",
};

/** The final whitespace-delimited token in `input` (what the user is typing). */
export function getActiveToken(input: string): { text: string; start: number } {
    const m = /(\S*)$/.exec(input);
    const text = m ? m[1]! : "";
    return { text, start: input.length - text.length };
}

/** Replace the active (last) token in `input` with `replacement`. */
export function replaceActiveToken(input: string, replacement: string): string {
    const { start } = getActiveToken(input);
    return input.slice(0, start) + replacement;
}

/** The full operator reminder list (all operators + negation note). */
export function getOperatorHints(): SearchHintRow[] {
    return [
        ...SEARCH_OPERATORS.map((op) => ({
            token: op.token,
            description: op.description,
            insertToken: op.token,
        })),
        NEGATION_HINT,
    ];
}

/**
 * Operator reminder rows relevant to the current input: the full list when the
 * active token is empty, a prefix-filtered subset while typing an operator
 * name, or `[]` once a `field:` has been entered (nothing left to remind).
 */
export function getOperatorHintsForInput(input: string): SearchHintRow[] {
    const { text } = getActiveToken(input);
    const bare = text.startsWith("-") ? text.slice(1) : text;
    if (bare.includes(":")) return [];
    if (bare === "") return getOperatorHints();

    const lower = bare.toLowerCase();
    return SEARCH_OPERATORS.filter((op) =>
        op.aliases.some((a) => a.startsWith(lower)),
    ).map((op) => ({
        token: op.token,
        description: op.description,
        insertToken: op.token,
    }));
}

/** Insert an operator token at the active token, preserving any `-` negation. */
export function applyOperatorToken(input: string, token: string): string {
    const { text } = getActiveToken(input);
    const negate = text.startsWith("-") ? "-" : "";
    return replaceActiveToken(input, `${negate}${token}`);
}

/** Discriminated analysis of the active token for autocomplete. */
export type InputAnalysis =
    | { mode: "operator"; hints: SearchHintRow[] }
    | {
          mode: "value";
          field: SearchFilterField;
          partial: string;
          negate: boolean;
      }
    | { mode: "none" };

/**
 * Analyse the active token: `field:partial` → value completion, a bare
 * (partial) word → operator reminder, anything else → nothing.
 */
export function analyzeInput(input: string): InputAnalysis {
    const { text } = getActiveToken(input);
    const negate = text.startsWith("-");
    const bare = negate ? text.slice(1) : text;

    const colon = bare.indexOf(":");
    if (colon >= 0) {
        const field = FIELD_ALIASES[bare.slice(0, colon).toLowerCase()];
        if (field) {
            let partial = bare.slice(colon + 1);
            if (partial.startsWith('"')) partial = partial.slice(1);
            return { mode: "value", field, partial, negate };
        }
        return { mode: "none" };
    }

    const hints = getOperatorHintsForInput(input);
    return hints.length > 0 ? { mode: "operator", hints } : { mode: "none" };
}

/** Insert a completed `field:value` at the active token, preserving negation. */
export function applyValueCompletion(
    input: string,
    field: SearchFilterField,
    value: string,
): string {
    const { text } = getActiveToken(input);
    const negate = text.startsWith("-") ? "-" : "";
    const op = SEARCH_OPERATORS.find((o) => o.field === field);
    const token = op ? op.token : `${field}:`;
    const formatted = /\s/.test(value) ? `"${value}"` : value;
    return `${replaceActiveToken(input, `${negate}${token}${formatted}`)} `;
}
