import { services } from "services/services";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Declarative settings for reader integration, behavior, and appearance. */
export class ReaderSection {
    constructor(private readonly plugin: ZotFlow) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Integration",
                items: [
                    {
                        name: "Overwrite PDF/EPUB/HTML Viewer",
                        desc: "Overwrite PDF/EPUB/HTML viewer with local Zotero reader (Requires Restart).",
                        control: {
                            type: "toggle",
                            key: "overwriteViewer",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Annotation Tools",
                items: [
                    {
                        name: "Turn off note, text, and image annotation tools after each use",
                        desc: "When enabled, the note, text, and image tools automatically revert to the pointer after creating an annotation. Requires restart Reader to apply.",
                        control: {
                            type: "toggle",
                            key: "autoDisableNoteImageTextTools",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Appearance",
                items: [
                    {
                        name: "Ebook Font",
                        desc: "Custom font family for EPUB documents. Leave empty to use the book's own font. This description text renders in the selected font as a live preview. Requires restart Reader to apply.",
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("e.g. Georgia, serif")
                                    .setValue(
                                        this.plugin.settings.epubFontFamily,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.epubFontFamily =
                                            value;
                                        setting.descEl.style.fontFamily =
                                            value || "";
                                        await this.plugin.saveSettings();
                                    });
                            });
                            setting.descEl.style.fontFamily =
                                this.plugin.settings.epubFontFamily || "";
                        },
                    },
                    {
                        name: "Reader UI Color Scheme",
                        desc: "Color scheme for the Zotero Reader UI.",
                        control: {
                            type: "dropdown",
                            key: "readerColorScheme",
                            options: {
                                light: "Light",
                                dark: "Dark",
                                obsidian: "Adapt to Obsidian Scheme",
                                "obsidian-theme":
                                    "Adapt to Obsidian Scheme (Theme)",
                            },
                        },
                    },
                    {
                        name: "Default Viewer Light Theme",
                        desc: "Default viewer theme when the reader is in light mode.",
                        control: {
                            type: "dropdown",
                            key: "defaultLightTheme",
                            options: this.getThemeOptions(false),
                        },
                    },
                    {
                        name: "Default Viewer Dark Theme",
                        desc: "Default viewer theme when the reader is in dark mode.",
                        control: {
                            type: "dropdown",
                            key: "defaultDarkTheme",
                            options: this.getThemeOptions(true),
                        },
                    },
                ],
            },
        ];
    }

    private getThemeOptions(includeObsidian: boolean): Record<string, string> {
        const options: [string, string][] = [
            ["original_fallback", "Original"],
            ["dark", "Dark"],
            ["snow", "Snow"],
            ["sepia", "Sepia"],
        ];
        if (includeObsidian) options.push(["obsidian", "Obsidian"]);
        for (const theme of services.viewStateService.getCustomThemes()) {
            options.push([theme.id, theme.label]);
        }
        return Object.fromEntries(options);
    }
}
