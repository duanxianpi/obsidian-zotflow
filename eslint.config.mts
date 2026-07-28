import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
    globalIgnores([
        "node_modules",
        "dist",
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
                    ],
                },
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".json"],
            },
        },
    },
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.{js,jsx,mjs,cjs}"],
        rules: {
            "obsidianmd/no-plugin-as-component": "off",
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
