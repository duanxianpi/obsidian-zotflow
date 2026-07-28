import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
    // Resolves the `baseUrl: "src"` style imports used throughout the codebase
    // (`utils/persist-regions`, `db/db`, …) so tests import modules by the same
    // specifier the source does.
    plugins: [tsconfigPaths({ projects: ["tsconfig.json", "tests/tsconfig.json"] })],
    resolve: {
        alias: {
            // Worker code only imports Obsidian types, but main-thread modules
            // pulled in transitively may touch the runtime. Point at a stub so
            // the import resolves instead of exploding.
            obsidian: path.resolve(import.meta.dirname, "tests/stubs/obsidian.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        setupFiles: ["tests/setup.ts"],
        // Each file gets a fresh worker so the `db` singleton in one suite can
        // never leak into another.
        isolate: true,
        coverage: {
            provider: "v8",
            // Opt-in per run: `npm run test:coverage -- --coverage.include=...`
            // narrows it to whatever is being worked on. There is no global
            // threshold — the number is a map of what is untested, not a gate.
            include: ["src/**/*.ts"],
            reporter: ["text", "html"],
        },
    },
});
