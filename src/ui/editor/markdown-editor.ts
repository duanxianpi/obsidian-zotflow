/*
 * Ported from an existing Obsidian community plugin's embedded-editor helper.
 * It drives Obsidian's own unexported CodeMirror plumbing through
 * `monkey-around`, so it reaches into internals the API does not describe;
 * the surrounding shape is kept as close to the original as possible so the
 * port stays followable.
 *
 * The `any` family is switched off for the file rather than worked around
 * inside it. `@codemirror/*` is flagged for the same reason it is in
 * `tests/`: it arrives through Obsidian's own dependency tree and is an
 * esbuild external, so declaring it directly would pin a second copy the
 * plugin never runs against.
 */
import { Scope } from "obsidian";

import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
    EditorView,
    keymap,
    lineNumbers,
    placeholder,
    ViewUpdate,
} from "@codemirror/view";

import { around } from "monkey-around";

import type {
    App,
    MarkdownScrollableEditView,
    TFile,
    WidgetEditorView,
    WorkspaceLeaf,
} from "obsidian";

/**
 * Creates an embeddable markdown editor
 * @param app The Obsidian app instance
 * @param container The container element
 * @param options Editor options
 * @returns A configured markdown editor
 */
export function createEmbeddableMarkdownEditor(
    app: App,
    container: HTMLElement,
    options: Partial<MarkdownEditorProps>,
): EmbeddableMarkdownEditor {
    // Get the editor class
    const EditorClass = resolveEditorPrototype(app);

    // Create the editor instance
    return new EmbeddableMarkdownEditor(app, EditorClass, container, options);
}

/**
 * Resolves the markdown editor prototype from the app
 */
function resolveEditorPrototype(app: App): any {
    // Create a temporary editor to resolve the prototype of ScrollableMarkdownEditor
    const widgetEditorView = app.embedRegistry.embedByExtension.md(
        { app, containerEl: createDiv() },
        null as unknown as TFile,
        "",
    ) as WidgetEditorView;

    // Mark as editable to instantiate the editor
    widgetEditorView.editable = true;
    widgetEditorView.showEditor();
    const MarkdownEditor = Object.getPrototypeOf(
        Object.getPrototypeOf(widgetEditorView.editMode!),
    );

    // Unload to remove the temporary editor
    widgetEditorView.unload();

    // Return the constructor, using 'any' type to bypass the abstract class check
    return MarkdownEditor.constructor;
}

export interface MarkdownEditorProps {
    cursorLocation?: { anchor: number; head: number };
    value?: string;
    cls?: string;
    placeholder?: string;
    singleLine?: boolean; // New option for single line mode
    readOnly?: boolean;
    sourceMode?: boolean;
    showLineNumbers?: boolean;
    readableLineLength?: boolean;

    onEnter: (
        editor: EmbeddableMarkdownEditor,
        mod: boolean,
        shift: boolean,
    ) => boolean;
    onEscape: (editor: EmbeddableMarkdownEditor) => void;
    onSubmit: (editor: EmbeddableMarkdownEditor) => void;
    onBlur: (editor: EmbeddableMarkdownEditor) => void;
    onPaste: (e: ClipboardEvent, editor: EmbeddableMarkdownEditor) => void;
    onChange: (update: ViewUpdate) => void;
}

const defaultProperties: MarkdownEditorProps = {
    cursorLocation: { anchor: 0, head: 0 },
    value: "",
    singleLine: false,
    readOnly: false,
    sourceMode: false,
    showLineNumbers: false,
    readableLineLength: false,
    cls: "",
    placeholder: "",

    onEnter: () => false,
    onEscape: () => {},
    onSubmit: () => {},
    // NOTE: Blur takes precedence over Escape (this can be changed)
    onBlur: () => {},
    onPaste: () => {},
    onChange: () => {},
};

/**
 * A markdown editor that can be embedded in any container
 */
export class EmbeddableMarkdownEditor {
    options: MarkdownEditorProps;
    initial_value: string;
    scope: Scope;
    editor: MarkdownScrollableEditView;

    // Expose commonly accessed properties
    get editorEl(): HTMLElement {
        return this.editor.editorEl;
    }
    get containerEl(): HTMLElement {
        return this.editor.containerEl;
    }
    get activeCM(): EditorView {
        return this.editor.activeCM;
    }
    get app(): App {
        return this.editor.app;
    }
    get owner(): any {
        return this.editor.owner;
    }
    get _loaded(): boolean {
        return this.editor._loaded;
    }

    /**
     * Construct the editor
     * @param app - Reference to App instance
     * @param EditorClass - The editor class constructor
     * @param container - Container element to add the editor to
     * @param options - Options for controlling the initial state of the editor
     */
    constructor(
        app: App,
        EditorClass: any,
        container: HTMLElement,
        options: Partial<MarkdownEditorProps>,
    ) {
        // Store user options first
        this.options = { ...defaultProperties, ...options };
        this.initial_value = this.options.value!;
        this.scope = new Scope(app.scope);

        // Prevent Mod+Enter default behavior
        this.scope.register(["Mod"], "Enter", () => true);

        // Store reference to self for the patched method BEFORE using it
        const self = this;

        const handleSuggestionPanelKeyEvent = (key: string) => {
            const isSuggesting =
                self.editor.editorSuggest.currentSuggest &&
                //@ts-ignore
                self.editor.editorSuggest.currentSuggest.isOpen;
            // For suggesting, pass the event to the parent window
            isSuggesting &&
                //@ts-ignore
                self.editor.editorSuggest.currentSuggest.suggestEl.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: key,
                    }),
                );

            return isSuggesting;
        };

        // Use monkey-around to safely patch the method
        const uninstaller = around(EditorClass.prototype, {
            buildLocalExtensions: (originalMethod: any) =>
                function (this: any) {
                    const extensions = originalMethod.call(this);

                    // Only add our custom extensions if this is our editor instance
                    if (this === self.editor) {
                        // Add placeholder if configured
                        if (self.options.placeholder) {
                            extensions.push(
                                placeholder(self.options.placeholder),
                            );
                        }

                        // Add paste, blur, and focus event handlers
                        extensions.push(
                            EditorView.domEventHandlers({
                                paste: (event) => {
                                    self.options.onPaste(event, self);
                                },
                                blur: () => {
                                    // Always trigger blur callback and let it handle the logic
                                    app.keymap.popScope(self.scope);
                                    if (self.options.onBlur) {
                                        self.options.onBlur(self);
                                    }
                                    if (
                                        document.querySelector(
                                            "body > div.menu",
                                        ) !== null
                                    ) {
                                        document.body.click();
                                    }
                                },
                                focusin: () => {
                                    app.keymap.pushScope(self.scope);
                                    app.workspace.activeEditor = self.owner;
                                },
                                click: () => {
                                    if (
                                        document.querySelector(
                                            "body > div.menu",
                                        ) !== null
                                    ) {
                                        document.body.click();
                                    }
                                },
                                contextmenu: () => {
                                    if (
                                        document.querySelector(
                                            "body > div.menu",
                                        ) !== null
                                    ) {
                                        document.body.click();
                                    }
                                },
                            }),
                        );

                        // Add keyboard handlers
                        const keyBindings = [
                            {
                                key: "ArrowUp",
                                run: () =>
                                    handleSuggestionPanelKeyEvent("ArrowUp"),
                            },
                            {
                                key: "ArrowDown",
                                run: () =>
                                    handleSuggestionPanelKeyEvent("ArrowDown"),
                            },
                            {
                                key: "Tab",
                                run: () => handleSuggestionPanelKeyEvent("Tab"),
                            },
                            {
                                key: "Enter",
                                run: () => {
                                    return (
                                        handleSuggestionPanelKeyEvent(
                                            "Enter",
                                        ) ||
                                        self.options.onEnter(self, false, false)
                                    );
                                },
                                shift: () =>
                                    self.options.onEnter(self, false, true),
                            },
                            {
                                key: "Mod-Enter",
                                run: () =>
                                    self.options.onEnter(self, true, false),
                                shift: () =>
                                    self.options.onEnter(self, true, true),
                            },
                            {
                                key: "Escape",
                                run: () => {
                                    self.options.onEscape(self);
                                    return true;
                                },
                                preventDefault: true,
                            },
                        ];

                        // For single line mode, prevent Enter key from creating new lines
                        if (self.options.singleLine) {
                            keyBindings[0] = {
                                key: "Enter",
                                run: () => {
                                    // In single line mode, Enter should trigger onEnter
                                    return self.options.onEnter(
                                        self,
                                        false,
                                        false,
                                    );
                                },
                                shift: () => {
                                    // Even with shift, still call onEnter in single line mode
                                    return self.options.onEnter(
                                        self,
                                        false,
                                        true,
                                    );
                                },
                            };
                        }

                        extensions.push(Prec.highest(keymap.of(keyBindings)));

                        if (self.options.readOnly) {
                            extensions.push(
                                EditorView.editable.of(false),
                                EditorState.readOnly.of(true),
                            );
                        }

                        if (self.options.showLineNumbers) {
                            extensions.push(lineNumbers());
                        } else {
                            extensions.push(
                                lineNumbers({ formatNumber: () => "" }),
                            );
                            extensions.push(
                                EditorView.theme({
                                    ".cm-gutters .cm-lineNumbers": {
                                        display: "none !important",
                                    },

                                    ".cm-gutters:has(> .cm-gutter:only-child.cm-lineNumbers)":
                                        {
                                            display: "none !important",
                                        },
                                }),
                            );
                        }
                    }

                    return extensions;
                },
        });

        // Add obsidian-app class to the editor container, apply obsidian styles
        container.classList.toggle("obsidian-app", true);
        // Unset some unnecessary obsidian styles
        container.setCssStyles({ contain: "content" });

        // Create the editor with the app instance
        this.editor = new EditorClass(app, container, {
            app,
            // This mocks the MarkdownView functions, required for proper scrolling
            onMarkdownScroll: () => {},
            getMode: () => "source",
            syncScroll: () => {},
        });

        // Register the uninstaller for cleanup
        this.register(uninstaller);

        // Set up the editor relationship for commands to work
        if (this.owner) {
            this.owner.editMode = this;
            this.owner.editor = this.editor.editor;
        }

        // Set initial content
        this.set(options.value || "", false);

        // Enable source mode (disable live preview) if requested
        if (this.options.sourceMode) {
            this.editor.sourceMode = true;
            this.editor.updateOptions();
        }

        // Prevent active leaf changes while focused
        this.register(
            around(app.workspace, {
                setActiveLeaf:
                    (oldMethod: any) =>
                    (leaf: WorkspaceLeaf, ...args: any[]) => {
                        if (!this.activeCM?.hasFocus) {
                            oldMethod.call(app.workspace, leaf, ...args);
                        }
                    },
            }),
        );

        // Blur and focus event handlers are now handled via EditorView.domEventHandlers in buildLocalExtensions

        // Apply custom class if provided
        if (options.cls && this.editorEl) {
            this.editorEl.classList.add(options.cls);
        }

        // Match Obsidian's readable line width styling when opted in
        if (
            self.options.readableLineLength &&
            (app.vault.getConfig("readableLineLength") ?? true)
        ) {
            this.editorEl.classList.add("is-readable-line-width");
        }

        // Set the font-size to 1em
        this.editorEl.setCssStyles({ fontSize: "1em" });

        // Set cursor position if specified
        if (options.cursorLocation && this.editor.editor?.cm) {
            this.editor.editor.cm.dispatch({
                selection: EditorSelection.range(
                    options.cursorLocation.anchor,
                    options.cursorLocation.head,
                ),
            });
        }

        // Override onUpdate to call our onChange handler
        const originalOnUpdate = this.editor.onUpdate.bind(this.editor);
        this.editor.onUpdate = (update: ViewUpdate, changed: boolean) => {
            originalOnUpdate(update, changed);
            if (changed) this.options.onChange(update);
        };
    }

    // Get the current editor value
    get value(): string {
        return this.editor.editor?.cm?.state.doc.toString() || "";
    }

    // Set content in the editor
    set(content: string, focus: boolean = false): void {
        this.editor.set(content, focus);
    }

    // Register cleanup callback
    register(cb: any): void {
        this.editor.register(cb);
    }

    // Clean up method that ensures proper destruction
    destroy(): void {
        if (this._loaded && typeof this.editor.unload === "function") {
            this.editor.unload();
        }

        this.app.keymap.popScope(this.scope);
        this.app.workspace.activeEditor = null;
        this.containerEl.empty();

        this.editor.destroy();
    }

    // Unload handler
    onunload(): void {
        if (typeof this.editor.onunload === "function") {
            this.editor.onunload();
        }
        this.destroy();
    }

    // Required method for MarkdownScrollableEditView compatibility
    unload(): void {
        if (typeof this.editor.unload === "function") {
            this.editor.unload();
        }
    }
}
