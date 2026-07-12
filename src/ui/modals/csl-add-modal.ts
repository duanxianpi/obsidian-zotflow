import { ButtonComponent, Modal, sanitizeHTMLToDom, Setting } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type { App } from "obsidian";
import type { LocalePreview, StylePreview } from "worker/csl";

/** Skeleton width modifier classes, cycled so the bars look organic. */
const SKELETON_WIDTHS = ["w60", "w35", "w50", "w80", "w70"] as const;

/**
 * Build a label/value info card. Rows start as skeleton bars (so the modal
 * keeps its final footprint before anything is fetched) and are filled in
 * once data arrives.
 */
class InfoCard {
    private rows = new Map<string, HTMLElement>();

    constructor(
        private cardEl: HTMLElement,
        labels: string[],
    ) {
        cardEl.addClass("zotflow-csl-modal-card");
        labels.forEach((label, i) => {
            const row = cardEl.createDiv("zotflow-csl-modal-row");
            row.createSpan({ cls: "zotflow-csl-modal-label", text: label });
            const value = row.createSpan("zotflow-csl-modal-value");
            value.createSpan(
                `zotflow-csl-skeleton zotflow-csl-skeleton--${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}`,
            );
            this.rows.set(label, value);
        });
    }

    set(label: string, text: string): void {
        const value = this.rows.get(label);
        if (!value) return;
        value.empty();
        value.setText(text);
    }

    /** Reset every row back to its skeleton bar. */
    reset(): void {
        let i = 0;
        for (const value of this.rows.values()) {
            value.empty();
            value.createSpan(
                `zotflow-csl-skeleton zotflow-csl-skeleton--${SKELETON_WIDTHS[i++ % SKELETON_WIDTHS.length]}`,
            );
        }
    }
}

/**
 * BRAT-style "add by id" modal: the user enters a style id (or full URL)
 * from https://www.zotero.org/styles/, the style is fetched and its basic
 * info plus a rendered sample shown, and Add installs it together with its
 * dependency chain and default locale. Unpublished custom styles go in the
 * vault styles folder instead.
 */
export class AddCslStyleModal extends Modal {
    private preview: StylePreview | null = null;
    private info!: InfoCard;
    private noticeEl!: HTMLElement;
    private previewEl!: HTMLElement;
    private addBtn!: ButtonComponent;
    private busy = false;

    constructor(
        app: App,
        private onAdded: () => void,
    ) {
        super(app);
        this.setTitle("Add citation style");
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass("zotflow-csl-add-modal");

        let input = "";
        const doFetch = () => void this.fetchPreview(input);

        new Setting(contentEl)
            .setName("Style ID or URL")
            .setDesc(
                createFragment((f) => {
                    f.appendText("Find styles in the ");
                    f.createEl("a", {
                        text: "Zotero style repository",
                        href: "https://www.zotero.org/styles/",
                    });
                    f.appendText(" — e.g. nature or apa.");
                }),
            )
            .addText((text) => {
                text.setPlaceholder("Example: nature").onChange((v) => {
                    input = v;
                });
                text.inputEl.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") doFetch();
                });
            })
            .addButton((btn) => {
                btn.setButtonText("Fetch").setCta().onClick(doFetch);
            });

        this.info = new InfoCard(
            contentEl.createDiv("zotflow-csl-modal-info"),
            ["Title", "ID", "Type", "Default locale", "Source"],
        );
        this.noticeEl = contentEl.createDiv("zotflow-csl-modal-notice");

        this.previewEl = contentEl.createDiv(
            "zotflow-csl-modal-card zotflow-csl-modal-preview",
        );
        this.renderPreviewSkeleton();

        const buttons = new Setting(contentEl).setClass(
            "zotflow-csl-modal-buttons",
        );
        buttons.addButton((btn) => {
            btn.setButtonText("Cancel").onClick(() => this.close());
        });
        buttons.addButton((btn) => {
            this.addBtn = btn;
            btn.setButtonText("Add")
                .setCta()
                .setDisabled(true)
                .onClick(() => void this.add());
        });
    }

    private renderPreviewSkeleton(): void {
        this.previewEl.empty();
        this.previewEl.createDiv({
            cls: "zotflow-csl-modal-card-heading",
            text: "Preview",
        });
        for (const width of ["w80", "w35", "w70", "w60"]) {
            this.previewEl
                .createDiv("zotflow-csl-modal-row")
                .createSpan(
                    `zotflow-csl-skeleton zotflow-csl-skeleton--${width}`,
                );
        }
    }

    private renderPreviewSample(p: StylePreview): void {
        this.previewEl.empty();
        this.previewEl.createDiv({
            cls: "zotflow-csl-modal-card-heading",
            text: "Preview",
        });
        if (!p.sample) {
            this.previewEl.createDiv({
                cls: "zotflow-csl-modal-muted",
                text: "No rendered preview is available for this style.",
            });
            return;
        }
        if (p.sample.citations.length > 0) {
            const cite = this.previewEl.createDiv("zotflow-csl-modal-citation");
            // Citation strings are HTML-encoded (e.g. "&#38;").
            cite.appendChild(
                sanitizeHTMLToDom(p.sample.citations.join("&#8195;")),
            );
        }
        const bib = this.previewEl.createDiv("zotflow-csl-modal-bib");
        bib.appendChild(sanitizeHTMLToDom(p.sample.bibliographyHtml));
    }

    private setLoading(loading: boolean): void {
        this.contentEl.toggleClass("is-loading", loading);
    }

    private async fetchPreview(input: string): Promise<void> {
        if (!input.trim() || this.busy) return;
        this.busy = true;
        this.preview = null;
        this.addBtn.setDisabled(true);
        this.noticeEl.empty();
        this.info.reset();
        this.renderPreviewSkeleton();
        this.setLoading(true);
        try {
            this.preview = await workerBridge.cslRender.previewStyle(input);
            const p = this.preview;
            this.info.set("Title", p.title ?? "(untitled)");
            this.info.set("ID", p.id);
            this.info.set(
                "Type",
                p.dependent
                    ? `dependent (parent: ${p.parent ?? "unknown"})`
                    : "independent",
            );
            this.info.set("Default locale", p.defaultLocale ?? "—");
            this.info.set("Source", p.sourceUrl);
            if (p.alreadyInstalled) {
                this.noticeEl.createDiv({
                    cls: "zotflow-csl-modal-warning",
                    text: "A style with this id is already installed — adding will overwrite it.",
                });
            }
            this.renderPreviewSample(p);
            this.addBtn.setDisabled(false);
        } catch (e) {
            services.logService.error(
                `Failed to fetch style "${input}"`,
                "AddCslStyleModal",
                e,
            );
            this.info.reset();
            this.noticeEl.createDiv({
                cls: "zotflow-csl-modal-error",
                text: `Could not fetch "${input.trim()}" — check the id and your connection.`,
            });
        } finally {
            this.setLoading(false);
            this.busy = false;
        }
    }

    private async add(): Promise<void> {
        if (!this.preview || this.busy) return;
        this.busy = true;
        this.addBtn.setDisabled(true).setButtonText("Adding…");
        try {
            const avail = await workerBridge.cslRender.addStyle(this.preview);
            services.notificationService.notify(
                avail.status === "ready" ? "success" : "warning",
                avail.status === "ready"
                    ? `Style "${this.preview.id}" added`
                    : `Style "${this.preview.id}" added, but not ready yet`,
            );
            this.onAdded();
            this.close();
        } catch (e) {
            services.logService.error(
                `Failed to add style "${this.preview.id}"`,
                "AddCslStyleModal",
                e,
            );
            services.notificationService.notify(
                "error",
                `Failed to add style "${this.preview.id}".`,
            );
            this.addBtn.setDisabled(false).setButtonText("Add");
        } finally {
            this.busy = false;
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** Companion modal for locales: enter a BCP-47 tag, preview, then add. */
export class AddCslLocaleModal extends Modal {
    private preview: LocalePreview | null = null;
    private info!: InfoCard;
    private noticeEl!: HTMLElement;
    private addBtn!: ButtonComponent;
    private busy = false;

    constructor(
        app: App,
        private onAdded: () => void,
    ) {
        super(app);
        this.setTitle("Add locale");
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass("zotflow-csl-add-modal");

        let input = "";
        const doFetch = () => void this.fetchPreview(input);

        new Setting(contentEl)
            .setName("Locale tag")
            .setDesc(
                createFragment((f) => {
                    f.appendText(
                        "Enter a BCP-47 tag such as de-DE, zh-CN or fr-FR. The default locale of a style is downloaded automatically when the style is added.",
                    );
                }),
            )
            .addText((text) => {
                text.setPlaceholder("Example: de-DE").onChange((v) => {
                    input = v;
                });
                text.inputEl.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") doFetch();
                });
            })
            .addButton((btn) => {
                btn.setButtonText("Fetch").setCta().onClick(doFetch);
            });

        this.info = new InfoCard(
            contentEl.createDiv("zotflow-csl-modal-info"),
            ["Locale", "Source"],
        );
        this.noticeEl = contentEl.createDiv("zotflow-csl-modal-notice");

        const buttons = new Setting(contentEl).setClass(
            "zotflow-csl-modal-buttons",
        );
        buttons.addButton((btn) => {
            btn.setButtonText("Cancel").onClick(() => this.close());
        });
        buttons.addButton((btn) => {
            this.addBtn = btn;
            btn.setButtonText("Add")
                .setCta()
                .setDisabled(true)
                .onClick(() => void this.add());
        });
    }

    private async fetchPreview(input: string): Promise<void> {
        if (!input.trim() || this.busy) return;
        this.busy = true;
        this.preview = null;
        this.addBtn.setDisabled(true);
        this.noticeEl.empty();
        this.info.reset();
        this.contentEl.addClass("is-loading");
        try {
            this.preview = await workerBridge.cslRender.previewLocale(input);
            this.info.set("Locale", this.preview.tag);
            this.info.set("Source", this.preview.sourceUrl);
            if (this.preview.alreadyInstalled) {
                this.noticeEl.createDiv({
                    cls: "zotflow-csl-modal-warning",
                    text: "This locale is already installed — adding will refresh it.",
                });
            }
            this.addBtn.setDisabled(false);
        } catch (e) {
            services.logService.error(
                `Failed to fetch locale "${input}"`,
                "AddCslLocaleModal",
                e,
            );
            this.info.reset();
            this.noticeEl.createDiv({
                cls: "zotflow-csl-modal-error",
                text: `Could not fetch locale "${input.trim()}" — check the tag.`,
            });
        } finally {
            this.contentEl.removeClass("is-loading");
            this.busy = false;
        }
    }

    private async add(): Promise<void> {
        if (!this.preview || this.busy) return;
        this.busy = true;
        this.addBtn.setDisabled(true).setButtonText("Adding…");
        try {
            await workerBridge.cslRender.addLocale(this.preview);
            services.notificationService.notify(
                "success",
                `Locale "${this.preview.tag}" added`,
            );
            this.onAdded();
            this.close();
        } catch (e) {
            services.logService.error(
                `Failed to add locale "${this.preview.tag}"`,
                "AddCslLocaleModal",
                e,
            );
            services.notificationService.notify(
                "error",
                `Failed to add locale "${this.preview.tag}".`,
            );
            this.addBtn.setDisabled(false).setButtonText("Add");
        } finally {
            this.busy = false;
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
