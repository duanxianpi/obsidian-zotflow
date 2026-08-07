/**
 * `utils/file.ts` — the write path for every note, sidecar and cached asset.
 *
 * It was at 1% because it needs an Obsidian `App`; `tests/fakes/obsidian-app.ts`
 * now provides one.
 *
 * Every function here forks on whether the path has a dot-prefixed segment,
 * because Obsidian's vault tree cannot see those and the DataAdapter must be
 * used instead. The fake deliberately backs both views with one store, so
 * asserting only on file *contents* would pass even with the hidden-path branch
 * deleted. These tests therefore assert **which view was used** —
 * `adapterCalls` vs `vaultCalls` — which is the actual contract.
 *
 * Mutation round: 19 of 20 anchors killed. The survivor is equivalent —
 * deleting `if (!fmLink) continue;` in `getLinkedLocalSourceNote` changes
 * nothing, because `extractPathFromLink(undefined)` returns `""` and an empty
 * linkpath resolves to null in both this fake and Obsidian itself. The guard
 * saves a resolver call, not a wrong answer.
 *
 * Two branches stay uncovered for the same reason, so coverage stops at 97% of
 * branches: `folderPath === "."` in the adapter recursion and the `!text` early
 * return in `extractPathFromLink`. Neither is reachable through the exported
 * API — upstream guards get there first.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
    checkFile,
    deleteFile,
    ensureFolderExists,
    getLinkedLocalSourceNote,
    readTextFile,
    renameFile,
    saveBinaryFile,
    saveTextFile,
} from "utils/file";

import { createFakeApp, FakeObsidianApp } from "../fakes/obsidian-app";

let app: FakeObsidianApp;

beforeEach(() => {
    app = createFakeApp();
});

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

/* ================================================================ */
/*  saveTextFile                                                    */
/* ================================================================ */

describe("saveTextFile", () => {
    it("creates a new file through the vault", async () => {
        const file = await saveTextFile(app.app, "Notes/Hello.md", "hi");

        expect(app.read("Notes/Hello.md")).toBe("hi");
        expect(app.vaultCalls).toContain("create:Notes/Hello.md");
        expect(file?.path).toBe("Notes/Hello.md");
    });

    it("modifies rather than recreates an existing file", async () => {
        app.writeFile("Notes/Hello.md", "old");
        app.resetCalls();

        await saveTextFile(app.app, "Notes/Hello.md", "new");

        expect(app.read("Notes/Hello.md")).toBe("new");
        expect(app.vaultCalls).toContain("modify:Notes/Hello.md");
        expect(app.vaultCalls).not.toContain("create:Notes/Hello.md");
    });

    it("creates missing parent folders, outermost first", async () => {
        await saveTextFile(app.app, "a/b/c/Note.md", "x");

        expect(app.vaultCalls).toEqual([
            "createFolder:a",
            "createFolder:a/b",
            "createFolder:a/b/c",
            "create:a/b/c/Note.md",
        ]);
    });

    it("writes a hidden path through the adapter and reports no TFile", async () => {
        const file = await saveTextFile(app.app, ".zotflow/cache.json", "{}");

        expect(app.read(".zotflow/cache.json")).toBe("{}");
        expect(app.adapterCalls).toContain("write:.zotflow/cache.json");
        // The vault tree never learns about it, so there is nothing to return.
        expect(file).toBeNull();
        expect(app.vaultCalls).toEqual([]);
    });

    it("treats a dot segment anywhere in the path as hidden", async () => {
        await saveTextFile(app.app, "Papers/.hidden/x.json", "{}");
        expect(app.adapterCalls).toContain("write:Papers/.hidden/x.json");
        expect(app.vaultCalls).toEqual([]);
    });

    it("refuses to overwrite a folder with a file", async () => {
        app.mkdirp("Notes/Hello.md");

        await expect(
            saveTextFile(app.app, "Notes/Hello.md", "x"),
        ).rejects.toThrow(/occupied by a folder/);
    });
});

describe("saveBinaryFile", () => {
    it("creates through the vault's binary API", async () => {
        await saveBinaryFile(app.app, "Assets/img.png", bytes(1, 2, 3));

        expect(app.vaultCalls).toContain("createBinary:Assets/img.png");
        expect(new Uint8Array(app.readBinary("Assets/img.png")!)).toEqual(
            new Uint8Array([1, 2, 3]),
        );
    });

    it("modifies an existing binary file", async () => {
        app.writeBinaryFile("Assets/img.png", bytes(1));
        app.resetCalls();

        await saveBinaryFile(app.app, "Assets/img.png", bytes(9));

        expect(app.vaultCalls).toContain("modifyBinary:Assets/img.png");
    });

    it("writes a hidden binary path through the adapter", async () => {
        await saveBinaryFile(app.app, ".zotflow/cache/f.pdf", bytes(7));

        expect(app.adapterCalls).toContain("writeBinary:.zotflow/cache/f.pdf");
        expect(app.vaultCalls).toEqual([]);
    });
});

/* ================================================================ */
/*  ensureFolderExists                                              */
/* ================================================================ */

describe("ensureFolderExists", () => {
    it("creates the whole chain", async () => {
        await ensureFolderExists(app.app, "a/b/c");
        expect(app.vaultCalls).toEqual([
            "createFolder:a",
            "createFolder:a/b",
            "createFolder:a/b/c",
        ]);
    });

    it("is a no-op when the folder already exists", async () => {
        app.mkdirp("a/b");
        app.resetCalls();

        await ensureFolderExists(app.app, "a/b");
        expect(app.vaultCalls).toEqual([]);
    });

    it("throws when a file occupies the folder's path", async () => {
        app.writeFile("a/b", "i am a file");

        await expect(ensureFolderExists(app.app, "a/b")).rejects.toThrow(
            /already exists and is not a folder/,
        );
    });

    it.each(["", "/"])("does nothing for %s", async (path) => {
        await ensureFolderExists(app.app, path);
        expect(app.vaultCalls).toEqual([]);
        expect(app.adapterCalls).toEqual([]);
    });

    it("creates a hidden chain through the adapter, deepest last", async () => {
        await ensureFolderExists(app.app, ".zotflow/cache/img");

        expect(app.adapterCalls).toEqual([
            "mkdir:.zotflow",
            "mkdir:.zotflow/cache",
            "mkdir:.zotflow/cache/img",
        ]);
        expect(app.vaultCalls).toEqual([]);
    });

    it("skips hidden folders that already exist", async () => {
        app.mkdirp(".zotflow/cache");
        app.resetCalls();

        await ensureFolderExists(app.app, ".zotflow/cache");
        expect(app.adapterCalls).toEqual([]);
    });
});

/* ================================================================ */
/*  checkFile                                                       */
/* ================================================================ */

describe("checkFile", () => {
    it("reports an existing file and its frontmatter", async () => {
        app.writeFile("Notes/A.md", "x").setFrontmatter("Notes/A.md", {
            "zotero-key": "ABC",
        });

        expect(await checkFile(app.app, "Notes/A.md")).toEqual({
            exists: true,
            path: "Notes/A.md",
            frontmatter: { "zotero-key": "ABC" },
        });
    });

    it("omits frontmatter when the cache has none", async () => {
        app.writeFile("Notes/A.md", "x");

        const result = await checkFile(app.app, "Notes/A.md");
        expect(result.exists).toBe(true);
        expect(result.frontmatter).toBeUndefined();
    });

    it("reports a missing file", async () => {
        expect(await checkFile(app.app, "Notes/Nope.md")).toEqual({
            exists: false,
            path: "Notes/Nope.md",
        });
    });

    it("does not mistake a folder for a file", async () => {
        app.mkdirp("Notes");
        expect((await checkFile(app.app, "Notes")).exists).toBe(false);
    });

    it("checks a hidden path through the adapter, with no frontmatter", async () => {
        app.writeFile(".zotflow/cache.json", "{}");

        const result = await checkFile(app.app, ".zotflow/cache.json");
        expect(result).toEqual({
            exists: true,
            path: ".zotflow/cache.json",
        });
        // No metadata cache for hidden files, so the key must be absent.
        expect("frontmatter" in result).toBe(false);
    });

    it("reports a missing hidden path", async () => {
        expect((await checkFile(app.app, ".zotflow/none.json")).exists).toBe(
            false,
        );
    });
});

/* ================================================================ */
/*  readTextFile                                                    */
/* ================================================================ */

describe("readTextFile", () => {
    it("reads through the vault", async () => {
        app.writeFile("Notes/A.md", "hello");
        expect(await readTextFile(app.app, "Notes/A.md")).toBe("hello");
    });

    it("returns null for a missing file rather than throwing", async () => {
        expect(await readTextFile(app.app, "Notes/None.md")).toBeNull();
    });

    it("returns null for a folder", async () => {
        app.mkdirp("Notes");
        expect(await readTextFile(app.app, "Notes")).toBeNull();
    });

    it("reads a hidden path through the adapter", async () => {
        app.writeFile(".zotflow/cache.json", '{"a":1}');
        expect(await readTextFile(app.app, ".zotflow/cache.json")).toBe(
            '{"a":1}',
        );
    });

    it("returns null for a missing hidden path", async () => {
        // Must check existence first — the adapter rejects on a missing read.
        expect(await readTextFile(app.app, ".zotflow/none.json")).toBeNull();
    });

    it("round-trips what saveTextFile wrote, hidden or not", async () => {
        await saveTextFile(app.app, "Notes/A.md", "visible");
        await saveTextFile(app.app, ".zotflow/a.json", "hidden");

        expect(await readTextFile(app.app, "Notes/A.md")).toBe("visible");
        expect(await readTextFile(app.app, ".zotflow/a.json")).toBe("hidden");
    });
});

/* ================================================================ */
/*  renameFile                                                      */
/* ================================================================ */

describe("renameFile", () => {
    it("renames through the vault", async () => {
        app.writeFile("Notes/A.md", "x");
        app.resetCalls();

        await renameFile(app.app, "Notes/A.md", "Notes/B.md");

        expect(app.vaultCalls).toContain("rename:Notes/A.md->Notes/B.md");
        expect(app.read("Notes/B.md")).toBe("x");
        expect(app.has("Notes/A.md")).toBe(false);
    });

    it("does nothing when the paths are equal", async () => {
        app.writeFile("Notes/A.md", "x");
        app.resetCalls();

        await renameFile(app.app, "Notes/A.md", "Notes/A.md");
        expect(app.vaultCalls).toEqual([]);
        expect(app.adapterCalls).toEqual([]);
    });

    it("creates the destination's parent folder first", async () => {
        app.writeFile("A.md", "x");
        app.resetCalls();

        await renameFile(app.app, "A.md", "Deep/Nest/A.md");

        expect(app.vaultCalls).toEqual([
            "createFolder:Deep",
            "createFolder:Deep/Nest",
            "rename:A.md->Deep/Nest/A.md",
        ]);
    });

    it("uses the adapter when the source is hidden", async () => {
        app.writeFile(".zf/a.json", "x");
        app.resetCalls();

        await renameFile(app.app, ".zf/a.json", "Visible/a.json");

        expect(app.adapterCalls).toContain(
            "rename:.zf/a.json->Visible/a.json",
        );
        expect(app.read("Visible/a.json")).toBe("x");
    });

    it("uses the adapter when only the destination is hidden", async () => {
        app.writeFile("Visible/a.json", "x");
        app.resetCalls();

        await renameFile(app.app, "Visible/a.json", ".zf/a.json");

        expect(app.adapterCalls).toContain(
            "rename:Visible/a.json->.zf/a.json",
        );
    });

    it("is quiet when the source does not exist", async () => {
        await renameFile(app.app, "Notes/None.md", "Notes/B.md");
        expect(app.has("Notes/B.md")).toBe(false);

        await renameFile(app.app, ".zf/none.json", ".zf/b.json");
        expect(app.has(".zf/b.json")).toBe(false);
    });
});

/* ================================================================ */
/*  deleteFile                                                      */
/* ================================================================ */

describe("deleteFile", () => {
    it("trashes a vault file the way the user configured", async () => {
        app.writeFile("Notes/A.md", "x");

        await deleteFile(app.app, "Notes/A.md");

        // Through FileManager, so the vault's deletion preference picks the
        // destination. Going via `vault.trash` would force the system bin on a
        // user who asked for `.trash/`.
        expect(app.vaultCalls).toContain("trashFile:Notes/A.md");
        expect(app.trashed.preferred).toEqual(["Notes/A.md"]);
        expect(app.has("Notes/A.md")).toBe(false);
    });

    it("is a no-op for a missing file", async () => {
        await deleteFile(app.app, "Notes/None.md");
        expect(app.vaultCalls).toEqual([]);
    });

    it("does not delete a folder", async () => {
        app.mkdirp("Notes");
        await deleteFile(app.app, "Notes");
        expect(app.vaultCalls).toEqual([]);
    });

    it("prefers the system trash for a hidden path", async () => {
        app.writeFile(".zf/a.json", "x");
        app.resetCalls();

        await deleteFile(app.app, ".zf/a.json");

        expect(app.adapterCalls).toEqual(["trashSystem:.zf/a.json"]);
        expect(app.trashed.local).toEqual([]);
    });

    it("falls back to the local trash when the system trash declines", async () => {
        app = createFakeApp({ trashSystemFails: true });
        app.writeFile(".zf/a.json", "x");
        app.resetCalls();

        await deleteFile(app.app, ".zf/a.json");

        expect(app.adapterCalls).toEqual([
            "trashSystem:.zf/a.json",
            "trashLocal:.zf/a.json",
        ]);
        expect(app.trashed.local).toEqual([".zf/a.json"]);
    });

    it("falls back to the local trash when the system trash throws", async () => {
        app = createFakeApp({ trashSystemThrows: true });
        app.writeFile(".zf/a.json", "x");
        app.resetCalls();

        await deleteFile(app.app, ".zf/a.json");

        expect(app.trashed.local).toEqual([".zf/a.json"]);
    });

    it("is a no-op for a missing hidden path", async () => {
        await deleteFile(app.app, ".zf/none.json");
        expect(app.adapterCalls).toEqual([]);
    });
});

/* ================================================================ */
/*  getLinkedLocalSourceNote                                        */
/* ================================================================ */

describe("getLinkedLocalSourceNote", () => {
    const attachment = {
        path: "Papers/paper.pdf",
        name: "paper.pdf",
        extension: "pdf",
        basename: "paper",
    };

    it("finds the note that links to the attachment and declares it", () => {
        app.writeFile("Papers/paper.pdf", "");
        app.linkSourceNote("Sources/Paper.md", "Papers/paper.pdf");

        expect(getLinkedLocalSourceNote(app.app, attachment)).toEqual({
            path: "Sources/Paper.md",
            name: "Paper.md",
            extension: "md",
            basename: "Paper",
        });
    });

    it("returns null when nothing links to the attachment", () => {
        app.writeFile("Papers/paper.pdf", "");
        expect(getLinkedLocalSourceNote(app.app, attachment)).toBeNull();
    });

    it("requires a resolved link, not just the frontmatter declaration", () => {
        // Both conditions must hold. Here the note declares ownership of our
        // attachment in frontmatter, but its only resolved link goes elsewhere —
        // an unresolved frontmatter path, or a stale index. It must not win.
        //
        // Note the shape: the note has to appear in resolvedLinks at all, or the
        // loop never visits it and the guard is untested. That is why the
        // decoy link is required rather than incidental.
        app.writeFile("Papers/paper.pdf", "");
        app.writeFile("Papers/unrelated.pdf", "");
        app.writeFile("Sources/Claims.md", "");
        app.link("Sources/Claims.md", "Papers/unrelated.pdf");
        app.setFrontmatter("Sources/Claims.md", {
            "zotflow-local-attachment": "[[Papers/paper.pdf]]",
        });

        expect(getLinkedLocalSourceNote(app.app, attachment)).toBeNull();
    });

    it("ignores a note that links but omits the frontmatter key", () => {
        // A plain embed of the PDF is not a declaration of ownership.
        app.writeFile("Papers/paper.pdf", "");
        app.writeFile("Sources/Casual.md", "");
        app.link("Sources/Casual.md", "Papers/paper.pdf");

        expect(getLinkedLocalSourceNote(app.app, attachment)).toBeNull();
    });

    it("ignores a note whose frontmatter points at a different file", () => {
        app.writeFile("Papers/paper.pdf", "");
        app.writeFile("Papers/other.pdf", "");
        app.writeFile("Sources/Wrong.md", "");
        app.link("Sources/Wrong.md", "Papers/paper.pdf");
        app.setFrontmatter("Sources/Wrong.md", {
            "zotflow-local-attachment": "[[Papers/other.pdf]]",
        });

        expect(getLinkedLocalSourceNote(app.app, attachment)).toBeNull();
    });

    it("accepts a wikilink with a display alias", () => {
        app.writeFile("Papers/paper.pdf", "");
        app.writeFile("Sources/Paper.md", "");
        app.link("Sources/Paper.md", "Papers/paper.pdf");
        app.setFrontmatter("Sources/Paper.md", {
            "zotflow-local-attachment": "[[Papers/paper.pdf|The Paper]]",
        });

        expect(getLinkedLocalSourceNote(app.app, attachment)?.path).toBe(
            "Sources/Paper.md",
        );
    });

    it("accepts a bare path with no brackets", () => {
        app.writeFile("Papers/paper.pdf", "");
        app.writeFile("Sources/Paper.md", "");
        app.link("Sources/Paper.md", "Papers/paper.pdf");
        app.setFrontmatter("Sources/Paper.md", {
            "zotflow-local-attachment": "  Papers/paper.pdf  ",
        });

        expect(getLinkedLocalSourceNote(app.app, attachment)?.path).toBe(
            "Sources/Paper.md",
        );
    });

    it("skips a link whose source note is no longer in the vault", () => {
        // resolvedLinks can outlive the file it points from.
        app.writeFile("Papers/paper.pdf", "");
        app.link("Sources/Deleted.md", "Papers/paper.pdf");

        expect(getLinkedLocalSourceNote(app.app, attachment)).toBeNull();
    });

    it("ignores notes that link to some other attachment", () => {
        app.writeFile("Papers/paper.pdf", "");
        app.writeFile("Papers/decoy.pdf", "");
        app.linkSourceNote("Sources/Decoy.md", "Papers/decoy.pdf");
        app.linkSourceNote("Sources/Paper.md", "Papers/paper.pdf");

        expect(getLinkedLocalSourceNote(app.app, attachment)?.path).toBe(
            "Sources/Paper.md",
        );
    });
});
