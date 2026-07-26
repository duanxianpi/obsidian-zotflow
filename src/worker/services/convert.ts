import { unified } from "unified";
import rehypeParse from "rehype-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import remarkStringify from "remark-stringify";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";

import { remarkGfmNoFootnotes } from "worker/convert/gfm";
import { html2mdWithProcessors } from "worker/convert/html-to-md";
import { md2htmlWithProcessors } from "worker/convert/md-to-html";
import { annoHtml2md, annoMd2html } from "worker/convert/annotation-comment";

import type { Root as MRoot } from "mdast";
import type { Handle as StringifyHandle } from "mdast-util-to-markdown";
import type { ConvertProcessors } from "worker/convert/processors";
import type { Html2MdOptions } from "worker/convert/html-to-md";
import type { ConvertOptions } from "worker/convert/md-to-html";

/**
 * Singleton service that owns the frozen unified processor instances and
 * exposes all HTML ↔ Markdown conversion methods.
 *
 * Each processor is built for one job and stays frozen and reused for the
 * lifetime of the service. Binding them into `ConvertProcessors` here — five
 * operations named for what they do — is what keeps the tree types concrete
 * downstream: a single `Processor` value passed around has to be typed
 * loosely enough for every use, which is what previously erased the tree type
 * at each call site.
 */
export class ConvertService {
    private readonly processors: ConvertProcessors;

    constructor() {
        const rehypeParser = unified()
            .use(rehypeParse, { fragment: true })
            .freeze();

        const remarkStringifier = unified()
            .use(remarkGfmNoFootnotes)
            .use(remarkMath)
            .freeze();

        const remarkParser = unified()
            .use(remarkGfmNoFootnotes)
            .use(remarkMath)
            .use(remarkParse)
            .freeze();

        const remark2rehype = unified()
            .use(remarkRehype, { allowDangerousHtml: true })
            .freeze();

        const rehypeStringifier = unified()
            .use(rehypeStringify, {
                allowDangerousCharacters: true,
                allowDangerousHtml: true,
            })
            .freeze();

        this.processors = {
            parseHtml: (html) => rehypeParser.parse(html),

            parseMarkdown: (md) => remarkParser.parse(md),

            mdastToHast: async (tree) =>
                await remark2rehype.run(tree),

            stringifyHtml: (tree) =>
                String(rehypeStringifier.stringify(tree)),

            stringifyMarkdown: (
                tree: MRoot,
                handlers: Record<string, StringifyHandle>,
            ) =>
                String(
                    remarkStringifier()
                        .use(remarkStringify, { handlers })
                        .stringify(tree),
                ),
        };
    }

    /* Public API */

    /** Convert Zotero-format note HTML to Markdown. */
    async html2md(html: string, options?: Html2MdOptions): Promise<string> {
        return html2mdWithProcessors(html, this.processors, options);
    }

    /** Convert Markdown to Zotero-format note HTML. */
    async md2html(md: string, options?: ConvertOptions): Promise<string> {
        return md2htmlWithProcessors(md, this.processors, options);
    }

    /** Convert annotation comment HTML → Markdown (restricted subset). */
    annoHtml2md(html: string): string {
        return annoHtml2md(html);
    }

    /** Convert annotation comment Markdown → HTML (restricted subset). */
    annoMd2html(md: string): string {
        return annoMd2html(md);
    }
}
