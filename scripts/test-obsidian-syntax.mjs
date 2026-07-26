/**
 * Obsidian syntax survival matrix: MD → HTML → MD
 *
 * Usage:
 *   node scripts/test-obsidian-syntax.mjs                # full matrix
 *   node scripts/test-obsidian-syntax.mjs callout embed  # filter by id/name
 *   node scripts/test-obsidian-syntax.mjs --verbose      # dump HTML too
 *   node scripts/test-obsidian-syntax.mjs --all          # detail every case
 */

import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const testEntry = path.resolve(root, "scripts/_test-obsidian-syntax-entry.ts");
const testOut = path.resolve(root, "scripts/_test-obsidian-syntax-out.mjs");

await esbuild.build({
    entryPoints: [testEntry],
    bundle: true,
    write: true,
    outfile: testOut,
    format: "esm",
    target: "es2020",
    platform: "node",
    conditions: ["worker"],
    external: ["obsidian"],
    banner: { js: "" },
});

const { run } = await import(`./_test-obsidian-syntax-out.mjs?t=${Date.now()}`);
await run(process.argv.slice(2));

fs.unlinkSync(testOut);
