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
        "src/main.js",
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
        files: ["src/ui/reader/bridge.ts"],
        rules: {
            // The iframe is built on `container.ownerDocument`, which is
            // already the right window's document whether or not the reader is
            // popped out. The rule suggests `doc.win.createEl`, but `createEl`
            // is declared on Element/Document and as a global — never on
            // `Window` — so its own suggestion does not typecheck.
            "obsidianmd/prefer-create-el": "off",
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
