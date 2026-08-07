import { services } from "services/services";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Declarative settings for source notes, attachments, and the reader. */
export class GeneralSection {
    constructor(private readonly plugin: ZotFlow) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Library Source Note",
                items: [
                    {
                        name: "Template Path",
                        desc: "Path to template file for library source notes (relative to vault root).",
                        control: {
                            type: "text",
                            key: "librarySourceNoteTemplatePath",
                            placeholder: "e.g. templates/SourceNoteTemplate.md",
                        },
                    },
                    {
                        name: "Library Source Note Path Template",
                        desc: "LiquidJS template for library source note file path (without .md extension).",
                        control: {
                            type: "text",
                            key: "librarySourceNotePathTemplate",
                            placeholder:
                                "e.g. References/{{libraryName}}/@{{citationKey | default: key}}",
                        },
                    },
                    {
                        name: "Convert Item Note Links",
                        desc: "Show links inside item notes as ZotFlow links in Obsidian while storing and syncing them as native Zotero links — clicks open ZotFlow's reader here and Zotero's reader there.",
                        control: {
                            type: "toggle",
                            key: "convertNoteLinks",
                        },
                    },
                    {
                        name: "Lock Editable Regions by Default",
                        desc: "When enabled, editable regions in source notes start locked. Click the lock icon on a region to unlock it for editing.",
                        control: {
                            type: "toggle",
                            key: "defaultEditableRegionLocked",
                        },
                    },
                    {
                        name: "Hide Editable Region Markers",
                        desc: "Hide the ZF_NOTE and ZF_PERSIST comment tags in source notes. The lock icon and region border remain visible.",
                        control: {
                            type: "toggle",
                            key: "hideEditableRegionMarkers",
                        },
                    },
                    {
                        name: "Always Open Child Notes in Note Editor",
                        desc: "When enabled, child notes always open in the standalone Note Editor view (experimental). When disabled (default), child notes open in their parent's source note, scrolled to the note's editable region.",
                        control: {
                            type: "toggle",
                            key: "alwaysOpenChildNoteInEditor",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Local Source Note",
                items: [
                    {
                        name: "Source Note Template Path",
                        desc: "Path to template file for local source notes (relative to vault root).",
                        control: {
                            type: "text",
                            key: "localSourceNoteTemplatePath",
                            placeholder:
                                "e.g. templates/LocalSourceNoteTemplate.md",
                        },
                    },
                    {
                        name: "Local Source Note Path Template",
                        desc: "LiquidJS template for local source note file path (without .md extension).",
                        control: {
                            type: "text",
                            key: "localSourceNotePathTemplate",
                            placeholder: "e.g. Local/@{{basename}}",
                        },
                    },
                    {
                        name: "Annotation Sidecar Folder",
                        desc: "Folder for local annotation sidecar files (.zf.json), relative to vault root. Leave empty to store sidecars next to each attachment. When set, the original folder structure is mirrored under this folder to avoid filename collisions.",
                        control: {
                            type: "text",
                            key: "localSidecarFolder",
                            placeholder: "e.g. .zotflow/sidecars",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Linked Attachments",
                items: [
                    {
                        name: "Linked Attachment Base Directory",
                        desc: 'Absolute path to the base directory for Zotero linked attachments (LABD). Set this to match the "Linked Attachment Base Directory" configured in Zotero (Preferences → Advanced → Files and Folders). Required for opening attachments whose path starts with "attachments:".',
                        control: {
                            type: "text",
                            key: "linkedAttachmentBaseDir",
                            placeholder:
                                "e.g. D:\\Papers or /Users/name/Papers",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "General Settings",
                items: [
                    {
                        name: "Open Items on Single Click",
                        desc: "In the tree view, clicking an item's title directly opens it (source note, attachment, or note preview) and only the chevron expands/collapses. When disabled, a click toggles expansion and a double click opens attachments and notes.",
                        control: {
                            type: "toggle",
                            key: "treeSingleClickOpen",
                        },
                    },
                    {
                        name: "Auto Import Annotation Images",
                        desc: "Auto import annotation images for area and ink annotations from PDF when creating source notes.",
                        control: {
                            type: "toggle",
                            key: "autoImportAnnotationImages",
                        },
                    },
                    {
                        name: "Annotation Image Folder",
                        desc: "Default folder for annotation images (relative to vault root).",
                        control: {
                            type: "text",
                            key: "annotationImageFolder",
                            placeholder: "e.g. Attachments/ZotFlow",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Zotero Reader",
                items: [
                    {
                        name: "Overwrite PDF/EPUB/HTML Viewer",
                        desc: "Overwrite PDF/EPUB/HTML viewer with local Zotero reader (Requires Restart).",
                        control: {
                            type: "toggle",
                            key: "overwriteViewer",
                        },
                    },
                    {
                        name: "Turn off note, text, and image annotation tools after each use",
                        desc: "When enabled, the note, text, and image tools automatically revert to the pointer after creating an annotation. Requires restart Reader to apply.",
                        control: {
                            type: "toggle",
                            key: "autoDisableNoteImageTextTools",
                        },
                    },
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
