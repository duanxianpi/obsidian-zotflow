import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
    globalIgnores([
        "node_modules",
        "dist",
        // Vitest's v8 reporter output — generated, gitignored, and its vendored
        // prettify.js/sorter.js belong to no tsconfig, so the type-aware rules
        // could only ever report them as parse errors.
        "coverage/**",
        "reader/reader/**",
        "note-editor/note-editor/**",
        "esbuild.config.mjs",
        "version-bump.mjs",
        "versions.json",
        "main.js",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
    ]),
    {
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            parserOptions: {
                projectService: {
                    allowDefaultProject: [
                        "eslint.config.mts",
                        "manifest.json",
                        "vitest.config.ts",
                        // Build/dev tooling. Deliberately outside tsconfig.json,
                        // which covers only the shipped `src` tree — but they
                        // are tracked files, so they should still be linted
                        // rather than silently skipped as parse errors.
                        "scripts/*.js",
                        "scripts/*.mjs",
                        "scripts/*.ts",
                    ],
                },
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".json"],
            },
        },
    },
    ...obsidianmd.configs.recommended,
    {
        rules: {
            // The preset ships this as `fixToUnknown: true`, which makes a bare
            // `eslint --fix` silently rewrite every `any` in the repo to
            // `unknown`. ESLint goes quiet and `tsc` breaks — the one outcome
            // worse than the warning itself. Keep the warning, drop the fixer;
            // widening an `any` is a judgement call, not a mechanical edit.
            "@typescript-eslint/no-explicit-any": [
                "warn",
                { fixToUnknown: false },
            ],
            // Obsidian's store guideline on UI capitalisation. Not a code-health
            // signal, and it can only be satisfied by editing user-visible
            // strings, so it drowns out the rules that do point at defects.
            "obsidianmd/ui/sentence-case": "off",
        },
    },
    {
        // TypeScript resolves identifiers itself, and does it with the ambient
        // declarations in `src/types` in scope. `no-undef` has neither, so on
        // `.d.ts` and `.tsx` it reports things like `Scope` and the `react-jsx`
        // runtime's `React` as undefined. Every hit is a false positive.
        files: ["**/*.{ts,tsx,mts,cts}"],
        rules: {
            "no-undef": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs}"],
        rules: {
            "obsidianmd/no-plugin-as-component": "off",
        },
    },
    {
        // Two ported files. pdf-processor.ts follows Zotero's own pdfWorker
        // manager; markdown-editor.ts follows a community plugin's embedded
        // editor and drives Obsidian's unexported CodeMirror plumbing. Both are
        // kept structurally close to their upstreams so the ports stay
        // followable, and both talk to boundaries that are untyped on the other
        // side. Typing them would mean diverging from the shape being tracked
        // for no runtime benefit.
        //
        // Declared here rather than as inline directives on purpose:
        // `eslint-comments/no-restricted-disable` deliberately forbids
        // suppressing `no-explicit-any` and the obsidianmd rules from inside a
        // file, so an exception belongs somewhere reviewable.
        files: [
            "src/worker/services/pdf-processor.ts",
            "src/ui/editor/markdown-editor.ts",
        ],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unnecessary-type-assertion": "off",
            "@typescript-eslint/no-this-alias": "off",
            "obsidianmd/no-tfile-tfolder-cast": "off",
        },
    },
    {
        // The reader bootstrap reads its own HTML back out of a `blob:` URL
        // produced by the asset inliner. `requestUrl` speaks http(s) only, so
        // there is nothing it could do with one. `app` and `localStorage` stay
        // restricted, as in the worker block below.
        files: ["src/ui/reader/bridge.ts"],
        rules: {
            // The iframe is built on `container.ownerDocument`, which is
            // already the right window's document whether or not the reader is
            // popped out. The rule suggests `doc.win.createEl`, but `createEl`
            // is declared on Element/Document and as a global — never on
            // `Window` — so its own suggestion does not typecheck.
            "obsidianmd/prefer-create-el": "off",
            "no-restricted-globals": [
                "warn",
                {
                    name: "app",
                    message:
                        "Avoid using the global app object. Instead use the reference provided by your plugin instance.",
                },
                {
                    name: "localStorage",
                    message:
                        "Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that's unique to a vault.",
                },
            ],
        },
    },
    {
        // These files build the PDF.js viewer's HTML with `DOMParser`, so the
        // document they hold is detached and belongs to no window. Obsidian's
        // `createEl` helpers hang off `Document#win`, which such a document
        // does not have — the suggested fix would throw at runtime.
        files: ["src/bundle-assets/**"],
        rules: {
            "obsidianmd/prefer-create-el": "off",
        },
    },
    {
        // `@codemirror/state` and `@codemirror/view` reach these files through
        // Obsidian's own dependency tree and are esbuild externals at build
        // time — the same reason the `tests/` block below gives. Declaring them
        // directly would pin a second copy the plugin never runs against.
        files: ["src/ui/editor/**", "src/ui/reader/**", "src/types/**"],
        rules: {
            "import/no-extraneous-dependencies": "off",
        },
    },
    {
        // `src/worker` is bundled and started as a real Web Worker
        // (`new Worker(...)` in bridge/index.ts), so `window` does not exist
        // there at all. Both of these rules are about main-thread popout
        // windows, and `prefer-window-timers` autofixes to `window.setTimeout`
        // — applying it here would leave lint clean and break the worker at
        // runtime with a ReferenceError.
        files: ["src/worker/**"],
        rules: {
            "obsidianmd/prefer-window-timers": "off",
            "obsidianmd/no-global-this": "off",
            // Same reason for `fetch`: `requestUrl` is an export of the
            // `obsidian` module, which resolves to the main thread's runtime
            // and cannot be imported here — `src/worker` imports it nowhere.
            // A request that genuinely needs Obsidian's CORS bypass goes over
            // the bridge instead (`IParentProxy.request`), which is a routing
            // decision per call site, not something a lint rule can make.
            // `app` and `localStorage` stay restricted; neither exists in a
            // worker either, so a hit there is still worth seeing.
            "no-restricted-globals": [
                "warn",
                {
                    name: "app",
                    message:
                        "Avoid using the global app object. Instead use the reference provided by your plugin instance.",
                },
                {
                    name: "localStorage",
                    message:
                        "Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that's unique to a vault.",
                },
            ],
        },
    },
    {
        // Build/dev tooling, same carve-out as `tests/` below: these run under
        // Node on a developer's machine and never reach the mobile bundle, so
        // the rules that exist to keep that bundle portable do not apply.
        files: ["scripts/**"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "obsidianmd/no-nodejs-modules": "off",
            "obsidianmd/rule-custom-message": "off",
            "no-restricted-globals": "off",
        },
    },
    {
        // Test code is not plugin code. The obsidianmd rules exist to keep the
        // shipped bundle mobile- and popout-safe; the fixtures deliberately
        // replace `globalThis.fetch` and poke at browser globals, which is the
        // whole mechanism that lets services be tested without a real Obsidian.
        // The `no-unsafe-*` family is off because assertions run against
        // untyped API payloads, where narrowing every access adds noise
        // without catching anything.
        files: ["tests/**/*.ts", "vitest.config.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // Test output IS console output: the syntax-survival matrix and the
            // fixture reports are the deliverable, not stray debug logging.
            "obsidianmd/rule-custom-message": "off",
            // `@codemirror/state` reaches tests through `obsidian`'s own tree
            // and is an esbuild external at build time. Declaring it directly
            // would pin a second copy that the plugin never runs against.
            "import/no-extraneous-dependencies": "off",
            // Build/test tooling runs in Node, never in the plugin bundle.
            "obsidianmd/no-nodejs-modules": "off",
            "obsidianmd/no-global-this": "off",
            // No popout window — and no `window` at all — in the Node runner.
            "obsidianmd/prefer-window-timers": "off",
            "no-restricted-globals": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-any": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unsafe-call": "off",
        },
    },
);
