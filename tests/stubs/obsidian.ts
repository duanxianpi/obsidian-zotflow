/**
 * Stub for the `obsidian` module.
 *
 * The worker layer under test imports Obsidian only for types, which erase at
 * compile time. This exists so that any transitive runtime import resolves to
 * something inert instead of failing to resolve — and fails loudly if a test
 * ever actually depends on Obsidian behaviour.
 */

function notAvailable(name: string): never {
    throw new Error(
        `obsidian.${name} was called in a test. The module under test reaches ` +
            `into the Obsidian runtime — inject a fake instead of relying on this stub.`,
    );
}

export class Notice {
    constructor() {
        notAvailable("Notice");
    }
}

export function requestUrl(): never {
    return notAvailable("requestUrl");
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export const Platform = {
    isDesktopApp: false,
    isMobileApp: false,
    isAndroidApp: false,
};

/* ------------------------------------------------------------------ */
/*  Main-thread additions                                             */
/*                                                                    */
/*  `src/ui/reader/*` and `src/utils/file.ts` import these as VALUES, */
/*  not just types — an `instanceof TFile` check or a `new Component()`*/
/*  has to work for the module to even load. Kept to the minimum       */
/*  surface the code under test actually touches.                     */
/* ------------------------------------------------------------------ */

/** `App` is an interface in the real API; exported only so value imports resolve. */
export const App = undefined as unknown as never;

export class TAbstractFile {
    path = "";
    name = "";
}

export class TFile extends TAbstractFile {
    extension = "";
    basename = "";
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
}

/**
 * Minimal `Component` — real lifecycle semantics (load/unload, child
 * registration) because the reader bridge relies on unload actually running.
 */
export class Component {
    loaded = false;
    private children: Component[] = [];
    private onUnloadCallbacks: Array<() => unknown> = [];

    load() {
        this.loaded = true;
        for (const child of this.children) child.load();
        this.onload();
    }
    onload() {}
    unload() {
        this.loaded = false;
        while (this.children.length) this.children.pop()!.unload();
        while (this.onUnloadCallbacks.length) this.onUnloadCallbacks.pop()!();
        this.onunload();
    }
    onunload() {}
    addChild<T extends Component>(child: T): T {
        this.children.push(child);
        if (this.loaded) child.load();
        return child;
    }
    removeChild<T extends Component>(child: T): T {
        const i = this.children.indexOf(child);
        if (i !== -1) this.children.splice(i, 1);
        child.unload();
        return child;
    }
    register(cb: () => unknown) {
        this.onUnloadCallbacks.push(cb);
    }
}

export class Scope {
    register() {
        return {};
    }
    unregister() {}
}

/**
 * Records what was asked to be rendered instead of running Obsidian's
 * markdown pipeline. Tests read `MarkdownRenderer.calls`.
 */
export const MarkdownRenderer = {
    calls: [] as Array<{ markdown: string; sourcePath: string }>,
    render(
        _app: unknown,
        markdown: string,
        _el: unknown,
        sourcePath: string,
        _component: unknown,
    ): Promise<void> {
        MarkdownRenderer.calls.push({ markdown, sourcePath });
        return Promise.resolve();
    },
    reset() {
        MarkdownRenderer.calls.length = 0;
    },
};
