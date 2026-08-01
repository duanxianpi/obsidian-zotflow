// Runs ESLint at `--max-warnings 0` over the paths listed in eslint-clean.txt.
//
// Kept as a script rather than an inline `npm run` one-liner so that adding a
// cleaned-up file is a one-line diff in a plain text file instead of an edit to
// an ever-growing command string.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const paths = readFileSync(join(root, "eslint-clean.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

if (paths.length === 0) {
    console.error("eslint-clean.txt lists no paths.");
    process.exit(1);
}

// `eslint/bin/eslint.js` is not in the package's `exports` map, so resolve the
// manifest instead and walk to the bin from there. Invoking it through
// `process.execPath` avoids depending on how npm shims .bin on Windows.
const require = createRequire(import.meta.url);
const eslintBin = join(dirname(require.resolve("eslint/package.json")), "bin", "eslint.js");

const { status } = spawnSync(
    process.execPath,
    [eslintBin, ...paths, "--max-warnings", "0"],
    { stdio: "inherit", cwd: root },
);

process.exit(status ?? 1);
