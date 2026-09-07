import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Comlink from "comlink";
import { requestReaderSDT } from "ui/reader/sdt";
import type { DocumentWorkerService } from "worker/services/document-worker";
import { sdtCompatibility } from "enhancement-pack/compatibility";

const state = vi.hoisted(() => ({
    inspect: vi.fn(),
    generate: vi.fn(),
    notify: vi.fn(),
    log: vi.fn(),
    remote: null as Comlink.Remote<
        Pick<DocumentWorkerService, "getStructuredDocumentText">
    > | null,
}));
vi.mock("services/services", () => ({
    services: {
        enhancementPack: { inspectInstallation: state.inspect },
        notificationService: { notify: state.notify },
        logService: { error: state.log },
    },
}));
vi.mock("bridge", () => ({
    workerBridge: {
        get documentWorker() {
            return (
                state.remote ?? { getStructuredDocumentText: state.generate }
            );
        },
    },
}));

beforeEach(() => {
    vi.stubGlobal("window", {
        get fetch() {
            return globalThis.fetch;
        },
    });
    vi.resetAllMocks();
    state.remote = null;
    state.inspect.mockResolvedValue({ installed: true, version: "2.0.0" });
    state.generate.mockResolvedValue(new ArrayBuffer(4));
});
afterEach(() => vi.unstubAllGlobals());

describe("Reader SDT requests", () => {
    test("missing Pack prompts before reading the document; installing permits retry", async () => {
        const fetchFile = vi.fn(async () => new Response(new Uint8Array([1])));
        vi.stubGlobal("fetch", fetchFile);
        state.inspect.mockResolvedValueOnce({ installed: false });
        const show = vi.fn();
        const doc = {
            type: "pdf",
            data: { url: "blob:opened-snapshot", buf: null },
        } as const;
        expect(await requestReaderSDT(doc, {}, () => true, show)).toEqual({
            ok: false,
            reason: "unavailable",
        });
        expect(show).toHaveBeenCalledTimes(1);
        expect(fetchFile).not.toHaveBeenCalled();
        expect(state.generate).not.toHaveBeenCalled();
        expect(state.notify).not.toHaveBeenCalled();
        expect(await requestReaderSDT(doc, {}, () => true, show)).toMatchObject(
            { ok: true },
        );
        expect(fetchFile).toHaveBeenCalledWith("blob:opened-snapshot");
        expect(state.generate).toHaveBeenCalledTimes(1);
    });

    test.each([
        ["pdf", "application/pdf"],
        ["epub", "application/epub+zip"],
        ["snapshot", "text/html"],
    ])(
        "%s passes current bytes, password and progress through real Comlink",
        async (type, contentType) => {
            const channel = new MessageChannel();
            const api = {
                async getStructuredDocumentText(
                    buf: ArrayBuffer,
                    options: unknown,
                    progress?: (value: number) => void,
                ) {
                    expect(new Uint8Array(buf)).toEqual(
                        new Uint8Array([1, 2, 3]),
                    );
                    expect(options).toMatchObject({
                        contentType,
                        sourceHash: "0123456789abcdef0123456789abcdef",
                        password: "unlocked",
                        isPriority: true,
                    });
                    try {
                        await (
                            progress as Comlink.Remote<
                                NonNullable<typeof progress>
                            >
                        )?.(37);
                        const output = new Uint8Array([4, 5]).buffer;
                        return Comlink.transfer(output, [output]);
                    } finally {
                        (
                            progress as Comlink.Remote<
                                NonNullable<typeof progress>
                            >
                        )[Comlink.releaseProxy]();
                    }
                },
            };
            Comlink.expose(api, channel.port1);
            state.remote = Comlink.wrap<typeof api>(channel.port2);
            const original = new Uint8Array([1, 2, 3]);
            const onProgress = vi.fn();
            try {
                const result = await requestReaderSDT(
                    {
                        type,
                        data: { buf: original, url: null },
                        contentMD5: "0123456789abcdef0123456789abcdef",
                        password: "initial",
                    },
                    { password: "unlocked", onProgress },
                    () => true,
                    vi.fn(),
                );
                expect(result).toMatchObject({
                    ok: true,
                    ...sdtCompatibility.sdt,
                });
                if (result.ok)
                    expect(new Uint8Array(result.bytes)).toEqual(
                        new Uint8Array([4, 5]),
                    );
                expect(onProgress).toHaveBeenCalledWith(37);
                // Transferring the request must never detach the Reader/cache copy.
                expect(original).toEqual(new Uint8Array([1, 2, 3]));
            } finally {
                state.remote[Comlink.releaseProxy]();
                channel.port1.close();
                channel.port2.close();
            }
        },
    );

    test("closing during generation discards progress, results and notifications", async () => {
        let active = true;
        const progress = vi.fn();
        state.generate.mockImplementation(
            async (_buf, _options, report: (value: number) => void) => {
                active = false;
                report(80);
                throw new Error("late failure");
            },
        );
        const result = await requestReaderSDT(
            { type: "pdf", data: { buf: new Uint8Array([1]), url: null } },
            { onProgress: progress },
            () => active,
            vi.fn(),
        );
        expect(result).toEqual({ ok: false, reason: "unavailable" });
        expect(progress).not.toHaveBeenCalled();
        expect(state.notify).not.toHaveBeenCalled();
    });

    test("a corrupt/incompatible Pack is a failure, not an installation prompt", async () => {
        state.inspect.mockRejectedValue(
            new Error("Invalid installed Pack manifest"),
        );
        const show = vi.fn();
        expect(
            await requestReaderSDT(
                { type: "pdf", data: { buf: new Uint8Array([1]), url: null } },
                {},
                () => true,
                show,
            ),
        ).toEqual({ ok: false, reason: "failed" });
        expect(show).not.toHaveBeenCalled();
        expect(state.notify).toHaveBeenCalledTimes(1);
        expect(state.generate).not.toHaveBeenCalled();
    });
});
