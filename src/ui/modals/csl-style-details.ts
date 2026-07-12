import { sanitizeHTMLToDom, setIcon } from "obsidian";

import type { StyleSample } from "worker/csl";

/**
 * Everything the shared StyleDetails block needs to render. Built from a
 * StylePreview (Add modal) or a StyleInfo + parent lookup (Details modal) so
 * both surfaces stay in sync.
 */
export interface StyleDetailsMeta {
    id: string;
    title?: string;
    /** Effective citation-format (own, or inherited from the parent). */
    citationFormat?: string;
    /** True when citationFormat comes from the parent style. */
    formatInherited?: boolean;
    /** Effective <bibliography> presence; undefined = unknown, don't guess. */
    hasBibliography?: boolean;
    defaultLocale?: string;
    source: "remote" | "folder";
    /** Remote styles: exact download URL. */
    sourceUrl?: string;
    /** Folder styles: vault-relative file path. */
    filePath?: string;
    /** Aliases: slug of the parent style. */
    aliasOf?: string;
    /** Parents: number of installed aliases pointing at this style. */
    aliasCount?: number;
}

/** Compact relative timestamp: "just now", "5m ago", "2h ago", "3d ago", date. */
export function fmtRelativeTime(ms: number): string {
    const delta = Date.now() - ms;
    if (delta < 60_000) return "just now";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
    return new Date(ms).toLocaleDateString();
}

/** Neutral pill for the citation-format category ("author-date", "numeric", …). */
export function createFormatBadge(
    format: string | undefined,
    inherited?: boolean,
): HTMLElement {
    const el = createSpan(
        `zotflow-csl-fbadge${format ? "" : " zotflow-csl-fbadge--pending"}`,
    );
    el.setText(format ?? "pending");
    if (format && inherited) {
        el.appendText(" ↖");
        el.setAttr("title", "Format inherited from parent style");
    }
    return el;
}

/**
 * Neutral capability badges for the Output dimension. <citation> is always
 * present in a usable style, so it is shown whenever the capabilities are
 * known; "bib" appears only when the style declares a <bibliography> —
 * note-only styles read as "citation without bib" at a glance. Unknown
 * (alias whose parent is not installed) renders nothing rather than a guess.
 */
export function appendOutputBadges(
    parent: HTMLElement,
    hasBibliography: boolean | undefined,
): void {
    if (hasBibliography === undefined) return;
    // Lowercase on purpose: these are capability tokens, not UI sentences.
    const citation = parent.createSpan("zotflow-csl-fbadge");
    citation.appendText("citation");
    citation.setAttr("title", "Produces in-text/footnote citations");
    if (hasBibliography) {
        const bib = parent.createSpan("zotflow-csl-fbadge");
        bib.appendText("bib");
        bib.setAttr("title", "Produces a bibliography (reference list)");
    }
}

export interface StyleDetailsHandle {
    /** Switch the preview block to pulsing skeleton bars. */
    setSampleLoading(): void;
    /** Fill the preview block (undefined = no sample published). */
    setSample(sample: StyleSample | undefined): void;
}

export interface StyleDetailsOptions {
    /**
     * Render the alias-of / alias-count relationship notes (default true).
     * The Add modal disables this: it shows its own download-impact note
     * for aliases, and repeating the relationship would be noise.
     */
    dependencyNotes?: boolean;
}

/**
 * Shared StyleDetails block: metadata table + dependency relationship +
 * rendered preview. Used by both the Add modal and the Details modal so the
 * two never drift apart.
 */
export function renderStyleDetails(
    containerEl: HTMLElement,
    meta: StyleDetailsMeta,
    options?: StyleDetailsOptions,
): StyleDetailsHandle {
    /* ---- metadata table ---- */
    const table = containerEl.createDiv("zotflow-csl-details-table");
    const row = (label: string, fill: (valueEl: HTMLElement) => void) => {
        const rowEl = table.createDiv("zotflow-csl-details-row");
        rowEl.createSpan({ cls: "zotflow-csl-details-label", text: label });
        fill(rowEl.createSpan("zotflow-csl-details-value"));
    };

    row("Title", (v) => v.setText(meta.title ?? "(untitled)"));
    row("ID", (v) => {
        v.addClass("zotflow-csl-mono");
        v.setText(meta.id);
    });
    row("Type", (v) =>
        v.appendChild(createFormatBadge(meta.citationFormat, meta.formatInherited)),
    );
    row("Output", (v) => {
        appendOutputBadges(v, meta.hasBibliography);
        if (meta.hasBibliography === undefined) {
            v.createSpan({ cls: "zotflow-csl-muted", text: "—" });
        }
    });
    row("Default locale", (v) => {
        v.addClass("zotflow-csl-mono");
        v.setText(meta.defaultLocale ?? "en-US");
    });
    row("Source", (v) => {
        if (meta.source === "folder") {
            v.setText(meta.filePath ?? "your styles folder");
            return;
        }
        const link = v.createEl("a", {
            cls: "zotflow-csl-details-link",
            text: meta.sourceUrl ?? meta.id,
            href: meta.sourceUrl ?? `https://www.zotero.org/styles/${meta.id}`,
        });
        const icon = link.createSpan("zotflow-csl-inline-icon");
        setIcon(icon, "external-link");
    });

    /* ---- dependency relationship ---- */
    const dependencyNotes = options?.dependencyNotes ?? true;
    if (dependencyNotes && meta.aliasOf) {
        const note = containerEl.createDiv("zotflow-csl-details-note");
        const icon = note.createSpan("zotflow-csl-inline-icon");
        setIcon(icon, "corner-down-right");
        const text = note.createSpan();
        text.appendText("Alias of ");
        text.createSpan({ cls: "zotflow-csl-strong", text: meta.aliasOf });
        text.appendText(". Formatting and updates come from the parent style.");
    }
    if (dependencyNotes && meta.aliasCount && meta.aliasCount > 0) {
        containerEl.createDiv({
            cls: "zotflow-csl-details-note zotflow-csl-details-note--quiet",
            text: `${meta.aliasCount} journal ${meta.aliasCount === 1 ? "alias points" : "aliases point"} to this style.`,
        });
    }

    /* ---- preview (heading sits outside the border, per ZotFlow UI) ---- */
    containerEl.createDiv({
        cls: "zotflow-csl-modal-card-heading",
        text: "Preview",
    });
    const preview = containerEl.createDiv(
        "zotflow-csl-modal-card zotflow-csl-modal-preview",
    );
    const body = preview.createDiv("zotflow-csl-preview-body");

    const renderSkeleton = (loading: boolean) => {
        body.empty();
        body.toggleClass("is-loading", loading);
        for (const width of ["w80", "w35", "w70"]) {
            body.createDiv("zotflow-csl-modal-row").createSpan(
                `zotflow-csl-skeleton zotflow-csl-skeleton--${width}`,
            );
        }
    };
    renderSkeleton(false);

    const noteOnly = meta.hasBibliography === false;

    return {
        setSampleLoading: () => renderSkeleton(true),
        setSample: (sample) => {
            body.empty();
            body.removeClass("is-loading");
            if (!sample) {
                body.createDiv({
                    cls: "zotflow-csl-modal-muted",
                    text: "No rendered preview is available for this style.",
                });
            } else {
                if (sample.citations.length > 0) {
                    const cite = body.createDiv("zotflow-csl-modal-citation");
                    // Citation strings are HTML-encoded (e.g. "&#38;").
                    cite.appendChild(
                        sanitizeHTMLToDom(sample.citations.join("&#8195;")),
                    );
                }
                if (sample.bibliographyHtml.trim()) {
                    body.createDiv("zotflow-csl-modal-bib").appendChild(
                        sanitizeHTMLToDom(sample.bibliographyHtml),
                    );
                }
            }
            if (noteOnly) {
                body.createDiv({
                    cls: "zotflow-csl-modal-muted",
                    text: "This style produces footnote citations only — no reference list, so a bibliography preview is empty.",
                });
            }
        },
    };
}
