import { TFile } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "./services";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { CitationFormat } from "settings/types";
import type { AnnotationJSON } from "types/zotero-reader";

/**
 * Release note explaining the footnote definition template redesign.
 * TODO: replace with the final release note URL once published.
 */
const FOOTNOTE_TEMPLATE_MIGRATION_URL =
    "https://zotflow.peterduan.dev/releases/1.2.1";

/** A Zotero item bundled with its optional annotations for citation. */
export interface CitationTemplateInput {
    item: AnyIDBZoteroItem;
    annotations?: AnnotationJSON[];
}

/** Result of citation generation for a single item. */
export interface CitationResult {
    /** Inline citation text (e.g., `[@key]`, `[^key]`, `[[note]]`). */
    citation: string;
    /** Citation key (e.g., `smith2024` or item key). */
    citekey: string;
    /** Footnote definition line (only for footnote format). */
    footnoteDef?: string;
}

/** Minimal reference to a Zotero item for citation resolution. */
export interface CitationRef {
    libraryID: number;
    key: string;
    annotations?: AnnotationJSON[];
}

/** Generates citation strings for Zotero items. */
export class CitationService {
    /**
     * Resolve a citation from a minimal item reference.
     * Fetches the item from DB, ensures a source note exists, and generates
     * the citation string. This is the single entry point for all citation
     * generation — used by CitationSuggest, drop handler, and future copy handler.
     */
    async resolve(
        ref: CitationRef,
        format: CitationFormat,
    ): Promise<CitationResult | null> {
        const item = await workerBridge.dbHelper.getItem(
            ref.libraryID,
            ref.key,
        );
        if (!item) {
            services.logService.error(
                `Item not found: ${ref.libraryID}/${ref.key}`,
                "CitationService",
            );
            return null;
        }

        const input: CitationTemplateInput = {
            item,
            annotations: ref.annotations || [],
        };

        // Resolve note path (cache hit → instant, miss → quick-create stub)
        const notePath =
            services.indexService.getFileByKey(item.key)?.path ??
            (await workerBridge.libraryNote.ensureNotePath(
                item.libraryID,
                item.key,
            ));

        if (!notePath) {
            services.logService.error(
                `Unable to resolve or create source note for item ${item.libraryID}/${item.key}`,
                "CitationService",
            );
            return null;
        }

        try {
            switch (format) {
                case "pandoc":
                    return await this.pandoc(input, notePath);
                case "wikilink":
                    return await this.wikilink(input, notePath);
                case "footnote":
                    return await this.footnote(input, notePath);
                case "citekey":
                    return this.citekey(input);
            }
        } catch (error) {
            services.logService.error(
                `Error generating citation for item ${item.libraryID}/${item.key}: ${error}`,
                "CitationService",
                error,
            );
            return null;
        }
    }

    /** `[@citekey]` — template-rendered or hardcoded fallback. */
    private async pandoc(
        input: CitationTemplateInput,
        notePath: string,
    ): Promise<CitationResult> {
        const citekey = input.item.citationKey || input.item.key;
        const rendered =
            await workerBridge.libraryTemplate.renderCitationTemplate(
                input,
                notePath,
                "pandoc",
            );
        if (rendered) {
            return { citation: rendered, citekey };
        }

        // Fallback: simple `[@citekey]`
        return { citation: `[@${citekey}]`, citekey };
    }

    /** `@citekey` — raw citation key only. */
    private citekey(input: CitationTemplateInput): CitationResult {
        const citekey = input.item.citationKey || input.item.key;
        return { citation: `@${citekey}`, citekey };
    }

    /** Wikilink: template-rendered or `generateMarkdownLink` fallback. */
    private async wikilink(
        input: CitationTemplateInput,
        notePath: string,
    ): Promise<CitationResult> {
        const citekey = input.item.citationKey || input.item.key;

        const rendered =
            await workerBridge.libraryTemplate.renderCitationTemplate(
                input,
                notePath,
                "wikilink",
            );
        if (rendered) {
            return { citation: rendered, citekey };
        }
        services.logService.warn(
            `Wikilink template failed for item ${input.item.libraryID}/${input.item.key}, falling back to generateMarkdownLink.`,
            "CitationService",
        );

        // Fallback: generateMarkdownLink
        const file = services.app.vault.getAbstractFileByPath(notePath);
        if (file instanceof TFile) {
            const link = services.app.fileManager.generateMarkdownLink(
                file,
                "",
                "",
                file.name.split(".").shift(),
            );
            return { citation: link, citekey };
        }

        services.logService.error(
            `Failed to find source note file at ${notePath} for item ${input.item.libraryID}/${input.item.key}.`,
            "CitationService",
        );
        return { citation: `[[@${citekey}]]`, citekey };
    }

    /**
     * Footnote citation. The inline reference and the definition are rendered
     * from separate templates that share the SAME annotation context, so a
     * template that loops over annotations can emit matching `[^marker]`
     * references and `[^marker]:` definitions and keep them aligned itself.
     */
    private async footnote(
        input: CitationTemplateInput,
        notePath: string,
    ): Promise<CitationResult> {
        const citekey = input.item.citationKey || input.item.key;

        // Inline reference — rendered with annotation context (e.g. page number)
        const rendered =
            await workerBridge.libraryTemplate.renderCitationTemplate(
                input,
                notePath,
                "footnote-ref",
            );
        const citation = rendered || `[^${citekey}]`;

        // Definition — rendered with the SAME annotation context as the
        // reference, so the template can produce one aligned definition per
        // annotation and own the `[^marker]:` markers itself.
        const footnoteDef = await this.footnoteDef(
            input,
            notePath,
            citekey,
            citation,
        );
        return { citation, citekey, footnoteDef };
    }

    /**
     * Render the footnote definition via the template service.
     *
     * If the rendered template already produces footnote definition marker(s)
     * (`[^marker]:`), it is trusted to have handled marker alignment itself and
     * returned verbatim. Otherwise — for legacy body-only templates — a single
     * `[^marker]:` prefix is prepended, using the marker from the rendered
     * reference (falling back to the citekey).
     */
    private async footnoteDef(
        input: CitationTemplateInput,
        notePath: string,
        citekey: string,
        reference: string,
    ): Promise<string | undefined> {
        const rendered =
            await workerBridge.libraryTemplate.renderCitationTemplate(
                input,
                notePath,
                "footnote",
            );
        if (!rendered) return undefined;

        // Template already emitted definition marker(s) → trust its alignment.
        if (/\[\^[^\]]+\]:/.test(rendered)) {
            return rendered;
        }

        // Legacy body-only template → prepend a single aligned marker.
        this.warnLegacyFootnoteTemplate();
        const marker = extractFirstFootnoteMarker(reference) ?? citekey;
        return `[^${marker}]: ${rendered}`;
    }

    /**
     * Warn that the footnote definition template predates the template-owned
     * marker redesign and should be updated to emit its own `[^marker]:` prefix
     * (see release notes).
     *
     * Fires on every legacy render rather than once per session, deliberately:
     * each occurrence is a citation that just went into a note with a
     * prepended marker, so the nudge stays tied to the thing it is about.
     */
    private warnLegacyFootnoteTemplate(): void {
        services.notificationService.notify(
            "warning",
            "Your Footnote Definition Template is using the legacy format. Update it to include the [^marker]: prefix so definitions align with references. ",
            {
                text: "Learn more",
                href: FOOTNOTE_TEMPLATE_MIGRATION_URL,
            },
        );
    }
}

/**
 * Extract the first footnote reference marker from rendered text.
 * e.g. `foo [^smith2024-p13]` → `smith2024-p13`. Returns `null` if none found.
 */
function extractFirstFootnoteMarker(text: string): string | null {
    const match = text.match(/\[\^([^\]]+)\]/);
    return match?.[1] ?? null;
}
