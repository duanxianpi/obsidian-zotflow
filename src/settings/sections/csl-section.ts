import { SettingGroup } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type ZotFlow from "main";
import type { CslOutputFormat } from "settings/types";
import type { StyleInfo } from "worker/csl";

const FORMAT_LABELS: Record<CslOutputFormat, string> = {
    text: "Plain text",
    html: "HTML",
    markdown: "Markdown",
    "markdown-pure": "Markdown (pure, no inline HTML)",
};

/** Is this style usable as a default (its dependency chain can close)? */
function isSupported(style: StyleInfo): boolean {
    return (
        style.availability.status === "ready" ||
        style.availability.status === "resolvable"
    );
}

/** Settings section for the CSL renderer (defaults, styles folder, cache). */
export class CslSection {
    constructor(
        private plugin: ZotFlow,
        private refreshUI: () => void,
    ) {}

    async render(containerEl: HTMLElement): Promise<void> {
        this.renderRendering(containerEl);
        this.renderCustomStyles(containerEl);
        this.renderCache(containerEl);
    }

    private renderRendering(containerEl: HTMLElement) {
        const group = new SettingGroup(containerEl);
        group.setHeading("Rendering");

        group.addSetting((setting) => {
            setting
                .setName("Default Style")
                .setDesc(
                    "Style used when a caller does not specify one. Only styles whose dependencies can be satisfied are listed — add more in the Activity Center's CSL tab.",
                )
                .addDropdown((dropdown) => {
                    const current = this.plugin.settings.cslDefaultStyleId;
                    // Placeholder until the async style list arrives.
                    dropdown.addOption(current, current);
                    dropdown.setValue(current);
                    void (async () => {
                        try {
                            const styles =
                                await workerBridge.cslRender.listStyles();
                            const supported = styles.filter(isSupported);
                            dropdown.selectEl.empty();
                            if (
                                !supported.some((s) => s.id === current) &&
                                current
                            ) {
                                dropdown.addOption(
                                    current,
                                    `${current} (not downloaded)`,
                                );
                            }
                            for (const s of supported) {
                                dropdown.addOption(
                                    s.id,
                                    s.title ? `${s.title} (${s.id})` : s.id,
                                );
                            }
                            dropdown.setValue(current);
                        } catch {
                            // Worker unavailable — keep the placeholder option.
                        }
                    })();
                    dropdown.onChange(async (value) => {
                        this.plugin.settings.cslDefaultStyleId = value;
                        await this.plugin.saveSettings();
                    });
                });
        });

        group.addSetting((setting) => {
            setting
                .setName("Default Output Format")
                .addDropdown((dropdown) => {
                    for (const [value, label] of Object.entries(
                        FORMAT_LABELS,
                    )) {
                        dropdown.addOption(value, label);
                    }
                    dropdown
                        .setValue(this.plugin.settings.cslDefaultFormat)
                        .onChange(async (value) => {
                            this.plugin.settings.cslDefaultFormat =
                                value as CslOutputFormat;
                            await this.plugin.saveSettings();
                        });
                });
        });
    }

    private renderCustomStyles(containerEl: HTMLElement) {
        const group = new SettingGroup(containerEl);
        group.setHeading("Custom Styles");

        group.addSetting((setting) => {
            setting
                .setName("Custom styles folder")
                .setDesc(
                    "Vault-relative folder scanned for .csl files (and locales-xx-XX.xml). Files dropped in are usable immediately and override downloaded styles with the same id. Leave empty to disable.",
                )
                .addText((text) => {
                    text.setPlaceholder("csl-styles")
                        .setValue(this.plugin.settings.cslStylesFolder)
                        .onChange(async (value) => {
                            this.plugin.settings.cslStylesFolder = value.trim();
                            await this.plugin.saveSettings();
                            this.plugin.cslFolder.setFolder(
                                this.plugin.settings.cslStylesFolder,
                            );
                            await this.plugin.cslFolder.rescan();
                        });
                })
                .addButton((btn) => {
                    btn.setButtonText("Re-scan now")
                        .setTooltip("Re-read every style in the folder")
                        .onClick(async () => {
                            this.plugin.cslFolder.setFolder(
                                this.plugin.settings.cslStylesFolder,
                            );
                            await this.plugin.cslFolder.rescan();
                            services.notificationService.notify(
                                "success",
                                "CSL styles folder re-scanned",
                            );
                        });
                });
        });
    }

    private renderCache(containerEl: HTMLElement) {
        const group = new SettingGroup(containerEl);
        group.setHeading("Cache");

        group.addSetting((setting) => {
            setting
                .setName("Clear cache")
                .setDesc(
                    "Remove all downloaded styles and locales. Styles from the custom styles folder are kept.",
                )
                .addButton((btn) => {
                    btn.setButtonText("Clear cache")
                        .setDestructive()
                        .onClick(async () => {
                            try {
                                await workerBridge.cslRender.clearCache();
                                services.notificationService.notify(
                                    "success",
                                    "CSL cache cleared",
                                );
                            } catch (e) {
                                services.logService.error(
                                    "Failed to clear CSL cache",
                                    "CslSection",
                                    e,
                                );
                                services.notificationService.notify(
                                    "error",
                                    "Failed to clear CSL cache.",
                                );
                            }
                        });
                });
        });
    }
}
