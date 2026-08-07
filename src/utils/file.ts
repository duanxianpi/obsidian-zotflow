import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { TFileWithoutParentAndVault } from "types/zotflow";

/**
 * True when any segment of the path starts with a dot (e.g. `.zotflow/...`).
 *
 */
function isHiddenPath(normalizedPath: string): boolean {
    return normalizedPath.split("/").some((seg) => seg.startsWith("."));
}

/**
 * Recursively create a (possibly hidden) folder via the DataAdapter.
 */
async function ensureFolderExistsViaAdapter(app: App, folderPath: string) {
    if (!folderPath || folderPath === "/" || folderPath === ".") return;
    const adapter = app.vault.adapter;
    if (await adapter.exists(folderPath)) return;

    const parentPath = folderPath.substring(0, folderPath.lastIndexOf("/"));
    if (parentPath) await ensureFolderExistsViaAdapter(app, parentPath);

    await adapter.mkdir(folderPath);
}

/**
 * Ensure folder exists
 */
export async function ensureFolderExists(app: App, folderPath: string) {
    const normalizedPath = normalizePath(folderPath);
    if (normalizedPath === "" || normalizedPath === "/") return;

    // Hidden folders are invisible to the Vault tree — use the adapter.
    if (isHiddenPath(normalizedPath)) {
        await ensureFolderExistsViaAdapter(app, normalizedPath);
        return;
    }

    const existingFolder = app.vault.getAbstractFileByPath(normalizedPath);

    if (existingFolder) {
        if (existingFolder instanceof TFolder) return;
        throw new Error(
            `Cannot create folder: "${normalizedPath}" already exists and is not a folder.`,
        );
    }

    const parentPath = normalizedPath.substring(
        0,
        normalizedPath.lastIndexOf("/"),
    );
    if (parentPath) await ensureFolderExists(app, parentPath);

    await app.vault.createFolder(normalizedPath);
}

/**
 * General save logic (internal use)
 */
async function saveFileInternal(
    app: App,
    filePath: string,
    data: string | ArrayBuffer,
    isBinary: boolean,
): Promise<TFile | null> {
    const normalizedPath = normalizePath(filePath);
    const folderPath = normalizedPath.substring(
        0,
        normalizedPath.lastIndexOf("/"),
    );

    // Ensure parent folder exists
    if (folderPath) await ensureFolderExists(app, folderPath);

    // Hidden paths are not tracked by the Vault tree — write via the adapter.
    if (isHiddenPath(normalizedPath)) {
        const adapter = app.vault.adapter;
        if (isBinary) {
            await adapter.writeBinary(normalizedPath, data as ArrayBuffer);
        } else {
            await adapter.write(normalizedPath, data as string);
        }
        return null;
    }

    // Check file status
    const file = app.vault.getAbstractFileByPath(normalizedPath);

    if (file instanceof TFile) {
        // Update mode
        if (isBinary) {
            await app.vault.modifyBinary(file, data as ArrayBuffer);
        } else {
            await app.vault.modify(file, data as string);
        }
        return file;
    } else if (!file) {
        // Create mode
        if (isBinary) {
            return await app.vault.createBinary(
                normalizedPath,
                data as ArrayBuffer,
            );
        } else {
            return await app.vault.create(normalizedPath, data as string);
        }
    } else {
        throw new Error(
            `Cannot write: "${normalizedPath}" is occupied by a folder.`,
        );
    }
}

/* ================================================================ */
/*  External API                                                   */
/* ================================================================ */

/**
 * Save text/Markdown file (auto create or overwrite)
 * @param app Obsidian App object
 * @param filePath File path (e.g., "Notes/Hello.md")
 * @param content Text content
 * @returns the created/updated `TFile`, or `null` for hidden (adapter) paths.
 */
export async function saveTextFile(
    app: App,
    filePath: string,
    content: string,
): Promise<TFile | null> {
    return saveFileInternal(app, filePath, content, false);
}

/**
 * Save binary file (image/PDF, etc.) (auto create or overwrite)
 * @param app Obsidian App object
 * @param filePath File path (e.g., "Assets/image.png")
 * @param data ArrayBuffer data
 * @returns the created/updated `TFile`, or `null` for hidden (adapter) paths.
 */
export async function saveBinaryFile(
    app: App,
    filePath: string,
    data: ArrayBuffer,
): Promise<TFile | null> {
    return saveFileInternal(app, filePath, data, true);
}

/**
 * Check if a file exists
 */
export async function checkFile(
    app: App,
    path: string,
): Promise<{
    exists: boolean;
    path: string;
    frontmatter?: Record<string, unknown>;
}> {
    const normalizedPath = normalizePath(path);

    // Hidden files aren't in the Vault tree (no metadata cache either).
    if (isHiddenPath(normalizedPath)) {
        const exists = await app.vault.adapter.exists(normalizedPath);
        return { exists, path: normalizedPath };
    }

    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
        const cache = app.metadataCache.getFileCache(file);
        return {
            exists: true,
            path: file.path,
            frontmatter: cache?.frontmatter,
        };
    }
    return { exists: false, path: path };
}

/**
 * Read text file
 */
export async function readTextFile(
    app: App,
    path: string,
): Promise<string | null> {
    const normalizedPath = normalizePath(path);

    // Hidden files aren't in the Vault tree — read via the adapter.
    if (isHiddenPath(normalizedPath)) {
        const adapter = app.vault.adapter;
        if (await adapter.exists(normalizedPath)) {
            return await adapter.read(normalizedPath);
        }
        return null;
    }

    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
        return await app.vault.read(file);
    }
    return null;
}

/**
 * Rename/move a file, handling both Vault-tracked and hidden (adapter) paths.
 * Ensures the destination's parent folder exists first.
 */
export async function renameFile(
    app: App,
    oldPath: string,
    newPath: string,
): Promise<void> {
    const oldNormalized = normalizePath(oldPath);
    const newNormalized = normalizePath(newPath);
    if (oldNormalized === newNormalized) return;

    const folderPath = newNormalized.substring(
        0,
        newNormalized.lastIndexOf("/"),
    );
    if (folderPath) await ensureFolderExists(app, folderPath);

    // If either endpoint is hidden, operate at the filesystem level.
    if (isHiddenPath(oldNormalized) || isHiddenPath(newNormalized)) {
        const adapter = app.vault.adapter;
        if (await adapter.exists(oldNormalized)) {
            await adapter.rename(oldNormalized, newNormalized);
        }
        return;
    }

    const file = app.vault.getAbstractFileByPath(oldNormalized);
    if (file instanceof TFile) {
        await app.vault.rename(file, newNormalized);
    }
}

/**
 * Delete file
 */
export async function deleteFile(app: App, path: string): Promise<void> {
    const normalizedPath = normalizePath(path);

    // Hidden files aren't in the Vault tree — delete via the adapter.
    if (isHiddenPath(normalizedPath)) {
        const adapter = app.vault.adapter;
        if (!(await adapter.exists(normalizedPath))) return;
        try {
            // Prefer the system trash (reversible); fall back to local trash.
            const trashed = await adapter.trashSystem(normalizedPath);
            if (!trashed) await adapter.trashLocal(normalizedPath);
        } catch {
            await adapter.trashLocal(normalizedPath);
        }
        return;
    }

    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (file && file instanceof TFile) {
        // `trashFile` follows the vault's own deletion setting; `vault.trash`
        // would force the system bin regardless of what the user chose.
        await app.fileManager.trashFile(file);
    }
}

/**
 * Get linked source note
 */
export function getLinkedLocalSourceNote(
    app: App,
    file: TFileWithoutParentAndVault,
): TFileWithoutParentAndVault | null {
    const pdfPath = file.path;
    const resolvedLinks = app.metadataCache.resolvedLinks;

    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
        if (!links[pdfPath]) continue;
        const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
        if (!sourceFile || !(sourceFile instanceof TFile)) continue;

        const cache = app.metadataCache.getFileCache(sourceFile);
        // Frontmatter holds whatever the user typed; anything but a link
        // string is not something `extractPathFromLink` can read.
        const fmLink: unknown = cache?.frontmatter?.["zotflow-local-attachment"];
        if (typeof fmLink !== "string" || !fmLink) continue;

        const dest = app.metadataCache.getFirstLinkpathDest(
            extractPathFromLink(fmLink),
            sourceFile.path,
        );

        if (dest && dest.path === pdfPath) {
            return {
                path: sourceFile.path,
                name: sourceFile.name,
                extension: sourceFile.extension,
                basename: sourceFile.basename,
            };
        }
    }

    return null;
}

function extractPathFromLink(text: string): string {
    if (!text) return "";

    // Remove [[ and ]]
    let path = text.replace(/\[\[|\]\]/g, "");

    path = path.split("|")[0]!;

    return path.trim();
}
