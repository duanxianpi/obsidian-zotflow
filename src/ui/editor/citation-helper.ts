import { services } from "services/services";

import type {
    Editor,
    EditorPosition,
    MarkdownView,
    MarkdownFileInfo,
} from "obsidian";
import type { CitationFormat } from "settings/types";
import type { CitationResult } from "services/citation-service";
import type { AnnotationJSON } from "types/zotero-reader";

/** Custom MIME type used in dataTransfer for ZotFlow citation payloads. */
export const ZOTFLOW_CITATION_MIME = "application/zotflow-citation";

/** Structured payload carried via dataTransfer for citation drag-drop. */
export interface ZotFlowCitationPayload {
    type: "zotflow-citation";
    libraryID: number;
    key: string;
    /** Stripped annotations — only template-relevant fields, no binary/position data. */
    annotations?: AnnotationJSON[];
}

function resolveInsertionAnchor(
    editor: Editor,
    preferredPos: EditorPosition,
    baselineDoc: string,
): EditorPosition {
    return editor.getValue() === baselineDoc
        ? preferredPos
        : editor.getCursor();
}

function setCursorAfterInsertedText(
    editor: Editor,
    insertOffset: number,
    insertedText: string,
): void {
    const endOffset = insertOffset + insertedText.length;
    editor.setCursor(editor.offsetToPos(endOffset));
}

/**
 * Strip an AnnotationJSON down to the fields needed by citation templates.
 * Removes heavy/non-serializable data (image, position, sortIndex, etc.)
 * so the result is safe for dataTransfer / clipboard payloads.
 */
export function stripAnnotationForPayload(
    annotation: AnnotationJSON,
): AnnotationJSON {
    return {
        id: annotation.id,
        libraryID: annotation.libraryID,
        parentItem: annotation.parentItem,
        type: annotation.type,
        text: annotation.text,
        comment: annotation.comment,
        color: annotation.color,
        pageLabel: annotation.pageLabel,
        authorName: annotation.authorName,
        tags: annotation.tags,
        dateAdded: annotation.dateAdded,
        dateModified: annotation.dateModified,
        // Provide a minimal position to satisfy the required field
        position: { pageIndex: annotation.position.pageIndex, rects: [] },
    };
}

/**
 * Safely parse and validate a raw string as a ZotFlowCitationPayload.
 * Returns `null` if the string is not valid JSON or doesn't match the expected shape.
 */
export function parseZotFlowCitationPayload(
    raw: string,
): ZotFlowCitationPayload | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "type" in parsed &&
            (parsed as Record<string, unknown>).type === "zotflow-citation" &&
            "libraryID" in parsed &&
            typeof (parsed as Record<string, unknown>).libraryID === "number" &&
            "key" in parsed &&
            typeof (parsed as Record<string, unknown>).key === "string"
        ) {
            const obj = parsed as ZotFlowCitationPayload;
            return {
                type: obj.type,
                libraryID: obj.libraryID,
                key: obj.key,
                annotations: obj.annotations,
            };
        }
    } catch {
        // Invalid JSON — fall through
    }
    return null;
}

/**
 * Determine the citation format from keyboard modifier keys.
 * Mirrors the CitationSuggest key mapping for consistency:
 * - Ctrl/Cmd + Shift → citekey
 * - Shift            → wikilink
 * - Ctrl/Cmd         → footnote
 * - Alt              → pandoc
 * - (none)           → settings default
 */
export function resolveFormatFromModifiers(event: {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
}): CitationFormat {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey) return "citekey";
    if (event.shiftKey) return "wikilink";
    if (event.ctrlKey || event.metaKey) return "footnote";
    if (event.altKey) return "pandoc";
    return services.settings.defaultCitationFormat;
}

/**
 * Split a rendered footnote-definition block into individual definitions.
 * Each definition starts at a line beginning with `[^marker]:` and runs until
 * the next such line (or end of string), so multi-line definition bodies are
 * preserved. Returns `[{ marker: "", text }]` when no marker is found.
 */
function parseFootnoteDefinitions(
    footnoteDef: string,
): { marker: string; text: string }[] {
    const re = /^\[\^([^\]]+)\]:/gm;
    const starts: { marker: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(footnoteDef)) !== null) {
        starts.push({ marker: m[1] ?? "", index: m.index });
    }
    if (starts.length === 0) {
        return [{ marker: "", text: footnoteDef.trimEnd() }];
    }
    const defs: { marker: string; text: string }[] = [];
    for (let i = 0; i < starts.length; i++) {
        const cur = starts[i];
        if (!cur) continue;
        const next = starts[i + 1];
        const end = next ? next.index : footnoteDef.length;
        defs.push({
            marker: cur.marker,
            text: footnoteDef.slice(cur.index, end).trimEnd(),
        });
    }
    return defs;
}

/**
 * Insert a resolved citation result into an editor at a given position.
 * Handles footnote definition appending when applicable.
 */
export function insertCitationResult(
    editor: Editor,
    pos: EditorPosition,
    result: CitationResult,
): void {
    const insertOffset = editor.posToOffset(pos);
    editor.replaceRange(result.citation, pos);

    if (result.footnoteDef) {
        // A rendered definition block may contain several `[^marker]:` entries
        // (one per annotation). Append only the definitions whose marker is not
        // already present in the document, so repeated inserts don't duplicate.
        const editorContent = editor.getValue();
        const missing = parseFootnoteDefinitions(result.footnoteDef).filter(
            (def) => {
                const prefix = def.marker
                    ? `[^${def.marker}]:`
                    : `[^${result.citekey}]:`;
                return (
                    !editorContent.includes(`\n${prefix}`) &&
                    !editorContent.startsWith(prefix)
                );
            },
        );

        if (missing.length > 0) {
            const block = missing.map((def) => def.text).join("\n");
            const lastLine = editor.lastLine();
            const lastLineText = editor.getLine(lastLine);
            const prefix = lastLineText.length > 0 ? "\n" : "";
            editor.replaceRange(`${prefix}${block}\n`, {
                line: lastLine,
                ch: lastLineText.length,
            });
        }
    }

    setCursorAfterInsertedText(editor, insertOffset, result.citation);
}

/**
 * Handler for Obsidian's `editor-drop` workspace event.
 * Intercepts drops carrying a ZotFlow citation payload, resolves the citation
 * asynchronously, and inserts it at the drop position.
 */
export function handleEditorDrop(
    evt: DragEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
): void {
    if (evt.defaultPrevented) return;

    const raw = evt.dataTransfer?.getData(ZOTFLOW_CITATION_MIME);
    if (!raw) return;

    const payload = parseZotFlowCitationPayload(raw);
    if (!payload) return;

    evt.preventDefault();

    const pos = editor.getCursor();
    const baselineDoc = editor.getValue();
    const format = resolveFormatFromModifiers(evt);

    services.citationService
        .resolve(payload, format)
        .then((result) => {
            if (result) {
                const insertPos = resolveInsertionAnchor(
                    editor,
                    pos,
                    baselineDoc,
                );
                insertCitationResult(editor, insertPos, result);
            }
        })
        .catch((error) => {
            services.logService.error(
                "Failed to resolve citation on drop",
                "EditorDrop",
                error,
            );
            services.notificationService.notify(
                "error",
                "Failed to insert citation.",
            );
        });
}
