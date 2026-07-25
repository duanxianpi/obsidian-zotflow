/**
 * Tables.
 *
 * A plain table maps onto a GFM table. A table carrying inline styles does
 * not — GFM has no cell styling — so it is **preserved** whole as opaque
 * HTML rather than silently losing the formatting.
 *
 * GFM also has no headerless table, while Zotero's schema does. Such tables
 * are tagged during conversion and get `<!-- -->` placeholder header cells at
 * serialization time.
 */

import { toHtml } from "hast-util-to-html";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit } from "unist-util-visit";
import { defaultHandlers } from "hast-util-to-mdast";

import { opaqueHtml } from "../model/nodes";
import { gfmToMarkdownExtensions } from "../gfm";
import { stringifyAs } from "./types";

import type { Element } from "hast";
import type { Table } from "mdast";
import type { Handle as StringifyHandle } from "mdast-util-to-markdown";
import type { SyntaxFeature } from "./types";

/** Marks a table that had no real `<thead>`. */
const HEADERLESS = "zotflowHeaderless";

/** Stateless — built once rather than per table serialized. */
const TABLE_EXTENSIONS = gfmToMarkdownExtensions();

const CELL_TAGS = new Set(["tr", "td", "th"]);

declare module "mdast" {
    interface TableData {
        /** Set when the source table had no header row. */
        [HEADERLESS]?: boolean;
    }
}

export const tableFeature: SyntaxFeature = {
    name: "table",

    hastHandlers: () => ({
        table: (state, node) => {
            let hasStyle = false;
            let hasHeader = false;

            visit(node, "element", (n: Element) => {
                if (!CELL_TAGS.has(n.tagName)) return;
                if (n.properties.style) hasStyle = true;
                if (n.tagName === "th") hasHeader = true;
            });

            if (hasStyle) {
                return opaqueHtml(toHtml(node), "styled-table");
            }

            const tableNode = defaultHandlers.table(state, node);
            if (!hasHeader && tableNode && tableNode.type === "table") {
                tableNode.data = { ...tableNode.data, [HEADERLESS]: true };
            }
            return tableNode;
        },
    }),

    /**
     * `allHandlers` is the merged handler record the registry is still
     * assembling. It is captured by reference and only read when a table is
     * actually serialized — by which point every feature has contributed, so
     * cell content (math, marks, opaque payloads, Obsidian syntax …)
     * serializes the same inside a table as anywhere else.
     */
    stringifyHandlers: (_ctx, allHandlers) => {
        // Built once, on first use: every handler except `table` itself.
        // Passing `table` down would make the nested call re-enter this
        // handler for the very node it was given — infinite recursion. The
        // GFM extension below is what actually renders the table node.
        let cellHandlers: Record<string, StringifyHandle> | undefined;
        const getCellHandlers = () => {
            if (!cellHandlers) {
                cellHandlers = { ...allHandlers };
                delete cellHandlers.table;
            }
            return cellHandlers;
        };

        return {
            /**
             * Serialized through a nested `toMarkdown` call because the GFM
             * table extension owns the alignment and padding logic, which
             * cannot be reached from a plain handler.
             */
            table: stringifyAs<Table>((node) => {
                const txt = toMarkdown(node, {
                    extensions: TABLE_EXTENSIONS,
                    handlers: getCellHandlers(),
                });

                if (!node.data?.[HEADERLESS]) return txt;

                const lines = txt.split("\n");
                if (lines[0]) {
                    lines[0] = lines[0].replace(/(\| +)+/g, (s) =>
                        s.replace(/ +/g, " <!-- --> "),
                    );
                }
                return lines.join("\n");
            }),
        };
    },
};
