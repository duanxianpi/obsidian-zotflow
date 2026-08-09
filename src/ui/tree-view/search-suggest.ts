import { AbstractInputSuggest, renderResults } from "obsidian";

import { getValueSuggestions } from "ui/search/autocomplete-data";
import {
    analyzeInput,
    applyOperatorToken,
    applyValueCompletion,
} from "utils/search-query";

import type { App, SearchResult } from "obsidian";
import type { SearchFilterField, SearchHintRow } from "utils/search-query";

/** A single row in the tree search autocomplete dropdown. */
type TreeSuggestRow =
    | { kind: "operator-header" }
    | { kind: "operator"; hint: SearchHintRow }
    | {
          kind: "value";
          field: SearchFilterField;
          value: string;
          match?: SearchResult;
      };

/**
 * Obsidian-native autocomplete for the tree-view search box. Surfaces the
 * available operators (`collection:`, `tag:`, … and `-` negation) and, once an
 * operator is chosen, completes its values (collections, tags, item types).
 * Selections are pushed back into React state via `onApply` (the input is a
 * controlled React element).
 */
export class TreeSearchSuggest extends AbstractInputSuggest<TreeSuggestRow> {
    private instructionsInjected = false;

    constructor(
        app: App,
        private readonly inputEl: HTMLInputElement,
        private readonly onApply: (value: string) => void,
    ) {
        super(app, inputEl);
    }

    open(): void {
        super.open();

        const suggestEl = (this as unknown as { suggestEl?: HTMLElement })
            .suggestEl;
        if (!suggestEl) return;

        // Constrain the popup width to the input.
        suggestEl.style.width = `${this.inputEl.offsetWidth}px`;
        suggestEl.style.maxWidth = `${this.inputEl.offsetWidth}px`;

        // Add Obsidian search suggestion styling.
        suggestEl.addClass("mod-search-suggestion");

        // Inject a prompt-instructions bar once (same DOM Obsidian uses).
        if (!this.instructionsInjected) {
            this.instructionsInjected = true;
            const bar = suggestEl.createDiv("prompt-instructions");
            bar.setCssStyles({
                padding: "var(--size-2-3)",
                paddingTop: "0px",
            });
            const chip = bar.createSpan("prompt-instruction");
            chip.createSpan({ cls: "prompt-instruction-command", text: "-" });
            chip.createSpan({ text: "to exclude, e.g. -tag:draft" });
        }
    }

    async getSuggestions(query: string): Promise<TreeSuggestRow[]> {
        const analysis = analyzeInput(query);
        if (analysis.mode === "operator") {
            return [
                { kind: "operator-header" },
                ...analysis.hints
                    .filter((h) => h.insertToken !== undefined)
                    .map((hint): TreeSuggestRow => ({
                        kind: "operator",
                        hint,
                    })),
            ];
        }
        if (analysis.mode === "value") {
            const values = await getValueSuggestions(
                analysis.field,
                analysis.partial,
            );
            return values.map((suggestion) => ({
                kind: "value",
                field: analysis.field,
                value: suggestion.value,
                match: suggestion.match,
            }));
        }
        return [];
    }

    renderSuggestion(row: TreeSuggestRow, el: HTMLElement): void {
        el.addClasses(["mod-complex", "search-suggest-item"]);

        if (row.kind === "operator-header") {
            el.addClass("mod-group");
            const content = el.createDiv("suggestion-content");
            content
                .createDiv("suggestion-title list-item-part mod-extended")
                .createSpan({ text: "Search options" });
            content.setCssStyles({
                padding: "4px 0px",
            });
            el.createDiv("suggestion-aux");
            return;
        }

        const content = el.createDiv("suggestion-content");
        const title = content.createDiv("suggestion-title");

        if (row.kind === "operator") {
            title.createSpan({ text: row.hint.token });
            title.createSpan({
                cls: "search-suggest-info-text",
                text: row.hint.description,
            });
        } else {
            const valueEl = title.createSpan();
            if (row.match) {
                renderResults(valueEl, row.value, row.match);
            } else {
                valueEl.setText(row.value);
            }
        }

        el.createDiv("suggestion-aux");
    }

    selectSuggestion(row: TreeSuggestRow): void {
        if (row.kind === "operator-header") {
            this.inputEl.focus();
            return;
        }

        const current = this.inputEl.value;

        if (row.kind === "value") {
            this.pushValue(applyValueCompletion(current, row.field, row.value));
            this.close();
            return;
        }

        // Info-only operator row (negation reminder) doesn't change the input.
        if (!row.hint.insertToken) {
            this.close();
            this.inputEl.focus();
            return;
        }

        // Insert the operator and keep the popup open so the user can pick a
        // value next.
        this.pushValue(applyOperatorToken(current, row.hint.insertToken));
        this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    private pushValue(next: string): void {
        this.inputEl.value = next;
        this.onApply(next);
        this.inputEl.focus();
    }
}
