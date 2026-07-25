import { createNoteMetaScanner } from "utils/note-meta";

import type { Text } from "@codemirror/state";

/* ================================================================ */
/*  Marker Registry                                                 */
/* ================================================================ */

interface MarkerType {
    begPrefix: string;
    endPrefix: string;
    type: string;
}

const MARKER_REGISTRY: MarkerType[] = [
    { begPrefix: "ZF_NOTE_BEG_", endPrefix: "ZF_NOTE_END_", type: "NOTE" },
    { begPrefix: "ZF_ANNO_BEG_", endPrefix: "ZF_ANNO_END_", type: "ANNO" },
    // Persist regions: user-owned local-only blocks. Editable like the
    // others, but NEVER synced back to Zotero (see scheduleSync).
    {
        begPrefix: "ZF_PERSIST_BEG_",
        endPrefix: "ZF_PERSIST_END_",
        type: "PERSIST",
    },
];

/* ================================================================ */
/*  EditableRegion                                                  */
/* ================================================================ */

export interface EditableRegion {
    /** Marker category — "NOTE", "ANNO", "PERSIST". */
    type: string;
    /** Zotero item key (or persist id) extracted from the marker. */
    key: string;
    /** Editable content start offset. */
    from: number;
    /** Editable content end offset (may equal `from`: zero-width region). */
    to: number;
    /** BEG marker text start offset (the `<` of `<!--`). */
    begFrom: number;
    /** BEG marker text end offset (just past `-->`). */
    begTo: number;
    /** END marker text start offset. */
    endFrom: number;
    /** END marker text end offset. */
    endTo: number;
    /** `<!-- ZF_NOTE_META ... -->` start offset (if present inside region). */
    metaFrom?: number;
    /** `<!-- ZF_NOTE_META ... -->` end offset (if present inside region). */
    metaTo?: number;
}

/* ================================================================ */
/*  Parser                                                          */
/* ================================================================ */

/** Build a single regex that matches all registered BEG/END markers. */
function buildMarkerRegex(): RegExp {
    const prefixes: string[] = [];
    for (const m of MARKER_REGISTRY) {
        prefixes.push(m.begPrefix, m.endPrefix);
    }
    // Escape regex-special chars in prefixes (defensive)
    const escaped = prefixes.map((p) =>
        p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    // Match: <!-- <PREFIX><KEY> -->
    // \w plus "-": persist region ids allow hyphens (Zotero keys are \w-only).
    return new RegExp(`<!-- (${escaped.join("|")})([\\w-]+) -->`, "g");
}

const MARKER_REGEX = buildMarkerRegex();

interface ParsedMarker {
    type: string;
    role: "beg" | "end";
    key: string;
    /** Marker text start offset. */
    from: number;
    /** Marker text end offset. */
    to: number;
}

/**
 * Single-pass parse of all editable regions in the document.
 *
 * Region bounds are marker-offset based, which supports both layouts:
 *
 *   Block  — markers on their own lines, content on the lines between:
 *              <!-- ZF_NOTE_BEG_key -->
 *              content
 *              <!-- ZF_NOTE_END_key -->
 *   Inline — both markers (or either one) sharing a line with content:
 *              > <!-- ZF_ANNO_BEG_key -->comment<!-- ZF_ANNO_END_key -->
 *
 * Normalization rules bridging the two:
 *  - if the BEG marker's line has nothing after the marker, content starts
 *    on the next line (the newline is not part of the content);
 *  - if the END marker's line has only blockquote prefix (`>`/whitespace)
 *    before the marker, content ends before that line's newline.
 * Mixed forms (e.g. a multi-line paste into an inline region) fall out of
 * these rules naturally.
 */
export function parseEditableRegions(doc: Text): EditableRegion[] {
    const text = doc.toString();
    MARKER_REGEX.lastIndex = 0;

    const markers: ParsedMarker[] = [];

    let match;
    while ((match = MARKER_REGEX.exec(text))) {
        const prefix = match[1]!;
        const key = match[2]!;

        // Find which registry entry this prefix belongs to
        let markerType: MarkerType | undefined;
        let role: "beg" | "end" | undefined;
        for (const m of MARKER_REGISTRY) {
            if (prefix === m.begPrefix) {
                markerType = m;
                role = "beg";
                break;
            }
            if (prefix === m.endPrefix) {
                markerType = m;
                role = "end";
                break;
            }
        }
        if (!markerType || !role) continue;

        markers.push({
            type: markerType.type,
            role,
            key,
            from: match.index,
            to: match.index + match[0].length,
        });
    }

    // Pair BEG with the nearest following END of the same type+key
    const regions: EditableRegion[] = [];
    const used = new Set<number>();

    for (let i = 0; i < markers.length; i++) {
        const beg = markers[i]!;
        if (beg.role !== "beg" || used.has(i)) continue;

        for (let j = i + 1; j < markers.length; j++) {
            const end = markers[j]!;
            if (used.has(j)) continue;
            if (
                end.role !== "end" ||
                end.type !== beg.type ||
                end.key !== beg.key
            )
                continue;

            const begLine = doc.lineAt(beg.to);
            const endLine = doc.lineAt(end.from);
            const sameLine = begLine.number === endLine.number;

            // Content start: right after the BEG marker, or on the next
            // line when the marker has its line to itself.
            let from = beg.to;
            if (!sameLine && /^\s*$/.test(text.slice(beg.to, begLine.to))) {
                from = begLine.to + 1;
            }

            // Content end: right before the END marker, or before the END
            // line's newline when only a blockquote prefix precedes it.
            let to = end.from;
            if (
                !sameLine &&
                /^[>\s]*$/.test(text.slice(endLine.from, end.from))
            ) {
                to = endLine.from - 1;
            }

            if (to < from) {
                if (from === endLine.from) {
                    // Adjacent block markers (no content lines): keep a
                    // zero-width insertion point at the END line start.
                    to = from;
                } else {
                    // Malformed shape — skip pairing entirely.
                    used.add(i);
                    used.add(j);
                    break;
                }
            }

            regions.push({
                type: beg.type,
                key: beg.key,
                from,
                to,
                begFrom: beg.from,
                begTo: beg.to,
                endFrom: end.from,
                endTo: end.to,
            });

            used.add(i);
            used.add(j);
            break;
        }
    }

    // Detect the ZF_NOTE_META marker inside NOTE regions only.
    // Uses the global flag + lastIndex to scan within each region's bounds
    // on the already-allocated `text` string — avoids a .slice() per region.
    const META_REGEX_G = createNoteMetaScanner();
    for (const region of regions) {
        if (region.type !== "NOTE") continue;

        META_REGEX_G.lastIndex = region.from;
        const metaMatch = META_REGEX_G.exec(text);
        if (metaMatch && metaMatch.index < region.to) {
            region.metaFrom = metaMatch.index;
            region.metaTo = metaMatch.index + metaMatch[0]!.length;

            // Move editable start past the meta line
            const metaLine = doc.lineAt(region.metaTo);
            const newFrom = metaLine.to + 1;
            if (newFrom <= region.to) {
                region.from = newFrom;
            }
        }
    }

    return regions;
}
