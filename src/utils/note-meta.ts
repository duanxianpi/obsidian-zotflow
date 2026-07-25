/**
 * The `<!-- ZF_NOTE_META … -->` marker — single source of truth.
 *
 * Zotero note HTML is wrapped in `<div data-schema-version data-citation-items>`.
 * `html2md` cannot represent that wrapper in Markdown, so it serializes the
 * div's attributes into a leading HTML comment and `md2html` reconstructs the
 * wrapper from it. The line is machine-owned: the note editor hides it from
 * the user and re-injects it on save, and the CM6 region parser keeps it
 * outside the editable range.
 *
 * Four call sites used to carry their own copy of this regex and had already
 * drifted apart — the converter accepted two legacy spellings that the two UI
 * matchers did not, so a legacy-format note rendered its meta line as visible,
 * editable body text. Everything now goes through this module.
 */

/** Marker keyword inside the comment. */
export const NOTE_META_PREFIX = "ZF_NOTE_META";

/**
 * Every accepted spelling of the marker. Group 1/2/3 hold the attributes
 * (exactly one is defined per match).
 *
 * Attributes are always serialized on a single line, so the lazy bodies
 * exclude newlines — this also stops a match from running away to some
 * unrelated `-->` further down the note.
 */
const NOTE_META_BODY =
    `(?:<!-- ${NOTE_META_PREFIX} ([^\\n]*?) -->` +
    `|%% ${NOTE_META_PREFIX} ([^\\n]*?) %%` +
    `|<!-- zotflow-note-meta ([^\\n]*?) -->)`;

/** Anchored at the start of the document, optionally eating the line break. */
const LEADING_RE = new RegExp(`^${NOTE_META_BODY}\\n?`);

export interface NoteMetaMatch {
    /** The complete matched text, including any trailing newline. */
    raw: string;
    /** Serialized wrapper-div attributes. */
    attrs: string;
}

/** Match the meta marker at the very start of a markdown document. */
export function matchLeadingNoteMeta(md: string): NoteMetaMatch | null {
    const m = LEADING_RE.exec(md);
    if (!m) return null;
    return { raw: m[0], attrs: (m[1] ?? m[2] ?? m[3] ?? "").trim() };
}

/** Remove the leading meta marker, returning the remaining markdown. */
export function stripLeadingNoteMeta(md: string): string {
    const match = matchLeadingNoteMeta(md);
    return match ? md.slice(match.raw.length) : md;
}

/** Render the marker line that `md2html` reads back. */
export function formatNoteMeta(attrs: string): string {
    return `<!-- ${NOTE_META_PREFIX} ${attrs} -->`;
}

/**
 * A fresh global regex for scanning a document for the marker.
 *
 * Returns a new instance per call because callers drive `lastIndex`
 * themselves; sharing one would leak position state between scans.
 */
export function createNoteMetaScanner(): RegExp {
    return new RegExp(NOTE_META_BODY, "g");
}
