/**
 * Structural clean-up of Zotero note HTML.
 *
 * Not a syntax as such — this is the shape of a Zotero note document: stray
 * whitespace around `<br>`, inline elements orphaned at the root, empty
 * paragraphs, and character references left double-encoded by an earlier
 * round-trip. All of it has to go before rehype-remark sees the tree.
 *
 * The wrapper `<div data-schema-version>` is handled by the pipeline itself
 * rather than here, because extracting it produces a value (the attributes)
 * that the caller has to thread back out.
 */

import { h } from "hastscript";

import { isBlankText, isEmptyParagraph } from "./list";

import type { Parents, Root as HRoot, RootContent } from "hast";
import type { SyntaxFeature } from "./types";

/** Inline elements Zotero may leave directly under the root. */
const ORPHAN_INLINE_TAGS = new Set(["span", "img"]);

/**
 * A text node holding nothing but line breaks.
 *
 * Deliberately narrower than "whitespace only": a run of spaces is content
 * here (Zotero uses it for alignment), whereas the newlines that HTML
 * pretty-printing inserts around `<br>` are not.
 */
function isNewlineOnly(node: RootContent): boolean {
    return node.type === "text" && node.value.replace(/[\r\n]/g, "") === "";
}

function isBreak(node: RootContent): boolean {
    return node.type === "element" && node.tagName === "br";
}

/**
 * Depth-first walk over every node that has children.
 *
 * `unist-util-visit` cannot narrow the visitor's parameter from an arbitrary
 * type predicate, and the passes below need to rewrite whole `children`
 * arrays rather than individual nodes — so an explicit recursion is both
 * clearer and properly typed here.
 */
function forEachParent(root: Parents, fn: (node: Parents) => void): void {
    fn(root);
    for (const child of root.children) {
        if (child.type === "element") forEachParent(child, fn);
    }
}

/**
 * Decode literal numeric HTML character references (`&#x20;`, `&#32;`) in a
 * text node back to the characters they represent.
 *
 * Zotero's note serializer emits single character references for spaces and
 * letters at inline-mark boundaries. A prior round-trip can double-encode
 * them (`&amp;#x20;`), which rehype-parse decodes one level into the *literal*
 * text `&#x20;`. Left alone, that text is re-escaped into a broken reference
 * and surfaces in Zotero as a visible `&#x20;`, so the note self-heals here.
 *
 * Named references are deliberately untouched, so genuine ampersand text such
 * as "Tom &amp; Jerry" round-trips unchanged.
 */
function decodeNumericCharRefs(value: string): string {
    if (value.indexOf("&#") === -1) return value;
    return value.replace(
        /&#x([0-9a-fA-F]+);|&#(\d+);/g,
        (match, hex: string | undefined, dec: string | undefined) => {
            // Exactly one alternative matches, so `dec` is set when `hex` is not.
            const code = hex != null ? parseInt(hex, 16) : parseInt(dec!, 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
                return match;
            }
            try {
                return String.fromCodePoint(code);
            } catch {
                return match;
            }
        },
    );
}

export const noteStructureFeature: SyntaxFeature = {
    name: "note-structure",

    cleanHast(tree: HRoot) {
        // 1. Normalize <br>: drop the line-break-only text nodes that HTML
        //    formatting leaves on either side of it.
        forEachParent(tree, (parent) => {
            const children = parent.children;
            if (!children.some(isBreak)) return;
            parent.children = children.filter((child, i) => {
                if (!isNewlineOnly(child)) return true;
                const before = children[i - 1];
                const after = children[i + 1];
                return !(
                    (before && isBreak(before)) ||
                    (after && isBreak(after))
                );
            });
        });

        // 2/3. Root-level fixes: wrap orphaned inline elements in a <p>, and
        //      drop empty paragraphs. Both are inherently about the root's
        //      direct children, so a plain loop beats a tree walk.
        const roots: RootContent[] = [];
        for (const child of tree.children) {
            if (isEmptyParagraph(child)) continue;
            if (
                child.type === "element" &&
                ORPHAN_INLINE_TAGS.has(child.tagName)
            ) {
                roots.push(h("p", [child]));
                continue;
            }
            roots.push(child);
        }
        tree.children = roots;

        // 4. Heal double-encoded numeric character references. Skipped inside
        //    <code>/<pre>, where such text may be intentional.
        const healTextIn = (parent: Parents, insideCode: boolean): void => {
            for (const child of parent.children) {
                if (child.type === "text") {
                    if (!insideCode) {
                        child.value = decodeNumericCharRefs(child.value);
                    }
                    continue;
                }
                if (child.type !== "element") continue;
                healTextIn(
                    child,
                    insideCode ||
                        child.tagName === "code" ||
                        child.tagName === "pre",
                );
            }
        };
        healTextIn(tree, false);
    },

    /** Collapse runs of blank nodes at the root — markdown has no place for them. */
    transformHast(tree: HRoot) {
        const kept: RootContent[] = [];
        const isEmpty = (n: RootContent) => isBlankText(n) || isEmptyParagraph(n);
        for (const child of tree.children) {
            const previous = kept[kept.length - 1];
            if (previous && isEmpty(previous) && isEmpty(child)) continue;
            kept.push(child);
        }
        tree.children = kept;
    },
};
