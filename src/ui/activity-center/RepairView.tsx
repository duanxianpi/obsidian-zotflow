import React, { useState, useCallback } from "react";
import { ObsidianIcon } from "../ObsidianIcon";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type { TFile } from "obsidian";

/* ================================================================ */
/*  Types                                                           */
/* ================================================================ */

/** A single broken block reference found in the vault. */
interface BrokenRef {
    /** The vault file containing the broken wikilink. */
    file: TFile;
    /** 0-based line index of the broken link. */
    line: number;
    /** Full matched wikilink string, e.g. `[[note#^OLD|display]]`. */
    fullMatch: string;
    /** The broken block ref ID (the part after `#^`). */
    oldBlockId: string;
    /** Path of the target source note. */
    targetNotePath: string;
    /** Display text of the wikilink (after `|`). */
    displayText: string;
    /** Lines surrounding the broken link (3 before + target + 3 after). */
    contextLines: { lineNum: number; text: string; isTarget: boolean }[];
}

/** A candidate replacement for a broken ref. */
interface RepairCandidate {
    blockId: string;
    pageLabel: string;
    text: string;
    type: string;
}

/** A broken ref enriched with repair candidates. */
interface RepairItem {
    ref: BrokenRef;
    candidates: RepairCandidate[];
    /** The chosen candidate blockId (auto-selected if unique match). */
    selectedBlockId: string | null;
    /** Whether this was auto-matched with high confidence. */
    autoMatched: boolean;
}

type ViewState = "idle" | "scanning" | "results" | "repairing" | "done";

/* ================================================================ */
/*  Scan logic                                                      */
/* ================================================================ */

/**
 * Regex to match wikilinks with block refs: `[[path#^blockId|display]]` or `[[path#^blockId]]`.
 * Captures: (1) target path, (2) block ref ID, (3) display text or undefined.
 */
const WIKILINK_BLOCK_REF_RE =
    /\[\[([^#|\]]+)#\^([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g;

/** Parse page number from default citation display text like `Author (2024), p. 5`. */
function extractPageFromDisplay(display: string): string | null {
    const m = display.match(/,\s*p\.\s*(\S+)\s*$/);
    return m?.[1] ?? null;
}

/**
 * Scan the vault for broken block references targeting ZotFlow source notes.
 * Uses the IndexedDB (via worker bridge) to get authoritative annotation data
 * instead of parsing markdown.
 * Returns a list of RepairItems with candidate matches.
 */
async function scanVault(): Promise<RepairItem[]> {
    const app = services.indexService["app"];
    const indexedFiles = services.indexService.getAllIndexedFiles();
    const results: RepairItem[] = [];

    // Build lookup: normalized note path → { file, existingBlockIds, candidates }
    // existingBlockIds: set of block IDs currently in the note (from Obsidian cache)
    // candidates: annotation data from DB (authoritative)
    const sourceNoteInfo = new Map<
        string,
        {
            file: TFile;
            existingBlockIds: Set<string>;
            candidates: RepairCandidate[];
        }
    >();

    for (const [, file] of indexedFiles) {
        const cache = app.metadataCache.getFileCache(file);
        const libraryID = cache?.frontmatter?.["library-id"] as
            | number
            | undefined;
        const zoteroKey = cache?.frontmatter?.["zotero-key"] as
            | string
            | undefined;

        // Collect existing block IDs from the note's cache
        const existingBlockIds = new Set<string>(
            cache?.blocks ? Object.keys(cache.blocks) : [],
        );

        // Query DB for annotation candidates if we have the zotero key
        let candidates: RepairCandidate[] = [];
        if (zoteroKey) {
            const dbAnnotations =
                await workerBridge.dbHelper.getAnnotationCandidates(
                    libraryID ?? null,
                    zoteroKey,
                );
            candidates = dbAnnotations.map((a) => ({
                blockId: a.key,
                pageLabel: a.pageLabel,
                text: a.text,
                type: a.type,
            }));
        }

        const info = { file, existingBlockIds, candidates };
        // Store both with and without .md extension for flexible matching
        const pathNoExt = file.path.replace(/\.md$/, "");
        sourceNoteInfo.set(file.path, info);
        sourceNoteInfo.set(pathNoExt, info);
    }

    // Scan all markdown files for wikilinks with block refs
    const allFiles = app.vault.getMarkdownFiles();

    for (const file of allFiles) {
        const content = await app.vault.cachedRead(file);
        const lines = content.split("\n");
        let match: RegExpExecArray | null;
        WIKILINK_BLOCK_REF_RE.lastIndex = 0;

        while ((match = WIKILINK_BLOCK_REF_RE.exec(content)) !== null) {
            const targetPath = match[1]!;
            const blockId = match[2]!;
            const displayText = match[3] ?? "";

            // Check if this targets a ZotFlow source note
            const info = sourceNoteInfo.get(targetPath);
            if (!info) continue;

            // Check if the block ref exists in the target note
            // Obsidian normalizes block IDs to lowercase in the cache
            if (info.existingBlockIds.has(blockId.toLowerCase())) continue;

            // This is a broken reference — find candidates
            const lineIdx =
                content.substring(0, match.index).split("\n").length - 1;

            // Capture ±3 lines of context
            const ctxStart = Math.max(0, lineIdx - 3);
            const ctxEnd = Math.min(lines.length - 1, lineIdx + 3);
            const contextLines: BrokenRef["contextLines"] = [];
            for (let i = ctxStart; i <= ctxEnd; i++) {
                contextLines.push({
                    lineNum: i + 1,
                    text: lines[i] ?? "",
                    isTarget: i === lineIdx,
                });
            }

            const brokenRef: BrokenRef = {
                file,
                line: lineIdx,
                fullMatch: match[0],
                oldBlockId: blockId,
                targetNotePath: info.file.path,
                displayText,
                contextLines,
            };

            // Try to match by page number from display text
            const page = extractPageFromDisplay(displayText);
            const candidates = info.candidates;

            let selectedBlockId: string | null = null;
            let autoMatched = false;

            if (page) {
                const pageMatches = candidates.filter(
                    (c) => c.pageLabel === page,
                );
                if (pageMatches.length === 1) {
                    selectedBlockId = pageMatches[0]!.blockId;
                    autoMatched = true;
                }
            }

            results.push({
                ref: brokenRef,
                candidates,
                selectedBlockId,
                autoMatched,
            });
        }
    }

    return results;
}

/**
 * Apply a single repair: replace the old block ref with the new one in the file.
 */
async function applyRepair(
    item: RepairItem,
    newBlockId: string,
): Promise<boolean> {
    const app = services.indexService["app"];
    try {
        const oldRef = `#^${item.ref.oldBlockId}`;
        const newRef = `#^${newBlockId}`;
        await app.vault.process(item.ref.file, (content) =>
            content.replace(
                item.ref.fullMatch,
                item.ref.fullMatch.replace(oldRef, newRef),
            ),
        );
        return true;
    } catch (e) {
        services.logService.error(
            `Failed to repair block ref in ${item.ref.file.path}`,
            "RepairView",
            e,
        );
        return false;
    }
}

/* ================================================================ */
/*  Component                                                       */
/* ================================================================ */

export const RepairView: React.FC = () => {
    const [state, setState] = useState<ViewState>("idle");
    const [items, setItems] = useState<RepairItem[]>([]);
    const [repaired, setRepaired] = useState(0);
    const [failed, setFailed] = useState(0);

    const handleScan = useCallback(async () => {
        setState("scanning");
        try {
            const results = await scanVault();
            setItems(results);
            setState("results");
        } catch (e) {
            services.logService.error("Repair scan failed", "RepairView", e);
            services.notificationService.notify("error", "Repair scan failed.");
            setState("idle");
        }
    }, []);

    const handleSelectCandidate = useCallback(
        (index: number, blockId: string) => {
            setItems((prev) =>
                prev.map((item, i) =>
                    i === index
                        ? {
                              ...item,
                              selectedBlockId: blockId,
                              autoMatched: false,
                          }
                        : item,
                ),
            );
        },
        [],
    );

    const handleRepairOne = useCallback(
        async (index: number) => {
            const item = items[index];
            if (!item?.selectedBlockId) return;
            const ok = await applyRepair(item, item.selectedBlockId);
            if (ok) {
                setItems((prev) => prev.filter((_, i) => i !== index));
                setRepaired((r) => r + 1);
            } else {
                setFailed((f) => f + 1);
            }
        },
        [items],
    );

    const handleRepairAll = useCallback(async () => {
        setState("repairing");
        let ok = 0;
        let fail = 0;
        const remaining: RepairItem[] = [];

        for (const item of items) {
            if (!item.selectedBlockId) {
                remaining.push(item);
                continue;
            }
            const success = await applyRepair(item, item.selectedBlockId);
            if (success) ok++;
            else {
                fail++;
                remaining.push(item);
            }
        }

        setRepaired((r) => r + ok);
        setFailed((f) => f + fail);
        setItems(remaining);
        setState("done");
    }, [items]);

    const handleReset = useCallback(() => {
        setState("idle");
        setItems([]);
        setRepaired(0);
        setFailed(0);
    }, []);

    const autoCount = items.filter((i) => i.autoMatched).length;
    const selectedCount = items.filter((i) => i.selectedBlockId).length;

    /* ============================================================ */
    /*  Render                                                      */
    /* ============================================================ */

    return (
        <div className="zotflow-repair-view">
            {/* Header */}
            <div className="zotflow-repair-header">
                <div className="zotflow-repair-title">
                    <ObsidianIcon icon="wrench" />
                    <span>Repair Broken Block References</span>
                </div>
                <p className="zotflow-repair-description">
                    Scan the vault for broken wikilink block references
                    targeting ZotFlow source notes. This can happen when
                    annotation keys change after syncing with Zotero.
                </p>
            </div>

            {/* Controls */}
            <div className="zotflow-repair-controls">
                {(state === "idle" || state === "done") && (
                    <button className="mod-cta" onClick={() => void handleScan()}>
                        <ObsidianIcon icon="search" />
                        <span>Scan Vault</span>
                    </button>
                )}
                {state === "scanning" && (
                    <button className="mod-cta" disabled>
                        <ObsidianIcon icon="loader" />
                        <span>Scanning…</span>
                    </button>
                )}
                {state === "results" && items.length > 0 && (
                    <button
                        className="mod-cta"
                        onClick={() => void handleRepairAll()}
                        disabled={selectedCount === 0}
                    >
                        <ObsidianIcon icon="check-circle" />
                        <span>
                            Repair Selected ({selectedCount}/{items.length})
                        </span>
                    </button>
                )}
                {state === "repairing" && (
                    <button className="mod-cta" disabled>
                        <ObsidianIcon icon="loader" />
                        <span>Repairing…</span>
                    </button>
                )}
            </div>

            {/* Summary (after repairs) */}
            {(repaired > 0 || failed > 0) && (
                <div className="zotflow-repair-summary">
                    {repaired > 0 && (
                        <span className="zotflow-repair-summary-ok">
                            {repaired} repaired
                        </span>
                    )}
                    {failed > 0 && (
                        <span className="zotflow-repair-summary-fail">
                            {failed} failed
                        </span>
                    )}
                    {state === "done" && items.length === 0 && (
                        <button
                            className="clickable-icon"
                            onClick={handleReset}
                        >
                            <ObsidianIcon icon="rotate-ccw" />
                        </button>
                    )}
                </div>
            )}

            {/* Results */}
            {state === "results" && items.length === 0 && (
                <div className="zotflow-repair-empty">
                    <ObsidianIcon icon="check-circle" />
                    <span>No broken block references found.</span>
                </div>
            )}

            {(state === "results" || state === "done") && items.length > 0 && (
                <div className="zotflow-repair-results">
                    {autoCount > 0 && (
                        <div className="zotflow-repair-auto-badge">
                            {autoCount} auto-matched by page number
                        </div>
                    )}
                    <div className="zotflow-repair-table-wrapper">
                        <table className="zotflow-repair-table">
                            <thead>
                                <tr>
                                    <th>File</th>
                                    <th>Broken Ref</th>
                                    <th>Suggested Fix</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((item, idx) => (
                                    <RepairRow
                                        key={`${item.ref.file.path}:${item.ref.line}:${item.ref.oldBlockId}`}
                                        item={item}
                                        index={idx}
                                        onSelect={handleSelectCandidate}
                                        onRepair={(index) => void handleRepairOne(index)}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
};

/* ================================================================ */
/*  Row sub-component                                               */
/* ================================================================ */

const RepairRow: React.FC<{
    item: RepairItem;
    index: number;
    onSelect: (index: number, blockId: string) => void;
    onRepair: (index: number) => void;
}> = ({ item, index, onSelect, onRepair }) => {
    const { ref, candidates, selectedBlockId, autoMatched } = item;
    const fileName = ref.file.name;

    return (
        <tr className={autoMatched ? "zotflow-repair-row-auto" : ""}>
            <td className="zotflow-repair-cell-file" title={ref.file.path}>
                {fileName}
                <span className="zotflow-repair-cell-line">
                    :{ref.line + 1}
                </span>
            </td>
            <td className="zotflow-repair-cell-ref">
                <code>^{ref.oldBlockId}</code>
                {ref.displayText && (
                    <span className="zotflow-repair-cell-display">
                        {ref.displayText}
                    </span>
                )}
                <pre className="zotflow-repair-cell-context">
                    {ref.contextLines.map((cl) => {
                        return (
                            <div
                                key={cl.lineNum}
                                className={
                                    cl.isTarget
                                        ? "zotflow-repair-context-target"
                                        : ""
                                }
                            >
                                <span className="zotflow-repair-context-linenum">
                                    {cl.lineNum}
                                </span>
                                {cl.text}
                            </div>
                        );
                    })}
                </pre>
            </td>
            <td className="zotflow-repair-cell-fix">
                {candidates.length === 0 ? (
                    <span className="zotflow-repair-no-match">
                        No candidates
                    </span>
                ) : candidates.length === 1 ? (
                    <span className="zotflow-repair-single">
                        <code>^{candidates[0]!.blockId}</code>
                        <span className="u-muted">
                            {" "}
                            p.{candidates[0]!.pageLabel}
                        </span>
                    </span>
                ) : (
                    <select
                        value={selectedBlockId ?? ""}
                        onChange={(e) => onSelect(index, e.target.value)}
                        className="dropdown"
                    >
                        <option value="">— select —</option>
                        {candidates.map((c) => (
                            <option key={c.blockId} value={c.blockId}>
                                ^{c.blockId} (p.{c.pageLabel}
                                {c.text ? ` — ${c.text.slice(0, 40)}` : ""})
                            </option>
                        ))}
                    </select>
                )}
            </td>
            <td className="zotflow-repair-cell-action">
                <button
                    className="clickable-icon"
                    onClick={() => onRepair(index)}
                    disabled={!selectedBlockId}
                    title="Repair this reference"
                >
                    <ObsidianIcon icon="check" />
                </button>
            </td>
        </tr>
    );
};
