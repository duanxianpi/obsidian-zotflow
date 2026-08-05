/**
 * An in-memory Obsidian `App` — vault, adapter and metadata cache.
 *
 * This is the piece that unblocks main-thread testing. Everything under
 * `src/utils/file.ts`, `src/ui/reader/local-data-manager.ts` and the
 * `services/*` layer reaches Obsidian through an `App`, so until now none of it
 * could run in the Node suite at all.
 *
 * ## The one design decision that matters
 *
 * `vault` and `vault.adapter` are **two views of a single store**, not two
 * stores. Obsidian's vault tree does not contain paths with a dot-prefixed
 * segment — `.zotflow/cache.json` is invisible to `getAbstractFileByPath` but
 * perfectly readable through the adapter — and that asymmetry is the entire
 * reason `utils/file.ts` has a hidden-path branch in every function. Faking the
 * two sides independently would make the branch that most needs testing
 * untestable, because a write through one view would not be visible to the
 * other. Here `writeFile` puts the bytes in one map and the two views disagree
 * only about what they will admit to seeing, exactly as they do in Obsidian.
 *
 * `TFile`/`TFolder` come from `tests/stubs/obsidian`, which is what the `obsidian`
 * specifier resolves to under vitest — so the `instanceof` checks in the code
 * under test are the real ones, against the real classes it imported.
 *
 * ## Known fidelity limits
 *
 * - `normalizePath` is the stub's approximation. It folds backslashes and
 *   collapses repeated slashes, but unlike Obsidian it does not strip leading or
 *   trailing slashes. Do not write tests that turn on that difference.
 * - The metadata cache is declarative: nothing parses frontmatter out of file
 *   content. Set it with `setFrontmatter`/`link` and keep it consistent with the
 *   files you created, the way Obsidian's indexer eventually would.
 * - No events. Nothing fires `vault.on("rename")`; a test that cares about
 *   `main.ts`'s rename plumbing must call the handler itself.
 * - `vault`/`adapter`/`metadataCache` build a fresh object per access, so
 *   `vi.spyOn(app.vault, "create")` patches a throwaway and does nothing. Use
 *   the `failWrites` option (or add a switch) instead of spying.
 */
import { TFile, TFolder, normalizePath } from "../stubs/obsidian";

/** One stored file. Text and binary live in the same map, tagged. */
interface StoredFile {
    text?: string;
    binary?: ArrayBuffer;
}

/** True when any segment starts with a dot — invisible to the vault tree. */
function isHidden(path: string): boolean {
    return path.split("/").some((seg) => seg.startsWith("."));
}

function parentOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i === -1 ? "" : path.slice(0, i);
}

function makeTFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    const name = path.slice(path.lastIndexOf("/") + 1);
    file.name = name;
    const dot = name.lastIndexOf(".");
    file.extension = dot === -1 ? "" : name.slice(dot + 1);
    file.basename = dot === -1 ? name : name.slice(0, dot);
    return file;
}

function makeTFolder(path: string): TFolder {
    const folder = new TFolder();
    folder.path = path;
    folder.name = path.slice(path.lastIndexOf("/") + 1);
    return folder;
}

export interface FakeAppOptions {
    /**
     * Make `adapter.trashSystem` report failure so the `trashLocal` fallback
     * runs. Mirrors a platform with no OS trash (mobile, some Linux setups).
     */
    trashSystemFails?: boolean;
    /** Make `adapter.trashSystem` throw rather than return false. */
    trashSystemThrows?: boolean;
    /**
     * Reject every write — `vault.create`/`modify` and `adapter.write` alike.
     * Models a full disk or a permission failure, so callers that are meant
     * to log and carry on can be tested without monkey-patching the surface.
     */
    failWrites?: boolean;
}

export class FakeObsidianApp {
    /** path -> contents. The single source of truth for both views. */
    private files = new Map<string, StoredFile>();
    private folders = new Set<string>();
    /** Stable identities, so repeated lookups return the same object. */
    private tfiles = new Map<string, TFile>();
    private tfolders = new Map<string, TFolder>();

    /** path -> frontmatter, as the metadata cache would eventually report it. */
    private frontmatter = new Map<string, Record<string, unknown>>();
    /** sourcePath -> { destPath: count }, mirroring `metadataCache.resolvedLinks`. */
    private links: Record<string, Record<string, number>> = {};
    private tags: Record<string, number> = {};

    /** Every mutating adapter call, in order — for asserting the write path. */
    readonly adapterCalls: string[] = [];
    /** Every mutating vault call, in order. */
    readonly vaultCalls: string[] = [];
    /** Paths sent to the system trash and the local trash, separately. */
    readonly trashed = {
        system: [] as string[],
        local: [] as string[],
        /** Sent via `fileManager.trashFile`, which picks the bin itself. */
        preferred: [] as string[],
    };
    /** Every `fileManager.generateMarkdownLink` call, in order. */
    readonly generatedLinks: { path: string; alias?: string }[] = [];

    constructor(private options: FakeAppOptions = {}) {}

    /* ============================================================ */
    /*  Test-side seeding and inspection                            */
    /* ============================================================ */

    /** Seed or overwrite a text file, creating parent folders. */
    writeFile(path: string, text: string): this {
        const p = normalizePath(path);
        this.ensureFolderChain(parentOf(p));
        this.files.set(p, { text });
        return this;
    }

    writeBinaryFile(path: string, binary: ArrayBuffer): this {
        const p = normalizePath(path);
        this.ensureFolderChain(parentOf(p));
        this.files.set(p, { binary });
        return this;
    }

    /** Seed a folder (and its ancestors). */
    mkdirp(path: string): this {
        this.ensureFolderChain(normalizePath(path));
        return this;
    }

    /** What is actually on "disk" — both views, no filtering. */
    read(path: string): string | undefined {
        return this.files.get(normalizePath(path))?.text;
    }

    readBinary(path: string): ArrayBuffer | undefined {
        return this.files.get(normalizePath(path))?.binary;
    }

    has(path: string): boolean {
        const p = normalizePath(path);
        return this.files.has(p) || this.folders.has(p);
    }

    /** Every file path present, sorted — handy for whole-tree assertions. */
    paths(): string[] {
        return [...this.files.keys()].sort();
    }

    /** Attach frontmatter the metadata cache will report for `path`. */
    setFrontmatter(path: string, fm: Record<string, unknown>): this {
        this.frontmatter.set(normalizePath(path), fm);
        return this;
    }

    /** Record a resolved link `from` -> `to`, as Obsidian's indexer would. */
    link(from: string, to: string): this {
        const f = normalizePath(from);
        const t = normalizePath(to);
        this.links[f] ??= {};
        this.links[f][t] = (this.links[f][t] ?? 0) + 1;
        return this;
    }

    /** Populate `metadataCache.getTags()`. Keys include the leading `#`. */
    setTags(tags: Record<string, number>): this {
        this.tags = tags;
        return this;
    }

    /**
     * Wire a local attachment to its source note the way ZotFlow does:
     * a resolved link plus the `zotflow-local-attachment` frontmatter key that
     * `getLinkedLocalSourceNote` insists on.
     */
    linkSourceNote(notePath: string, attachmentPath: string): this {
        this.writeFile(notePath, "");
        this.link(notePath, attachmentPath);
        this.setFrontmatter(notePath, {
            "zotflow-local-attachment": `[[${attachmentPath}]]`,
        });
        return this;
    }

    resetCalls(): this {
        this.adapterCalls.length = 0;
        this.vaultCalls.length = 0;
        this.trashed.system.length = 0;
        this.trashed.local.length = 0;
        this.trashed.preferred.length = 0;
        return this;
    }

    /* ============================================================ */
    /*  Internals                                                   */
    /* ============================================================ */

    private ensureFolderChain(path: string) {
        if (!path) return;
        const segments = path.split("/");
        for (let i = 1; i <= segments.length; i++) {
            this.folders.add(segments.slice(0, i).join("/"));
        }
    }

    private tfile(path: string): TFile {
        let f = this.tfiles.get(path);
        if (!f) {
            f = makeTFile(path);
            this.tfiles.set(path, f);
        }
        return f;
    }

    private tfolder(path: string): TFolder {
        let f = this.tfolders.get(path);
        if (!f) {
            f = makeTFolder(path);
            this.tfolders.set(path, f);
        }
        return f;
    }

    /* ============================================================ */
    /*  The App surface                                             */
    /* ============================================================ */

    get adapter() {
        return {
            exists: (path: string) =>
                Promise.resolve(this.has(normalizePath(path))),

            read: (path: string) => {
                const p = normalizePath(path);
                const stored = this.files.get(p);
                if (stored?.text === undefined) {
                    return Promise.reject(
                        new Error(`adapter.read: no such file ${p}`),
                    );
                }
                return Promise.resolve(stored.text);
            },

            write: (path: string, data: string) => {
                const p = normalizePath(path);
                this.adapterCalls.push(`write:${p}`);
                if (this.options.failWrites) {
                    return Promise.reject(new Error("write failed"));
                }
                this.files.set(p, { text: data });
                return Promise.resolve();
            },

            writeBinary: (path: string, data: ArrayBuffer) => {
                const p = normalizePath(path);
                this.adapterCalls.push(`writeBinary:${p}`);
                this.files.set(p, { binary: data });
                return Promise.resolve();
            },

            mkdir: (path: string) => {
                const p = normalizePath(path);
                this.adapterCalls.push(`mkdir:${p}`);
                this.folders.add(p);
                return Promise.resolve();
            },

            rename: (from: string, to: string) => {
                const a = normalizePath(from);
                const b = normalizePath(to);
                this.adapterCalls.push(`rename:${a}->${b}`);
                const stored = this.files.get(a);
                if (stored) {
                    this.files.delete(a);
                    this.files.set(b, stored);
                }
                return Promise.resolve();
            },

            trashSystem: (path: string) => {
                const p = normalizePath(path);
                this.adapterCalls.push(`trashSystem:${p}`);
                if (this.options.trashSystemThrows) {
                    throw new Error("no system trash on this platform");
                }
                if (this.options.trashSystemFails) return Promise.resolve(false);
                this.trashed.system.push(p);
                this.files.delete(p);
                return Promise.resolve(true);
            },

            trashLocal: (path: string) => {
                const p = normalizePath(path);
                this.adapterCalls.push(`trashLocal:${p}`);
                this.trashed.local.push(p);
                this.files.delete(p);
                return Promise.resolve();
            },
        };
    }

    get vault() {
        return {
            adapter: this.adapter,

            /**
             * Obsidian's vault tree excludes dot-prefixed paths, so this
             * returns null for them even though the adapter can see the file.
             */
            getAbstractFileByPath: (path: string) => {
                const p = normalizePath(path);
                if (isHidden(p)) return null;
                if (this.files.has(p)) return this.tfile(p);
                if (this.folders.has(p)) return this.tfolder(p);
                return null;
            },

            getFileByPath: (path: string) => {
                const p = normalizePath(path);
                if (isHidden(p) || !this.files.has(p)) return null;
                return this.tfile(p);
            },

            createFolder: (path: string) => {
                const p = normalizePath(path);
                this.vaultCalls.push(`createFolder:${p}`);
                this.folders.add(p);
                return Promise.resolve(this.tfolder(p));
            },

            create: (path: string, data: string) => {
                const p = normalizePath(path);
                this.vaultCalls.push(`create:${p}`);
                if (this.options.failWrites) {
                    return Promise.reject(new Error("write failed"));
                }
                this.files.set(p, { text: data });
                return Promise.resolve(this.tfile(p));
            },

            createBinary: (path: string, data: ArrayBuffer) => {
                const p = normalizePath(path);
                this.vaultCalls.push(`createBinary:${p}`);
                this.files.set(p, { binary: data });
                return Promise.resolve(this.tfile(p));
            },

            modify: (file: TFile, data: string) => {
                this.vaultCalls.push(`modify:${file.path}`);
                if (this.options.failWrites) {
                    return Promise.reject(new Error("write failed"));
                }
                this.files.set(file.path, { text: data });
                return Promise.resolve();
            },

            modifyBinary: (file: TFile, data: ArrayBuffer) => {
                this.vaultCalls.push(`modifyBinary:${file.path}`);
                this.files.set(file.path, { binary: data });
                return Promise.resolve();
            },

            read: (file: TFile) => {
                const stored = this.files.get(file.path);
                if (stored?.text === undefined) {
                    return Promise.reject(
                        new Error(`vault.read: no such file ${file.path}`),
                    );
                }
                return Promise.resolve(stored.text);
            },

            readBinary: (file: TFile) => {
                const stored = this.files.get(file.path);
                if (!stored?.binary) {
                    return Promise.reject(
                        new Error(`vault.readBinary: no such file ${file.path}`),
                    );
                }
                return Promise.resolve(stored.binary);
            },

            rename: (file: TFile, newPath: string) => {
                const to = normalizePath(newPath);
                this.vaultCalls.push(`rename:${file.path}->${to}`);
                const stored = this.files.get(file.path);
                if (stored) {
                    this.files.delete(file.path);
                    this.tfiles.delete(file.path);
                    this.files.set(to, stored);
                }
                return Promise.resolve();
            },

            trash: (file: TFile, system: boolean) => {
                this.vaultCalls.push(`trash:${file.path}:${system}`);
                (system ? this.trashed.system : this.trashed.local).push(
                    file.path,
                );
                this.files.delete(file.path);
                this.tfiles.delete(file.path);
                return Promise.resolve();
            },

            getMarkdownFiles: () =>
                [...this.files.keys()]
                    .filter((p) => !isHidden(p) && p.endsWith(".md"))
                    .map((p) => this.tfile(p)),
        };
    }

    get metadataCache() {
        return {
            // A plain property, not an accessor: an accessor's `this` would be
            // this object literal, not the instance. Handing out the reference
            // is safe because `link()` only ever mutates the map in place.
            resolvedLinks: this.links,

            getFileCache: (file: TFile) => {
                const fm = this.frontmatter.get(file.path);
                return fm ? { frontmatter: fm } : null;
            },

            getTags: () => this.tags,

            /**
             * Resolves a link target. Obsidian tries the literal path first,
             * then `.md`, then a basename match anywhere in the vault; this
             * covers the first two, which is what ZotFlow's frontmatter links
             * exercise.
             */
            getFirstLinkpathDest: (linkpath: string, _source: string) => {
                const p = normalizePath(linkpath);
                if (this.files.has(p)) return this.tfile(p);
                if (this.files.has(`${p}.md`)) return this.tfile(`${p}.md`);
                const hit = [...this.files.keys()].find(
                    (f) => f.slice(f.lastIndexOf("/") + 1) === p,
                );
                return hit ? this.tfile(hit) : null;
            },
        };
    }

    get fileManager() {
        return {
            /**
             * Obsidian sends the file to the system bin, to `.trash/`, or
             * straight out depending on the vault's own setting. The fake has
             * no such setting and does not pretend to — a test asserting which
             * bin would be asserting the one thing this API hides from callers.
             */
            trashFile: (file: TFile) => {
                this.vaultCalls.push(`trashFile:${file.path}`);
                this.trashed.preferred.push(file.path);
                this.files.delete(file.path);
                this.tfiles.delete(file.path);
                return Promise.resolve();
            },

            /**
             * Obsidian builds either a wikilink or a markdown link depending on
             * vault settings; the fake always emits the wikilink form, which is
             * enough to tell "the real API produced this" apart from a caller's
             * own hardcoded fallback string.
             */
            generateMarkdownLink: (
                file: TFile,
                _sourcePath: string,
                _subpath?: string,
                alias?: string,
            ) => {
                this.generatedLinks.push({ path: file.path, alias });
                return alias ? `[[${file.path}|${alias}]]` : `[[${file.path}]]`;
            },
        };
    }

    /** The object to hand to code that wants an Obsidian `App`. */
    get app(): any {
        return this;
    }
}

/** Convenience constructor mirroring the other fakes' style. */
export function createFakeApp(options?: FakeAppOptions): FakeObsidianApp {
    return new FakeObsidianApp(options);
}
