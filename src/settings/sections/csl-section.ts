import { SettingGroup } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type ZotFlow from "main";
import type { CslOutputFormat } from "settings/types";
import type { StyleInfo } from "worker/csl";

const STYLE_SOURCE_PRESETS: Record<string, string> = {
    zotero: "https://www.zotero.org/styles/{id}",
    jsdelivr:
        "https://cdn.jsdelivr.net/gh/citation-style-language/styles/{id}.csl",
};

const LOCALE_SOURCE_PRESETS: Record<string, string> = {
    github: "https://raw.githubusercontent.com/citation-style-language/locales/master/locales-{lang}.xml",
    jsdelivr:
        "https://cdn.jsdelivr.net/gh/citation-style-language/locales/locales-{lang}.xml",
};

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

/** Settings section for the CSL renderer (styles, locales, sources, cache). */
export class CslSection {
    constructor(
        private plugin: ZotFlow,
        private refreshUI: () => void,
    ) {}

    async render(containerEl: HTMLElement): Promise<void> {
        this.renderRendering(containerEl);
        this.renderCustomStyles(containerEl);
        this.renderSources(containerEl);
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
                .setName("Default Locale")
                .setDesc(
                    "BCP-47 tag, e.g. en-US, de-DE, zh-CN. Non-English locales are downloaded on first use and cached.",
                )
                .addText((text) => {
                    text.setPlaceholder("en-US")
                        .setValue(this.plugin.settings.cslDefaultLocale)
                        .onChange(async (value) => {
                            this.plugin.settings.cslDefaultLocale =
                                value.trim() || "en-US";
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

    private renderSources(containerEl: HTMLElement) {
        const group = new SettingGroup(containerEl);
        group.setHeading("Sources");

        group.addSetting((setting) => {
            setting
                .setName("Style download source")
                .setDesc(
                    "Where style XML is fetched from. {id} is replaced with the style id.",
                )
                .addDropdown((dropdown) => {
                    const current = this.plugin.settings.cslStyleUrlTemplate;
                    const preset =
                        Object.entries(STYLE_SOURCE_PRESETS).find(
                            ([, v]) => v === current,
                        )?.[0] ?? "custom";
                    dropdown
                        .addOption("zotero", "zotero.org")
                        .addOption("jsdelivr", "jsDelivr (CSL GitHub mirror)")
                        .addOption("custom", "Custom URL template")
                        .setValue(preset)
                        .onChange(async (value) => {
                            if (value === "custom") return;
                            this.plugin.settings.cslStyleUrlTemplate =
                                STYLE_SOURCE_PRESETS[value] as string;
                            await this.plugin.saveSettings();
                            this.refreshUI();
                        });
                })
                .addText((text) => {
                    text.setPlaceholder("https://…/{id}")
                        .setValue(this.plugin.settings.cslStyleUrlTemplate)
                        .onChange(async (value) => {
                            if (!value.includes("{id}")) return;
                            this.plugin.settings.cslStyleUrlTemplate =
                                value.trim();
                            await this.plugin.saveSettings();
                        });
                });
        });

        group.addSetting((setting) => {
            setting
                .setName("Locale download source")
                .setDesc(
                    "Where locale XML is fetched from. {lang} is replaced with the locale tag.",
                )
                .addDropdown((dropdown) => {
                    const current = this.plugin.settings.cslLocaleUrlTemplate;
                    const preset =
                        Object.entries(LOCALE_SOURCE_PRESETS).find(
                            ([, v]) => v === current,
                        )?.[0] ?? "custom";
                    dropdown
                        .addOption("github", "GitHub (CSL locales repo)")
                        .addOption("jsdelivr", "jsDelivr")
                        .addOption("custom", "Custom URL template")
                        .setValue(preset)
                        .onChange(async (value) => {
                            if (value === "custom") return;
                            this.plugin.settings.cslLocaleUrlTemplate =
                                LOCALE_SOURCE_PRESETS[value] as string;
                            await this.plugin.saveSettings();
                            this.refreshUI();
                        });
                })
                .addText((text) => {
                    text.setPlaceholder("https://…/locales-{lang}.xml")
                        .setValue(this.plugin.settings.cslLocaleUrlTemplate)
                        .onChange(async (value) => {
                            if (!value.includes("{lang}")) return;
                            this.plugin.settings.cslLocaleUrlTemplate =
                                value.trim();
                            await this.plugin.saveSettings();
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
                    "Remove all downloaded styles, locales and the style index. Pasted and folder styles are kept.",
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
