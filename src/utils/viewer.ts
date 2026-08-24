import { App, MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import { ZOTERO_READER_VIEW_TYPE, ZoteroReaderView } from "../ui/reader/view";
import { NOTE_EDITOR_VIEW_TYPE, NoteEditorView } from "../ui/note-editor/view";
import { workerBridge } from "../bridge";
import { services } from "../services/services";
import { saveBinaryFile } from "utils/file";

import type { ReaderNavigation } from "types/zotero-reader";
import type { AttachmentData } from "types/zotero-item";
import type { IDBZoteroItem } from "types/db-schema";

/**
 * Open an attachment in the default application.
 * @param libraryID The library ID of the attachment.
 * @param key The item key of the attachment.
 * @param app The Obsidian App instance.
 * @param navigationInfo Optional navigation info.
 */
export async function openAttachment(
    libraryID: number,
    key: string,
    app: App,
    navigationInfo?: string,
) {
    // Update last accessed timestamp
    workerBridge.dbHelper.updateLastAccessed(libraryID, key).catch(() => {
        // Silent catch: timestamp update shouldn't block opening
    });

    let activeLeaf;
    const leaves = app.workspace.getLeavesOfType(ZOTERO_READER_VIEW_TYPE);

    for (const leaf of leaves) {
        const view = leaf.view as ZoteroReaderView;
        if (
            view &&
            view.getState().libraryID === libraryID &&
            view.getState().itemKey === key
        ) {
            activeLeaf = leaf;
        }
    }

    if (activeLeaf) {
        app.workspace.setActiveLeaf(activeLeaf);
    } else {
        activeLeaf = app.workspace.getLeaf("tab");

        await activeLeaf.setViewState({
            type: ZOTERO_READER_VIEW_TYPE,
            active: true,
            state: {
                libraryID: libraryID,
                itemKey: key,
            },
        });

        void app.workspace.revealLeaf(activeLeaf);
    }

    if (navigationInfo) {
        (activeLeaf.view as ZoteroReaderView).readerNavigate(
            JSON.parse(navigationInfo) as ReaderNavigation,
        );
    }
}

/**
 * Copy a Zotero PDF attachment into the vault and open it with Obsidian's
 * native PDF viewer. This is intentionally opt-in: ZotFlow's own reader and
 * annotation sync remain the default attachment workflow.
 */
export async function openAttachmentInNativePdfViewer(
    libraryID: number,
    key: string,
    app: App,
): Promise<void> {
    if (services.settings.overwriteViewer) {
        new Notice(
            "Disable ZotFlow's PDF/EPUB/HTML Viewer override before opening attachments in Obsidian's native PDF viewer.",
            8000,
        );
        return;
    }

    const attachment = await workerBridge.dbHelper.getItem(libraryID, key);
    if (!attachment || attachment.itemType !== "attachment") {
        throw new Error("Attachment metadata could not be found.");
    }

    const filename = attachment.raw.data.filename;
    if (
        !filename ||
        filename === "." ||
        filename === ".." ||
        filename.includes("/") ||
        filename.includes("\\")
    ) {
        throw new Error("Attachment has no valid filename.");
    }

    const vaultPath = normalizePath(
        `Zotero Attachments/${libraryID}/${key}/${filename}`,
    );
    let file = app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) {
        new Notice("Copying attachment into the vault…");
        const { blob } = await workerBridge.downloadAttachment(
            attachment as IDBZoteroItem<AttachmentData>,
        );
        file = await saveBinaryFile(app, vaultPath, await blob.arrayBuffer());
    }

    if (!(file instanceof TFile)) {
        throw new Error("Attachment could not be copied into the vault.");
    }

    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    void app.workspace.revealLeaf(leaf);
}

/**
 * Open a markdown source note. Reuses an existing leaf already showing the
 * file; otherwise opens it in a new tab.
 */
export async function openSourceNote(file: TFile, app: App): Promise<void> {
    const leaves = app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === file.path) {
            app.workspace.setActiveLeaf(leaf);
            void app.workspace.revealLeaf(leaf);
            return;
        }
    }
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    void app.workspace.revealLeaf(leaf);
}

/**
 * Open a Zotero child note.
 *
 * Default behaviour: locate the child note's editable region inside its
 * parent's source note (the `<!-- ZF_NOTE_BEG_<noteKey> -->` marker) and open
 * the source note scrolled to that region. When the marker (or the parent
 * source note) can't be found, or when the user has opted into the
 * experimental "always open in Note Editor" setting, fall back to the
 * standalone Note Editor view.
 */
export async function openItemNote(
    libraryID: number,
    noteKey: string,
    app: App,
) {
    if (!services.settings.alwaysOpenChildNoteInEditor) {
        const located = await openItemNoteInSourceNote(libraryID, noteKey, app);
        if (located) return;
    }

    await openItemNoteInEditor(libraryID, noteKey, app);
}

/**
 * Try to open the parent source note scrolled to the child note's editable
 * region. Returns `true` when the source note was opened, `false` when there
 * is no source note to show (caller should fall back to the Note Editor).
 */
export async function openItemNoteInSourceNote(
    libraryID: number,
    noteKey: string,
    app: App,
): Promise<boolean> {
    try {
        const note = await workerBridge.dbHelper.getItem(libraryID, noteKey);
        const parentKey = note?.parentItem;
        if (!parentKey) return false;

        const file = services.indexService.getFileByKey(parentKey);
        if (!file) return false;

        // Open (or reveal) the source note first, then locate the child note's
        // region marker from the content Obsidian has already loaded into the
        // view — no separate disk read required.
        const view = await openSourceNoteView(file, app);
        scrollToMarker(view, `ZF_NOTE_BEG_${noteKey}`);
        return true;
    } catch {
        // Any lookup failure falls back to the Note Editor view.
        return false;
    }
}

/**
 * Open (or reveal) the markdown view for a source note. Reuses an existing
 * leaf already showing the file; otherwise opens it in a new tab. Returns the
 * resulting `MarkdownView` (or `null` if it isn't a markdown view).
 */
async function openSourceNoteView(
    file: TFile,
    app: App,
): Promise<MarkdownView | null> {
    const leaves = app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === file.path) {
            app.workspace.setActiveLeaf(leaf);
            void app.workspace.revealLeaf(leaf);
            return view;
        }
    }
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    void app.workspace.revealLeaf(leaf);
    return leaf.view instanceof MarkdownView ? leaf.view : null;
}

/**
 * Scroll a markdown view to the line containing `marker`, using the content
 * already loaded into the view. Works in both source/live-preview and reading
 * modes via the view's ephemeral state. Best effort: does nothing if the
 * marker isn't present.
 */
function scrollToMarker(view: MarkdownView | null, marker: string): void {
    if (!view) return;
    const line = view
        .getViewData()
        .split("\n")
        .findIndex((l) => l.includes(marker));
    if (line === -1) return;
    view.setEphemeralState({ line });
}

/**
 * Open a Zotero child note in the note editor view.
 * Reuses an existing leaf if one is already showing the same note.
 */
export async function openItemNoteInEditor(
    libraryID: number,
    noteKey: string,
    app: App,
) {
    let activeLeaf;
    const leaves = app.workspace.getLeavesOfType(NOTE_EDITOR_VIEW_TYPE);

    for (const leaf of leaves) {
        const view = leaf.view as NoteEditorView;
        if (view) {
            const state = view.getState();
            if (state.libraryID === libraryID && state.noteKey === noteKey) {
                activeLeaf = leaf;
            }
        }
    }

    if (activeLeaf) {
        app.workspace.setActiveLeaf(activeLeaf);
    } else {
        activeLeaf = app.workspace.getLeaf("tab");
        await activeLeaf.setViewState({
            type: NOTE_EDITOR_VIEW_TYPE,
            active: true,
            state: { libraryID, noteKey },
        });
        void app.workspace.revealLeaf(activeLeaf);
    }
}
