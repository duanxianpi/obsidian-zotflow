import type { Workspace, WorkspaceLeaf } from "obsidian";

type LeafNavigationWorkspace = Pick<Workspace, "revealLeaf" | "setActiveLeaf">;

/** Bring an existing reader leaf to the foreground and make it the final
 * focused leaf. Awaiting `revealLeaf` matters on mobile, where setting the
 * logical active leaf alone does not necessarily foreground its tab. */
export async function focusReaderLeaf(
    workspace: LeafNavigationWorkspace,
    target: WorkspaceLeaf,
): Promise<void> {
    await workspace.revealLeaf(target);
    workspace.setActiveLeaf(target, { focus: true });
}

/**
 * Close a just-created duplicate reader leaf, then foreground the reader that
 * already owns the document.
 *
 * The whole redirect is deferred until the current `setState` call unwinds.
 * Closing an active tab can select a fallback tab on Android, so activation of
 * the target must be the final operation rather than happen before `detach`.
 */
export async function redirectDuplicateReaderLeaf(
    workspace: LeafNavigationWorkspace,
    duplicate: WorkspaceLeaf,
    target: WorkspaceLeaf,
): Promise<void> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    duplicate.detach();
    await focusReaderLeaf(workspace, target);
}
