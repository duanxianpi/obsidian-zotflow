/**
 * Annotation images — Zotero image annotations extracted to PNG files.
 *
 * Zotero stores them as `<img data-attachment-key data-annotation>` with the
 * bitmap living in the attachment store. ZotFlow extracts the PNG into the
 * vault so Obsidian can render it, while keeping the original tag — and
 * every `data-*` attribute Zotero needs — intact.
 *
 * Wire form:  `![<img …> | 576](ZotFlow/images/KEY.png)`
 *
 * The alt text is the carrier. That is unusual, but it is the only slot in
 * CommonMark image syntax that round-trips through Obsidian's editor
 * untouched while keeping the image renderable.
 */

import { toHtml } from "hast-util-to-html";
import { visit } from "unist-util-visit";

import { PASS, stringifyAs } from "./types";

import type { Root as MRoot } from "mdast";
import type { ZoteroAnnotationImage } from "../model/nodes";
import type { SyntaxFeature } from "./types";

/** Alt text of an annotated image: the `<img>` tag, optionally ` | width`. */
const ANNOTATED_IMAGE_ALT_RE = /^(<img\s[^>]*>)\s*(?:\|\s*\d+)?$/;

export const annotationImageFeature: SyntaxFeature = {
    name: "annotation-image",

    hastHandlers: (ctx) => ({
        img: (_state, node) => {
            const key = node.properties.dataAttachmentKey;
            const hasAnnotationData =
                key != null || node.properties.dataAnnotation != null;
            // Plain images: declined, so rehype-remark's default handler
            // produces an ordinary markdown image.
            if (!hasAnnotationData) return PASS;

            const folder = ctx.annotationImageFolder?.replace(/\/$/, "");
            const width = node.properties.width;

            const image: ZoteroAnnotationImage = {
                type: "zoteroAnnotationImage",
                value: toHtml(node),
                // Without a key or a configured folder there is no extracted
                // file to point at; the node then serializes as the bare tag.
                displayPath:
                    typeof key === "string" && key && folder
                        ? `${folder}/${key}.png`
                        : undefined,
                width: width == null ? undefined : String(width),
            };
            return image;
        },
    }),

    stringifyHandlers: () => ({
        zoteroAnnotationImage: stringifyAs<ZoteroAnnotationImage>((node) => {
            if (!node.displayPath) return node.value;
            const widthSuffix = node.width ? ` | ${node.width}` : "";
            return `![${node.value}${widthSuffix}](${node.displayPath})`;
        }),
    }),

    /**
     * Restore the original `<img>` tag, dropping the markdown wrapper.
     *
     * Runs on the mdast, so an example of this syntax inside a code fence is
     * a `code` node and is never visited.
     */
    transformMdastOut(tree: MRoot) {
        visit(tree, "image", (node, index, parent) => {
            if (!parent || index === undefined) return;
            const m = ANNOTATED_IMAGE_ALT_RE.exec(node.alt ?? "");
            if (!m) return;
            parent.children[index] = { type: "html", value: m[1]! };
        });
    },
};
