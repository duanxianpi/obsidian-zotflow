import { Liquid } from "liquidjs";
import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import { db, getCombinations } from "db/db";
import type {
    ItemTemplateContext,
    NoteTemplateContext,
    AnnotationTemplateContext,
    AttachmentTemplateContext,
    RelatedItemTemplateContext,
} from "types/template-context";
import type { IParentProxy } from "bridge/types";
import type {
    AnnotationData,
    AttachmentData,
    NoteData,
} from "types/zotero-item";
import type { ZotFlowSettings } from "settings/types";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import {
    zoteroLibraryPrefix,
    zoteroOpenPdfUri,
    zoteroSelectItemUri,
} from "utils/zotero-uri";
import { getAnnotationJson } from "db/annotation";
import type { AnnotationJSON } from "types/zotero-reader";
import type { DbHelperService } from "./db-helper";
import type { ConvertService } from "./convert";
import type { Html2MdOptions } from "worker/convert";
import type { NotePathService } from "./note-path";
import type { CitationTemplateInput } from "services/citation-service";
import type { CslRenderWorkerService } from "./csl-render";
import type { ZoteroAPIService } from "./zotero";
import type { CSLItem, OutputFormat, RenderOptions } from "worker/csl";
import { extractYear } from "utils/date";

const DEFAULT_ITEM_TEMPLATE = `---
citationKey: {{ item.citationKey | json }}
title: {{ item.title | json }}
itemType: {{ item.itemType | json }}
creators: [{% for c in item.creators %}"{{ c.name }}"{% unless forloop.last %}, {% endunless %}{% endfor %}]
publication: {{ item.publicationTitle | default: item.publisher | json }}
date: {{ item.date | json }}
year: {{ item.year }}
url: {{ item.url | json }}
doi: {{ item.DOI | json }}
tags: [{% for t in item.tags %}"#{{ t.tag | replace: " ", "\_" }}"{% unless forloop.last %}, {% endunless %}{% endfor %}]
---
{%- capture quote_string %}{{ newline }}> {% endcapture -%}
{%- capture quote_string_2 %}{{ newline }}> >{% endcapture -%}
# {{ item.title }}
{%- if item.abstractNote -%}
## Abstract
> {{ item.abstractNote | replace: newline, quote_string }}

{%- endif -%}
{%- if item.attachments.length > 0 -%}
## Attachments
{%- for attachment in item.attachments -%}
- [{{ attachment.filename }}]({{ attachment | attachment_link }})
{%- endfor -%}

{%- endif -%}
## Notes
{%- if item.notes.length > 0 -%}
{%- for note in item.notes -%}
{{ note.note | html2md | wrap_editable: "NOTE", note.key }}

{%- endfor -%}
{%- endif -%}
{%- if item.attachments.length > 0 and item.attachmentAnnotations.length > 0 -%}
## Annotations
{%- for attachment in item.attachments -%}
{%- if attachment.annotations.length > 0 -%}
### {{ attachment.filename }}
{%- for annotation in attachment.annotations -%}
> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] [{{ attachment.filename }}, p.{{ annotation.pageLabel }}]({{ annotation | annotation_link }})
{%- if annotation.type == "ink" or annotation.type == "image"-%}
> > ![[{{settings.annotationImageFolder}}/{{ annotation.key }}.png]]
{%- else -%}
> > {{ annotation.text | replace: newline, quote_string_2 }}
{%- endif -%}
>
> {{ annotation.comment | wrap_editable: "ANNO", annotation.key | replace: newline, quote_string }}
> {% if annotation.tags and annotation.tags.length > 0 -%} {% for t in annotation.tags %}#{{ t.tag | replace: " ", "\_" }}{% unless forloop.last %} {% endunless %}{% endfor %} {%- endif %}
^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
{%- endfor -%}
{%- endif -%}
{%- if item.attachments.length == 0 and item.itemType == "attachment" and item.annotations.length > 0 -%}
## Annotations
{%- for annotation in item.annotations -%}
> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] [{{ item.title }}, p.{{ annotation.pageLabel }}]({{ annotation | annotation_link }})
{%- if annotation.type == "ink" or annotation.type == "image"-%}
> > ![[{{settings.annotationImageFolder}}/{{ annotation.key }}.png]]
{%- else -%}
> > {{ annotation.text | replace: newline, quote_string_2 }}
{%- endif -%}
>
> {{ annotation.comment | wrap_editable: "ANNO", annotation.key | replace: newline, quote_string }}
> {% if annotation.tags and annotation.tags.length > 0 -%} {% for t in annotation.tags %}#{{ t.tag | replace: " ", "\_" }}{% unless forloop.last %} {% endunless %}{% endfor %} {%- endif %}
^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
`;

const FALLBACK_WIKILINK_TEMPLATE = `{%- if annotations.size > 0 -%}{%- for annotation in annotations -%}
[[{{ notePath }}#^{{ annotation.key }}|{{ item.creators[0].name | default: "Unknown" }} ({{ item.year }}), p. {{ annotation.pageLabel }}]]{% if forloop.last == false %}, {% endif %}{%- endfor -%}{%- else -%}
[[{{ notePath }}|{{ item.creators[0].name | default: "Unknown" }} ({{ item.year }})]] {%- endif -%}`;

const FALLBACK_PANDOC_TEMPLATE =
    "[@{{ item.citationKey | default: item.key }}{% if annotations.size > 0 %}{% assign pages = annotations | map: 'pageLabel' | compact | uniq | join: ', ' %}{% if pages != empty %}, pp. {{ pages }}{% endif %}{% endif %}]";

const FALLBACK_FOOTNOTE_REF_TEMPLATE =
    "[^{{ item.citationKey | default: item.key }}]";

const FALLBACK_FOOTNOTE_TEMPLATE = `[^{{ item.citationKey | default: item.key }}]: {% if item.creators.length > 1 -%}
{{ item.creators[0].name }} et al. {%- elsif item.creators.length == 1 -%}
 {{ item.creators[0].name }} {%- else -%}
Unknown Author {%- endif -%}, *{{ item.title }}* ({{ item.year }}).`;

// Matches http(s)://zotero.org/{users|groups}/<id>/items/<KEY>
const ZOTERO_URI_RE =
    /^https?:\/\/zotero\.org\/(?:users|groups)\/(\d+)\/items\/([A-Z0-9]+)$/i;

// Valid `format:` values for the citation/bibliography filters.
const CSL_OUTPUT_FORMATS = new Set([
    "text",
    "html",
    "markdown",
    "markdown-pure",
]);

/** LiquidJS template engine for rendering library (Zotero) item source notes. */
export class LibraryTemplateService {
    private engine: Liquid;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private dbHelper: DbHelperService,
        private notePathService: NotePathService,
        private convertService: ConvertService,
        private cslRender: CslRenderWorkerService,
        private zotero: ZoteroAPIService,
    ) {
        this.initialize();
    }

    initialize() {
        this.engine = new Liquid({
            extname: ".md",
            greedy: false,
            globals: {
                newline: "\n",
            },
        });
        this.engine.registerFilter("process_nav_info", (input: string) => {
            const navInfo = {
                annotationID: input,
            };
            return encodeURIComponent(JSON.stringify(navInfo));
        });
        // Link helpers — emit either a ZotFlow protocol URL (opens the built-in
        // reader / source note) or a native Zotero URL. The target is chosen
        // per call via a filter argument.
        const resolveTarget = (arg: unknown): "zotflow" | "zotero" =>
            String(arg).toLowerCase() === "zotero" ? "zotero" : "zotflow";
        const getZoteroPrefix = (ctx: any): string =>
            ctx?.context?.environments?.__zfZoteroLibPrefix || "library";
        this.engine.registerFilter(
            "annotation_link",
            function (this: any, anno: any, target?: string): string {
                if (!anno) return "";
                if (resolveTarget(target) === "zotero") {
                    const prefix = getZoteroPrefix(this);
                    return zoteroOpenPdfUri(
                        prefix,
                        anno.parentItem || "",
                        anno.key,
                    );
                }
                return `obsidian://zotflow?type=open-annotation&libraryID=${anno.libraryID}&key=${anno.key}`;
            },
        );
        this.engine.registerFilter(
            "attachment_link",
            function (this: any, att: any, target?: string): string {
                if (!att) return "";
                if (resolveTarget(target) === "zotero") {
                    const prefix = getZoteroPrefix(this);
                    return zoteroOpenPdfUri(prefix, att.key);
                }
                return `obsidian://zotflow?type=open-attachment&libraryID=${att.libraryID}&key=${att.key}`;
            },
        );
        this.engine.registerFilter(
            "item_link",
            function (this: any, item: any, target?: string): string {
                if (!item) return "";
                if (resolveTarget(target) === "zotero") {
                    const prefix = getZoteroPrefix(this);
                    return zoteroSelectItemUri(prefix, item.key);
                }
                return `obsidian://zotflow?type=open-note&libraryID=${item.libraryID}&key=${item.key}`;
            },
        );

        this.engine.registerFilter(
            "wrap_editable",
            /**
             * Wrap content in ZF_<TYPE>_BEG/END markers so the CM6 editable
             * region extension can mount an editable zone.
             *
             * The filter consults a per-render `__zfReadOnlyKeys: Set<string>`
             * stashed on the Liquid context (populated by `prepareItemContext`)
             * to decide whether the region is actually editable.  When the key
             * is in the set (e.g. an external annotation, different author in
             * a group library), the markers are omitted so the content renders
             * as plain locked text.
             *
             * Falls back to wrapping when the set is absent (e.g. preview /
             * citation render paths that don't prep one), preserving the old
             * behaviour for callers that don't opt in.
             */
            function (this: any, input: string, type: string, key: string) {
                if (!type || !key) return input;
                const readOnlyKeys: Set<string> | undefined =
                    this?.context?.environments?.__zfReadOnlyKeys;
                if (readOnlyKeys && readOnlyKeys.has(`${type}:${key}`)) {
                    return input;
                }
                return `<!-- ZF_${type}_BEG_${key} -->\n${input}\n<!-- ZF_${type}_END_${key} -->`;
            },
        );
        this.engine.registerFilter("html2md", async (input: string) => {
            if (!input) return "";
            const vaultConfig = await this.parentHost.getVaultConfig();
            const opts: Html2MdOptions = {
                annotationImageFolder:
                    this.settings.annotationImageFolder.replace(/\/$/, "") ||
                    undefined,
                strictLineBreaks: vaultConfig.strictLineBreaks,
            };
            return await this.convertService.html2md(input, opts);
        });
        // CSL rendering filters. Input is a context item (or array of them);
        // args are an optional positional style shorthand plus kwargs:
        //   {{ item | citation: "ieee" }}
        //   {{ items | bibliography: style: "apa", locale: "de-DE", format: "text" }}
        // Defaults: style -> settings.cslDefaultStyleId, locale -> style's
        // default-locale -> en-US, format -> settings.cslDefaultFormat.
        // Note: each call is a standalone render, so author disambiguation
        // does not carry across separate citation calls.
        this.engine.registerFilter(
            "citation",
            async (input: unknown, ...args: unknown[]) => {
                const { opts } = this.parseCslRenderArgs(args);
                const items = await this.collectCslItems(input, "citation");
                return this.cslRender.renderCitation(items, opts);
            },
        );
        this.engine.registerFilter(
            "bibliography",
            async (input: unknown, ...args: unknown[]) => {
                const { opts, join } = this.parseCslRenderArgs(args);
                const items = await this.collectCslItems(input, "bibliography");
                const entries = await this.cslRender.renderBibliography(
                    items,
                    opts,
                );
                return entries.join(join);
            },
        );
    }

    /**
     * Parse citation/bibliography filter arguments. LiquidJS passes kwargs
     * as 2-element `[key, value]` arrays; anything else positional is
     * treated as the style shorthand.
     */
    private parseCslRenderArgs(args: unknown[]): {
        opts: RenderOptions;
        join: string;
    } {
        const opts: RenderOptions = {};
        let join = "\n\n";
        for (const arg of args) {
            if (Array.isArray(arg) && arg.length === 2) {
                const [key, value] = arg as [unknown, unknown];
                if (value == null) continue;
                if (typeof value !== "string" && typeof value !== "number") {
                    throw new Error(
                        `The "${String(key)}" argument of the citation/bibliography filter must be a string`,
                    );
                }
                const str = String(value);
                switch (key) {
                    case "style":
                        opts.styleId = str;
                        break;
                    case "locale":
                        opts.locale = str;
                        break;
                    case "format":
                        if (!CSL_OUTPUT_FORMATS.has(str)) {
                            throw new Error(
                                `Unknown CSL output format "${str}" — use text, html, markdown or markdown-pure`,
                            );
                        }
                        opts.format = str as OutputFormat;
                        break;
                    case "join":
                        join = str;
                        break;
                    default:
                        throw new Error(
                            `Unknown argument "${String(key)}" for the citation/bibliography filter — supported: style, locale, format, join`,
                        );
                }
            } else if (typeof arg === "string" && arg.trim()) {
                opts.styleId = arg.trim();
            }
        }
        if (!opts.styleId) opts.styleId = this.settings.cslDefaultStyleId;
        return { opts, join };
    }

    /** Resolve filter input (context item object or array) to CSL-JSON items. */
    private async collectCslItems(
        input: unknown,
        filterName: string,
    ): Promise<CSLItem[]> {
        const refs = Array.isArray(input) ? input : [input];
        if (refs.length === 0) {
            throw new Error(
                `The ${filterName} filter received an empty item list`,
            );
        }
        return Promise.all(refs.map((ref) => this.getCslJson(ref, filterName)));
    }

    private async getCslJson(
        ref: unknown,
        filterName: string,
    ): Promise<CSLItem> {
        const key = (ref as { key?: unknown })?.key;
        const libraryID = (ref as { libraryID?: unknown })?.libraryID;
        if (typeof key !== "string" || typeof libraryID !== "number") {
            throw new Error(
                `The ${filterName} filter needs a Zotero item from the template context (an object with key and libraryID)`,
            );
        }
        let item = await db.items.get([libraryID, key]);
        if (!item) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LibraryTemplateService",
                `Item not found: ${libraryID}/${key}`,
            );
        }
        if (
            item.itemType === "attachment" ||
            item.itemType === "note" ||
            item.itemType === "annotation"
        ) {
            throw new Error(
                `Item "${item.title || key}" is a ${item.itemType} — only regular items can be cited`,
            );
        }
        if (!item.csljson) {
            item = await this.backfillCslJson(item);
        }
        return item.csljson as CSLItem;
    }

    /**
     * Fetch and store the CSL-JSON for an item synced before csljson was
     * part of the pull. One-time cost per item — the stored copy is used
     * afterwards.
     */
    private async backfillCslJson(
        item: AnyIDBZoteroItem,
    ): Promise<AnyIDBZoteroItem> {
        const lib = await db.libraries.get(item.libraryID);
        const libraryType = lib?.type === "group" ? "group" : "user";
        let csljson: Record<string, unknown> | undefined;
        try {
            const res = await this.zotero.client
                .library(libraryType, item.libraryID)
                .items()
                .get({
                    itemKey: item.key,
                    include: "data,csljson",
                    includeTrashed: true,
                });
            csljson = (res.raw as { csljson?: Record<string, unknown> }[])[0]
                ?.csljson;
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "LibraryTemplateService",
                `Couldn't fetch citation data for "${item.title || item.key}" — run a sync or check your connection`,
            );
        }
        if (!csljson) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LibraryTemplateService",
                `Zotero returned no citation data for "${item.title || item.key}"`,
            );
        }
        await db.items.update([item.libraryID, item.key], { csljson });
        item.csljson = csljson;
        return item;
    }

    updateSettings(newSettings: ZotFlowSettings) {
        this.settings = newSettings;
    }

    async renderLibrarySourceNote(
        item: AnyIDBZoteroItem,
        templateContent: string | null,
        originalFrontmatter: Record<string, any> = {},
    ): Promise<string> {
        try {
            const context = await this.prepareItemContext(item);
            const template = templateContent || DEFAULT_ITEM_TEMPLATE;

            // Separate Frontmatter and Body
            const frontmatterRegex = /^---\s*([\s\S]*?)\s*---\n/;
            const match = template.match(frontmatterRegex);

            let templateFrontmatterRaw = "";
            let body = template;

            if (match) {
                templateFrontmatterRaw = match[1] || "";
                body = template.substring(match[0].length);
            } else {
                body = template;
            }

            // Parse Template Frontmatter
            let templateFrontmatter: any = {};
            if (templateFrontmatterRaw.trim()) {
                try {
                    // Render the frontmatter raw string first (as it may contain liquid tags)
                    const renderedFrontmatterRaw =
                        await this.engine.parseAndRender(
                            templateFrontmatterRaw,
                            context,
                        );

                    // Then parse the rendered string as YAML
                    templateFrontmatter = await this.parentHost.parseYaml(
                        renderedFrontmatterRaw,
                    );
                } catch (e) {
                    // We don't throw here, just proceed with empty frontmatter from template
                    this.parentHost.log(
                        "error",
                        "Failed to parse template frontmatter",
                        "LibraryTemplateService",
                    );
                }
            }

            // Merge Frontmatter using the prefix protocol:
            //   `??key` in template => preserve; only written if key absent
            //                          in the existing note's frontmatter
            //   bare `key`          => overwrite (default; refreshed each
            //                          update from the rendered template)
            // The `??` prefix is stripped from the final key.
            const finalFrontmatter: Record<string, any> = {
                ...originalFrontmatter,
            };
            for (const [rawKey, value] of Object.entries(
                templateFrontmatter || {},
            )) {
                const preserve = rawKey.startsWith("??");
                const key = preserve ? rawKey.slice(2) : rawKey;
                if (!key) continue;
                if (preserve) {
                    if (!(key in finalFrontmatter)) {
                        finalFrontmatter[key] = value;
                    }
                } else {
                    finalFrontmatter[key] = value;
                }
            }

            // Ensure Mandatory Fields (always overwritten)
            finalFrontmatter["zotflow-locked"] = true;
            finalFrontmatter["zotero-key"] = item.key;
            finalFrontmatter["item-version"] = item.version;
            finalFrontmatter["library-id"] = item.libraryID;

            // Stringify Frontmatter
            const frontmatterString =
                await this.parentHost.stringifyYaml(finalFrontmatter);

            // Render Body
            const renderedBody = await this.engine.parseAndRender(
                body,
                context,
            );

            return `---\n${frontmatterString}---\n${renderedBody}`;
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.PARSE_ERROR,
                "LibraryTemplateService",
                "Template rendering failed",
            );
        }
    }

    /** Preview-render a library item with the given template content. */
    async previewLibrarySourceNote(
        libraryID: number,
        key: string,
        templateContent: string,
    ): Promise<string> {
        const item = await db.items.get([libraryID, key]);
        if (!item) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LibraryTemplateService",
                `Item not found: ${libraryID}/${key}`,
            );
        }
        return this.renderLibrarySourceNote(item, templateContent, {});
    }

    /** Return the user-configured template file content, or the built-in default. */
    async getDefaultTemplate(): Promise<string> {
        const path = this.settings.librarySourceNoteTemplatePath;
        if (path) {
            try {
                const content = await this.parentHost.readTextFile(path);
                if (content != null) return content;
            } catch {
                // Fall through to default
            }
        }
        return DEFAULT_ITEM_TEMPLATE;
    }

    /** Render a citation template for an item, with notePath in the context. */
    async renderCitationTemplate(
        input: CitationTemplateInput,
        notePath: string,
        format: "pandoc" | "wikilink" | "footnote" | "footnote-ref",
    ): Promise<string> {
        let template: string;
        if (format === "pandoc") {
            template =
                this.settings.citationPandocTemplate.trim() === ""
                    ? FALLBACK_PANDOC_TEMPLATE
                    : this.settings.citationPandocTemplate.trim();
        } else if (format === "wikilink") {
            template =
                this.settings.citationWikilinkTemplate.trim() === ""
                    ? FALLBACK_WIKILINK_TEMPLATE
                    : this.settings.citationWikilinkTemplate.trim();
        } else if (format === "footnote-ref") {
            template =
                this.settings.citationFootnoteRefTemplate.trim() === ""
                    ? FALLBACK_FOOTNOTE_REF_TEMPLATE
                    : this.settings.citationFootnoteRefTemplate.trim();
        } else {
            template =
                this.settings.citationFootnoteTemplate.trim() === ""
                    ? FALLBACK_FOOTNOTE_TEMPLATE
                    : this.settings.citationFootnoteTemplate.trim();
        }

        if (!template) return "";

        const item = await db.items.get([input.item.libraryID, input.item.key]);
        if (!item) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LibraryTemplateService",
                `Item not found: ${input.item.libraryID}/${input.item.key}`,
            );
        }

        const context = {} as any;
        context.item = await this.mapToItemContext(item);
        context.notePath = notePath;
        if (input.annotations?.length) {
            context.annotations = input.annotations.map((a) =>
                this.mapToAnnotationContext(a),
            );
        }

        return this.engine.parseAndRender(template, context);
    }

    /** Preview a citation template for a library item (no file creation). */
    async previewCitationTemplate(
        input: CitationTemplateInput,
        template: string,
    ): Promise<string> {
        const item = await db.items.get([input.item.libraryID, input.item.key]);
        if (!item) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LibraryTemplateService",
                `Item not found: ${input.item.libraryID}/${input.item.key}`,
            );
        }
        const notePath =
            await this.notePathService.resolveLibraryNotePath(item);
        const context = {} as any;
        context.item = await this.mapToItemContext(item);
        context.notePath = notePath;
        if (input.annotations?.length) {
            context.annotations = input.annotations.map((a) =>
                this.mapToAnnotationContext(a),
            );
        }
        return this.engine.parseAndRender(template, context);
    }

    /** Return the current citation template from settings. */
    getDefaultCitationTemplate(
        format: "pandoc" | "wikilink" | "footnote" | "footnote-ref",
    ): string {
        if (format === "pandoc") {
            return this.settings.citationPandocTemplate.trim() === ""
                ? FALLBACK_PANDOC_TEMPLATE
                : this.settings.citationPandocTemplate.trim();
        }
        if (format === "wikilink") {
            return this.settings.citationWikilinkTemplate.trim() === ""
                ? FALLBACK_WIKILINK_TEMPLATE
                : this.settings.citationWikilinkTemplate.trim();
        }
        if (format === "footnote-ref") {
            return this.settings.citationFootnoteRefTemplate.trim() === ""
                ? FALLBACK_FOOTNOTE_REF_TEMPLATE
                : this.settings.citationFootnoteRefTemplate.trim();
        }
        return this.settings.citationFootnoteTemplate.trim() === ""
            ? FALLBACK_FOOTNOTE_TEMPLATE
            : this.settings.citationFootnoteTemplate.trim();
    }

    private sanitizeQuotesString(str: string): string {
        // Escape >, < into \>, \<
        return str.replace(/>/g, "\\>").replace(/</g, "\\<");
    }

    private async prepareItemContext(item: AnyIDBZoteroItem): Promise<any> {
        const itemContext = await this.mapToItemContext(item);

        // Build a Set of `${type}:${key}` for regions that must NOT be wrapped
        // as editable.  Currently: annotations flagged readOnly (external, or
        // not authored by the current user).  Built once per render so the
        // wrap_editable filter is O(1) per call.
        const readOnlyKeys = new Set<string>();
        for (const a of itemContext.annotations) {
            if (a.readOnly) readOnlyKeys.add(`ANNO:${a.key}`);
        }
        for (const a of itemContext.attachmentAnnotations) {
            if (a.readOnly) readOnlyKeys.add(`ANNO:${a.key}`);
        }

        // Determine the Zotero URI library path prefix: "library" for the
        // personal library, "groups/<id>" for group libraries.
        let zoteroLibPrefix = zoteroLibraryPrefix(false, item.libraryID);
        try {
            const lib = await db.libraries.get(item.libraryID);
            zoteroLibPrefix = zoteroLibraryPrefix(
                lib?.type === "group",
                item.libraryID,
            );
        } catch {
            // Default to personal-library prefix on lookup failure.
        }

        return {
            item: itemContext,
            settings: {
                ...this.settings,
                annotationImageFolder:
                    this.settings.annotationImageFolder.replace(/\/$/, ""),
            },
            __zfReadOnlyKeys: readOnlyKeys,
            __zfZoteroLibPrefix: zoteroLibPrefix,
        };
    }

    private async mapToItemContext(
        item: AnyIDBZoteroItem,
    ): Promise<ItemTemplateContext> {
        const raw = item.raw || {};
        const data = raw.data || {};

        const children = await db.items
            .where(["libraryID", "parentItem", "itemType", "trashed"])
            .anyOf(
                getCombinations([
                    [item.libraryID],
                    [item.key],
                    ["note", "annotation", "attachment"],
                    [0],
                ]),
            )
            .toArray();

        const notes = await Promise.all(
            children
                .filter((c) => c.itemType === "note")
                .map((note) => this.mapToNoteContext(note)),
        );

        const attachments = await Promise.all(
            children
                .filter((c) => c.itemType === "attachment")
                .map((att) => this.mapToAttachmentContext(att)),
        );

        const annotations = (
            await getAnnotationJson(
                item as any,
                this.settings.zoteroapikey,
                (item) => item.syncStatus !== "deleted",
            )
        ).map((a) => this.mapToAnnotationContext(a, item.key));

        const attachmentAnnotations = attachments.flatMap(
            (att) => att.annotations,
        );

        let creatorsObj: { name: string }[] = [];
        if (raw.meta?.creatorsSummary) {
            if (typeof raw.meta.creatorsSummary === "string") {
                creatorsObj = [{ name: raw.meta.creatorsSummary }];
            }
        } else if ((data as any).creators) {
            creatorsObj = (data as any).creators.map((c: any) => ({
                name:
                    c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
            }));
        }

        const itemPaths = await this.dbHelper
            .getItemPaths([
                {
                    libraryID: item.libraryID,
                    key: item.key,
                    collections: item.collections,
                },
            ])
            .then((paths) => paths[`${item.libraryID}:${item.key}`] || []);

        const relatedItems = await this.mapToRelatedItems(data);

        return {
            key: item.key,
            version: item.version,
            libraryID: item.libraryID,
            parentItem: item.parentItem || "",
            citationKey: item.citationKey || "",
            itemPaths: itemPaths,
            notes,
            annotations,
            attachmentAnnotations,
            attachments,
            relatedItems,
            itemType: item.itemType,
            title: item.title || "",
            creators: creatorsObj,
            date: (data as any).date || null,
            year: extractYear((data as any).date),
            dateAdded: item.dateAdded,
            dateModified: item.dateModified,
            accessDate: (data as any).accessDate || null,
            abstractNote: (data as any).abstractNote,
            publicationTitle: (data as any).publicationTitle,
            publisher: (data as any).publisher,
            place: (data as any).place,
            volume: (data as any).volume,
            issue: (data as any).issue,
            pages: (data as any).pages,
            series: (data as any).series,
            seriesNumber: (data as any).seriesNumber,
            edition: (data as any).edition,
            url: (data as any).url,
            DOI: (data as any).DOI,
            ISBN: (data as any).ISBN,
            ISSN: (data as any).ISSN,
            tags: (data as any).tags || [],
            csljson: item.csljson,
        };
    }

    private async mapToNoteContext(
        item: IDBZoteroItem<NoteData>,
    ): Promise<NoteTemplateContext> {
        const data = item.raw.data || {};
        return {
            key: item.key,
            libraryID: item.libraryID,
            parentItem: item.parentItem || "",
            title: item.title || "",
            note: data.note || "",
            tags: data.tags || [],
            dateAdded: item.dateAdded,
            dateModified: item.dateModified,
        };
    }

    private mapToAnnotationContext(
        annotation: AnnotationJSON,
        parentItem?: string,
    ): AnnotationTemplateContext {
        return {
            key: annotation.id!,
            libraryID: annotation.libraryID!,
            parentItem,
            type: annotation.type,
            authorName: annotation.authorName,
            text: this.sanitizeQuotesString(annotation.text || ""),
            comment: this.convertService.annoHtml2md(annotation.comment || ""),
            color: annotation.color,
            pageLabel: annotation.pageLabel,
            tags: annotation.tags?.map((t) => ({ tag: t.name })) || [],
            dateAdded: annotation.dateAdded,
            dateModified: annotation.dateModified,
            isExternal: annotation.isExternal === true,
            readOnly: annotation.readOnly === true,

            raw: annotation,
        };
    }

    private parseRelationUri(
        uri: string,
    ): { libraryID: number; key: string } | null {
        const m = ZOTERO_URI_RE.exec(uri.trim());
        if (!m) return null;
        return { libraryID: Number(m[1]), key: m[2]! };
    }

    private async mapToRelatedItems(
        data: any,
    ): Promise<RelatedItemTemplateContext[]> {
        const rels = data?.relations as
            | { [k: string]: string | string[] }
            | undefined;
        if (!rels) return [];

        const dc = rels["dc:relation"];
        if (!dc) return [];
        const uris = Array.isArray(dc) ? dc : [dc];

        const parsed: { libraryID: number; key: string }[] = [];
        for (const uri of uris) {
            const p = this.parseRelationUri(uri);
            if (p) parsed.push(p);
        }
        if (parsed.length === 0) return [];

        const fetched = await db.items.bulkGet(
            parsed.map((p) => [p.libraryID, p.key]),
        );

        const out: RelatedItemTemplateContext[] = [];
        for (let i = 0; i < parsed.length; i++) {
            const { libraryID, key } = parsed[i]!;
            const hit = fetched[i];
            if (!hit) {
                out.push({ key, libraryID, resolved: false });
                continue;
            }
            let notePath: string | undefined;
            try {
                notePath =
                    await this.notePathService.resolveLibraryNotePath(hit);
            } catch {
                notePath = undefined;
            }
            out.push({
                key,
                libraryID,
                resolved: true,
                title: hit.title || "",
                itemType: hit.itemType,
                citationKey: hit.citationKey || "",
                notePath,
            });
        }
        return out;
    }

    private async mapToAttachmentContext(
        item: IDBZoteroItem<AttachmentData>,
    ): Promise<AttachmentTemplateContext> {
        const annotations = (
            await getAnnotationJson(
                item,
                this.settings.zoteroapikey,
                (item) => item.syncStatus !== "deleted",
            )
        ).map((a) => this.mapToAnnotationContext(a, item.key));

        const data = item.raw.data || {};
        return {
            key: item.key,
            libraryID: item.libraryID,
            parentItem: item.parentItem || "",
            filename: data.filename || data.title || "",
            contentType: data.contentType || "",
            tags: data.tags || [],
            dateAdded: item.dateAdded,
            dateModified: item.dateModified,

            annotations,
        };
    }
}
