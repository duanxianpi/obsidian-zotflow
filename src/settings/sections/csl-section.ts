import { workerBridge } from "bridge";
import { services } from "services/services";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";
import type { CslOutputFormat } from "settings/types";
import type { StyleInfo } from "worker/csl";

const FORMAT_LABELS: Record<CslOutputFormat, string> = {
    text: "Plain text",
    html: "HTML",
    markdown: "Markdown",
    "markdown-pure": "Markdown (pure, no inline HTML)",
};

function isSupported(style: StyleInfo): boolean {
    return (
        style.availability.status === "ready" ||
        style.availability.status === "resolvable"
    );
}

/** Declarative settings for CSL rendering, custom styles, and cache. */
export class CslSection {
    constructor(private readonly plugin: ZotFlow) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Rendering",
                items: [
                    {
                        name: "Default Style",
                        desc: "Style used when a caller does not specify one. Only styles whose dependencies can be satisfied are listed — add more in the Activity Center's CSL tab.",
                        render: (setting) => {
                            let disposed = false;
                            setting.addDropdown((dropdown) => {
                                const current =
                                    this.plugin.settings.cslDefaultStyleId;
                                dropdown.addOption(current, current);
                                dropdown.setValue(current);
                                dropdown.onChange(async (value) => {
                                    this.plugin.settings.cslDefaultStyleId =
                                        value;
                                    await this.plugin.saveSettings();
                                });

                                void (async () => {
                                    try {
                                        const styles =
                                            await workerBridge.cslRender.listStyles();
                                        if (disposed) return;
                                        const supported =
                                            styles.filter(isSupported);
                                        dropdown.selectEl.empty();
                                        if (
                                            current &&
                                            !supported.some(
                                                (style) => style.id === current,
                                            )
                                        ) {
                                            dropdown.addOption(
                                                current,
                                                `${current} (not downloaded)`,
                                            );
                                        }
                                        for (const style of supported) {
                                            dropdown.addOption(
                                                style.id,
                                                style.title
                                                    ? `${style.title} (${style.id})`
                                                    : style.id,
                                            );
                                        }
                                        dropdown.setValue(current);
                                    } catch {
                                        // Keep the current style as a fallback.
                                    }
                                })();
                            });
                            return () => {
                                disposed = true;
                            };
                        },
                    },
                    {
                        name: "Default Output Format",
                        control: {
                            type: "dropdown",
                            key: "cslDefaultFormat",
                            options: FORMAT_LABELS,
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Custom Styles",
                items: [
                    {
                        name: "Custom styles folder",
                        desc: "Vault-relative folder scanned for .csl files (and locales-xx-XX.xml). Files dropped in are usable immediately and override downloaded styles with the same id. Leave empty to disable.",
                        render: (setting) => {
                            setting
                                .addText((text) =>
                                    text
                                        .setPlaceholder("csl-styles")
                                        .setValue(
                                            this.plugin.settings
                                                .cslStylesFolder,
                                        )
                                        .onChange(async (value) => {
                                            this.plugin.settings.cslStylesFolder =
                                                value.trim();
                                            await this.plugin.saveSettings();
                                            this.plugin.cslFolder.setFolder(
                                                this.plugin.settings
                                                    .cslStylesFolder,
                                            );
                                            await this.plugin.cslFolder.rescan();
                                        }),
                                )
                                .addButton((button) =>
                                    button
                                        .setButtonText("Re-scan now")
                                        .setTooltip(
                                            "Re-read every style in the folder",
                                        )
                                        .onClick(async () => {
                                            this.plugin.cslFolder.setFolder(
                                                this.plugin.settings
                                                    .cslStylesFolder,
                                            );
                                            await this.plugin.cslFolder.rescan();
                                            services.notificationService.notify(
                                                "success",
                                                "CSL styles folder re-scanned",
                                            );
                                        }),
                                );
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Cache",
                items: [
                    {
                        name: "Clear cache",
                        desc: "Remove all downloaded styles and locales. Styles from the custom styles folder are kept.",
                        render: (setting) => {
                            setting.addButton((button) =>
                                button
                                    .setButtonText("Clear cache")
                                    .setDestructive()
                                    .onClick(async () => {
                                        try {
                                            await workerBridge.cslRender.clearCache();
                                            services.notificationService.notify(
                                                "success",
                                                "CSL cache cleared",
                                            );
                                        } catch (error) {
                                            services.logService.error(
                                                "Failed to clear CSL cache",
                                                "CslSection",
                                                error,
                                            );
                                            services.notificationService.notify(
                                                "error",
                                                "Failed to clear CSL cache.",
                                            );
                                        }
                                    }),
                            );
                        },
                    },
                ],
            },
        ];
    }
}
