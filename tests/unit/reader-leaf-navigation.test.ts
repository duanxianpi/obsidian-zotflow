import { afterEach, describe, expect, test, vi } from "vitest";
import {
    focusReaderLeaf,
    redirectDuplicateReaderLeaf,
} from "utils/reader-leaf-navigation";

import type { Workspace, WorkspaceLeaf } from "obsidian";

type LeafNavigationWorkspace = Pick<Workspace, "revealLeaf" | "setActiveLeaf">;

function leaf(detach = vi.fn()): WorkspaceLeaf {
    return { detach } as unknown as WorkspaceLeaf;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("reader leaf navigation", () => {
    test("reveals a leaf before making it the final focused leaf", async () => {
        const calls: string[] = [];
        const target = leaf();
        const workspace = {
            revealLeaf: vi.fn(async (revealed: WorkspaceLeaf) => {
                expect(revealed).toBe(target);
                calls.push("reveal");
            }),
            setActiveLeaf: vi.fn(
                (activated: WorkspaceLeaf, params?: { focus?: boolean }) => {
                    expect(activated).toBe(target);
                    expect(params).toEqual({ focus: true });
                    calls.push("activate");
                },
            ),
        } as unknown as LeafNavigationWorkspace;

        await focusReaderLeaf(workspace, target);

        expect(calls).toEqual(["reveal", "activate"]);
    });

    test("detaches a duplicate before revealing and activating the target", async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        const duplicate = leaf(
            vi.fn(() => {
                calls.push("detach");
            }),
        );
        const target = leaf();
        const workspace = {
            revealLeaf: vi.fn(async (revealed: WorkspaceLeaf) => {
                expect(revealed).toBe(target);
                calls.push("reveal");
            }),
            setActiveLeaf: vi.fn(
                (activated: WorkspaceLeaf, params?: { focus?: boolean }) => {
                    expect(activated).toBe(target);
                    expect(params).toEqual({ focus: true });
                    calls.push("activate");
                },
            ),
        } as unknown as LeafNavigationWorkspace;

        const redirect = redirectDuplicateReaderLeaf(
            workspace,
            duplicate,
            target,
        );
        expect(calls).toEqual([]);

        await vi.runOnlyPendingTimersAsync();
        await redirect;

        expect(calls).toEqual(["detach", "reveal", "activate"]);
    });

    test("does not activate the target until revealLeaf resolves", async () => {
        vi.useFakeTimers();
        let finishReveal: (() => void) | undefined;
        const revealPending = new Promise<void>((resolve) => {
            finishReveal = resolve;
        });
        const duplicate = leaf();
        const target = leaf();
        const setActiveLeaf = vi.fn();
        const workspace = {
            revealLeaf: vi.fn(() => revealPending),
            setActiveLeaf,
        } as unknown as LeafNavigationWorkspace;

        const redirect = redirectDuplicateReaderLeaf(
            workspace,
            duplicate,
            target,
        );
        await vi.runOnlyPendingTimersAsync();

        expect(setActiveLeaf).not.toHaveBeenCalled();
        finishReveal?.();
        await redirect;

        expect(setActiveLeaf).toHaveBeenCalledWith(target, { focus: true });
    });
});
