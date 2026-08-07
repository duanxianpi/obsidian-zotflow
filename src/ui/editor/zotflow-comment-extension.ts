import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import {
    StateField,
    type Extension,
    type Text,
    RangeSetBuilder,
} from "@codemirror/state";

interface QueuedDeco {
    from: number;
    to: number;
    deco: Decoration;
    isLine: boolean;
}

/** CM6 state field that builds mark and line decorations for `%% ZOTFLOW_ANNO_* %%` comment tags. */
export const zoteroBlockField = StateField.define<DecorationSet>({
    create(state) {
        return buildDecorations(state.doc);
    },
    update(decorations, tr) {
        if (tr.docChanged) return buildDecorations(tr.newDoc);
        return decorations.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
});

function buildDecorations(doc: Text): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const queuedDecos: QueuedDeco[] = [];
    const text = doc.toString();

    // Regular expression: match ZOTFLOW tag
    const regex = /%% ZOTFLOW_ANNO_(\w+)(?:_(?:BEG|END))?[\s\S]*?%%/g;

    const lineIdMap = new Map<number, string>();

    let match;
    while ((match = regex.exec(text))) {
        const fullMatch = match[0];
        const id = match[1];
        const matchStart = match.index;
        const matchEnd = matchStart + fullMatch.length;

        if (!id) continue;

        // Tag text style (Mark)
        const tagDeco = Decoration.mark({
            class: "cm-zotflow-tag-text",
            inclusive: true,
        });

        queuedDecos.push({
            from: matchStart,
            to: matchEnd,
            deco: tagDeco,
            isLine: false,
        });

        // Record line (Line)
        const line = doc.lineAt(matchStart);
        lineIdMap.set(line.from, id);
    }

    // Generate line decoration
    for (const [lineFrom, id] of lineIdMap) {
        const lineDeco = Decoration.line({
            // Base class name
            class: "cm-zotflow-container-anno",
            attributes: {
                style: `--zotflow-block-id: '${id}';`,
            },
        });

        queuedDecos.push({
            from: lineFrom,
            to: lineFrom,
            deco: lineDeco,
            isLine: true,
        });
    }

    // Sort
    queuedDecos.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        if (a.isLine && !b.isLine) return -1;
        if (!a.isLine && b.isLine) return 1;
        return 0;
    });

    // Build
    for (const item of queuedDecos) {
        builder.add(item.from, item.to, item.deco);
    }

    return builder.finish();
}

/** Returns a CM6 extension combining the annotation block field with collapse base-theme styles. */
export function ZotFlowCommentExtension(): Extension {
    return [
        zoteroBlockField,

        EditorView.baseTheme({
            ".cm-zotflow-tag-text": {
                fontSize: "var(--font-smallest)",
            },

            ".cm-zotflow-container-anno:not(.cm-active)": {
                display: "flex !important",
                width: "auto",
                maxWidth: "100%",
                flexDirection: "row",
                alignItems: "baseline",
                verticalAlign: "bottom",
                boxSizing: "border-box",
            },

            ".cm-zotflow-container-anno:not(.cm-active) > span": {
                whiteSpace: "nowrap",
            },

            ".cm-zotflow-container-anno:not(.cm-active) > .cm-comment:not(.cm-comment-start):not(.cm-comment-end)":
                {
                    flex: "0 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                },

            ".cm-zotflow-container-anno:not(.cm-active) > .cm-comment-start,.cm-zotflow-container-anno:not(.cm-active) > .cm-comment-end":
                {
                    flex: "0 0 auto",
                },
        }),
    ];
}
