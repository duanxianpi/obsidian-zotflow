/*
 * Ported from an existing Obsidian community plugin's embedded-editor helper.
 * It drives Obsidian's own unexported CodeMirror plumbing through
 * `monkey-around`. Internal API shapes come from `obsidian-typings`; the
 * runtime constructor still has to be discovered from an editable embed.
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
import type { KeyBinding } from "@codemirror/view";

import { around } from "monkey-around";

import type { App, MarkdownFileInfo, WorkspaceLeaf } from "obsidian";
import type {
    ConstructorBase,
    EmbedComponent,
    EmbedContext,
    MarkdownScrollableEditView,
    WidgetEditorView,
} from "@obsidian-typings/obsidian-public-1.11.4";

interface EmbeddedEditorOwner extends MarkdownFileInfo {
    editMode?: EmbeddableMarkdownEditor;
    getMode(): "source";
    onMarkdownScroll(): void;
    syncScroll(): void;
}

type MarkdownEditorConstructor = ConstructorBase<
    [app: App, container: HTMLElement, owner: EmbeddedEditorOwner],
    MarkdownScrollableEditView
>;

type MarkdownEmbedCreator = (
    context: EmbedContext,
    file: null,
    subpath?: string,
) => EmbedComponent;

type SetActiveLeafArgs =
    | [
          leaf: WorkspaceLeaf,
          params?: {
              focus?: boolean;
              direction?: "vertical" | "horizontal";
          },
      ]
    | [leaf: WorkspaceLeaf, pushHistory: boolean, focus: boolean];

interface SetActiveLeafTarget {
    setActiveLeaf(...args: SetActiveLeafArgs): void;
}

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
function resolveEditorPrototype(app: App): MarkdownEditorConstructor {
    const embedCreators = app.embedRegistry.embedByExtension as typeof app
        .embedRegistry.embedByExtension & {
        md: MarkdownEmbedCreator;
    };
    const embedComponent = embedCreators.md(
        { app, containerEl: createDiv() },
        null,
        "",
    );

    if (!isWidgetEditorView(embedComponent)) {
        embedComponent.unload();
        throw new TypeError("Markdown embed did not create an editor view");
    }

    try {
        embedComponent.editable = true;
        embedComponent.showEditor();
        const editMode = embedComponent.editMode;
        if (!editMode) {
            throw new TypeError("Markdown embed did not initialize edit mode");
        }

        const framedEditorPrototype = Reflect.getPrototypeOf(editMode);
        const markdownEditorPrototype =
            framedEditorPrototype &&
            Reflect.getPrototypeOf(framedEditorPrototype);
        if (
            !markdownEditorPrototype ||
            !("constructor" in markdownEditorPrototype)
        ) {
            throw new TypeError("Markdown editor constructor was not found");
        }

        const editorConstructor: unknown = markdownEditorPrototype.constructor;
        if (typeof editorConstructor !== "function") {
            throw new TypeError("Markdown editor constructor is invalid");
        }

        return editorConstructor as MarkdownEditorConstructor;
    } finally {
        embedComponent.unload();
    }
}

function isWidgetEditorView(
    component: EmbedComponent,
): component is WidgetEditorView {
    return (
        "showEditor" in component &&
        typeof component.showEditor === "function"
    );
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

type ResolvedMarkdownEditorProps = Required<MarkdownEditorProps>;

const defaultProperties: ResolvedMarkdownEditorProps = {
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
    options: ResolvedMarkdownEditorProps;
    initial_value: string;
    scope: Scope;
    editor: MarkdownScrollableEditView;
    private ownerInfo: EmbeddedEditorOwner;

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
    get owner(): EmbeddedEditorOwner {
        return this.ownerInfo;
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
        EditorClass: MarkdownEditorConstructor,
        container: HTMLElement,
        options: Partial<MarkdownEditorProps>,
    ) {
        // Store user options first
        this.options = { ...defaultProperties, ...options };
        this.initial_value = this.options.value;
        this.scope = new Scope(app.scope);
        this.ownerInfo = {
            app,
            editMode: this,
            editor: undefined,
            file: null,
            getMode: () => "source",
            hoverPopover: null,
            onMarkdownScroll: () => {},
            syncScroll: () => {},
        };

        // Prevent Mod+Enter default behavior
        this.scope.register(["Mod"], "Enter", () => true);

        const handleSuggestionPanelKeyEvent = (key: string): boolean => {
            const currentSuggest = this.editor.editorSuggest.currentSuggest;
            if (!currentSuggest?.isOpen) return false;

            currentSuggest.suggestEl.dispatchEvent(
                new KeyboardEvent("keydown", { key }),
            );
            return true;
        };

        const extendLocalExtensions = (
            editor: MarkdownScrollableEditView,
            extensions: ReturnType<
                MarkdownScrollableEditView["buildLocalExtensions"]
            >,
        ) =>
            this.extendLocalExtensions(
                editor,
                extensions,
                app,
                handleSuggestionPanelKeyEvent,
            );

        // Use monkey-around to safely patch the method
        const uninstaller = around(EditorClass.prototype, {
            buildLocalExtensions: (originalMethod) =>
                function (this: MarkdownScrollableEditView) {
                    return extendLocalExtensions(
                        this,
                        originalMethod.call(this),
                    );
                },
        });

        // Add obsidian-app class to the editor container, apply obsidian styles
        container.classList.toggle("obsidian-app", true);
        // Unset some unnecessary obsidian styles
        container.setCssStyles({ contain: "content" });

        // Create the editor with the app instance
        this.editor = new EditorClass(app, container, this.ownerInfo);

        // Register the uninstaller for cleanup
        this.register(uninstaller);

        // Set up the editor relationship for commands to work
        this.owner.editMode = this;
        this.owner.editor = this.editor.editor;

        // Set initial content
        this.set(options.value || "", false);

        // Enable source mode (disable live preview) if requested
        if (this.options.sourceMode) {
            this.editor.sourceMode = true;
            this.editor.updateOptions();
        }

        // Prevent active leaf changes while focused
        this.register(
            around(app.workspace as SetActiveLeafTarget, {
                setActiveLeaf:
                    (oldMethod) =>
                    (...args) => {
                        if (!this.activeCM.hasFocus) {
                            oldMethod(...args);
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
            this.options.readableLineLength &&
            app.vault.getConfig("readableLineLength") !== false
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

    private extendLocalExtensions(
        editor: MarkdownScrollableEditView,
        extensions: ReturnType<
            MarkdownScrollableEditView["buildLocalExtensions"]
        >,
        app: App,
        handleSuggestionPanelKeyEvent: (key: string) => boolean,
    ): ReturnType<MarkdownScrollableEditView["buildLocalExtensions"]> {
        if (editor !== this.editor) return extensions;

        if (this.options.placeholder) {
            extensions.push(placeholder(this.options.placeholder));
        }

        const closeOpenMenu = (): void => {
            if (document.querySelector("body > div.menu") !== null) {
                document.body.click();
            }
        };

        extensions.push(
            EditorView.domEventHandlers({
                paste: (event) => {
                    this.options.onPaste(event, this);
                },
                blur: () => {
                    app.keymap.popScope(this.scope);
                    this.options.onBlur(this);
                    closeOpenMenu();
                },
                focusin: () => {
                    app.keymap.pushScope(this.scope);
                    app.workspace.activeEditor = this.owner;
                },
                click: closeOpenMenu,
                contextmenu: closeOpenMenu,
            }),
        );

        const keyBindings: KeyBinding[] = [
            {
                key: "ArrowUp",
                run: () => handleSuggestionPanelKeyEvent("ArrowUp"),
            },
            {
                key: "ArrowDown",
                run: () => handleSuggestionPanelKeyEvent("ArrowDown"),
            },
            {
                key: "Tab",
                run: () => handleSuggestionPanelKeyEvent("Tab"),
            },
            {
                key: "Enter",
                run: () =>
                    handleSuggestionPanelKeyEvent("Enter") ||
                    this.options.onEnter(this, false, false),
                shift: () => this.options.onEnter(this, false, true),
            },
            {
                key: "Mod-Enter",
                run: () => this.options.onEnter(this, true, false),
                shift: () => this.options.onEnter(this, true, true),
            },
            {
                key: "Escape",
                run: () => {
                    this.options.onEscape(this);
                    return true;
                },
                preventDefault: true,
            },
        ];

        if (this.options.singleLine) {
            keyBindings[0] = {
                key: "Enter",
                run: () => this.options.onEnter(this, false, false),
                shift: () => this.options.onEnter(this, false, true),
            };
        }

        extensions.push(Prec.highest(keymap.of(keyBindings)));

        if (this.options.readOnly) {
            extensions.push(
                EditorView.editable.of(false),
                EditorState.readOnly.of(true),
            );
        }

        if (this.options.showLineNumbers) {
            extensions.push(lineNumbers());
        } else {
            extensions.push(lineNumbers({ formatNumber: () => "" }));
            extensions.push(
                EditorView.theme({
                    ".cm-gutters .cm-lineNumbers": {
                        display: "none !important",
                    },
                    ".cm-gutters:has(> .cm-gutter:only-child.cm-lineNumbers)": {
                        display: "none !important",
                    },
                }),
            );
        }

        return extensions;
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
    register(cb: () => void): void {
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
