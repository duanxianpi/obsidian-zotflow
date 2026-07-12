import { normalizePath, TFile } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type { TAbstractFile, Vault } from "obsidian";

const LOCALE_FILE_RE = /^locales-([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)\.xml$/;

/**
 * Watches the configured vault folder for custom CSL styles (.csl) and
 * locale files (locales-xx-XX.xml) and keeps them registered in the
 * worker-side CSL service. The worker never touches the filesystem — it only
 * receives XML strings from here.
 *
 * Style key = file basename without extension; folder styles override
 * downloaded styles with the same id.
 */
export class CslFolderService {
    private folder = "";

    constructor(private vault: Vault) {}

    setFolder(path: string): void {
        this.folder = path ? normalizePath(path.trim()) : "";
    }

    private isInFolder(path: string): boolean {
        return this.folder !== "" && path.startsWith(this.folder + "/");
    }

    /** Full re-scan: drop all folder styles, then register everything found. */
    async rescan(): Promise<void> {
        try {
            await workerBridge.cslRender.clearFolderStyles();
            if (this.folder === "") return;
            for (const file of this.vault.getFiles()) {
                if (this.isInFolder(file.path)) {
                    await this.registerFile(file);
                }
            }
        } catch (e) {
            services.logService.error(
                "CSL styles folder scan failed",
                "CslFolderService",
                e,
            );
        }
    }

    private async registerFile(file: TFile): Promise<void> {
        if (file.extension === "csl") {
            const xml = await this.vault.cachedRead(file);
            await workerBridge.cslRender.registerCustomStyle(
                file.basename,
                xml,
            );
            return;
        }
        const m = file.name.match(LOCALE_FILE_RE);
        if (m && m[1]) {
            const xml = await this.vault.cachedRead(file);
            await workerBridge.cslRender.registerCustomLocale(m[1], xml);
        }
    }

    private async unregisterFile(file: TFile): Promise<void> {
        if (file.extension === "csl") {
            await workerBridge.cslRender.unregisterCustomStyle(file.basename);
            return;
        }
        const m = file.name.match(LOCALE_FILE_RE);
        if (m && m[1]) {
            await workerBridge.cslRender.unregisterCustomLocale(m[1]);
        }
    }

    /** Vault event handlers — wired via plugin.registerEvent in main.ts. */

    async onCreateOrModify(file: TAbstractFile): Promise<void> {
        if (file instanceof TFile && this.isInFolder(file.path)) {
            try {
                await this.registerFile(file);
            } catch (e) {
                services.logService.error(
                    `Failed to load CSL file ${file.path}`,
                    "CslFolderService",
                    e,
                );
            }
        }
    }

    async onDelete(file: TAbstractFile): Promise<void> {
        if (file instanceof TFile && this.isInFolder(file.path)) {
            try {
                await this.unregisterFile(file);
            } catch (e) {
                services.logService.error(
                    `Failed to unload CSL file ${file.path}`,
                    "CslFolderService",
                    e,
                );
            }
        }
    }

    async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
        if (!(file instanceof TFile)) return;
        try {
            if (this.isInFolder(oldPath)) {
                const oldName = oldPath.split("/").pop() ?? "";
                const oldBase = oldName.replace(/\.[^.]+$/, "");
                if (oldName.endsWith(".csl")) {
                    await workerBridge.cslRender.unregisterCustomStyle(oldBase);
                } else {
                    const m = oldName.match(LOCALE_FILE_RE);
                    if (m && m[1]) {
                        await workerBridge.cslRender.unregisterCustomLocale(
                            m[1],
                        );
                    }
                }
            }
            if (this.isInFolder(file.path)) {
                await this.registerFile(file);
            }
        } catch (e) {
            services.logService.error(
                `Failed to handle CSL file rename ${oldPath}`,
                "CslFolderService",
                e,
            );
        }
    }
}
