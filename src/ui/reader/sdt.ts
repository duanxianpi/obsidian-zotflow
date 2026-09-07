import * as Comlink from "comlink";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { sdtCompatibility } from "enhancement-pack/compatibility";
import type {
    CreateReaderOptions,
    ParentAPI,
    ReaderSDTPackResult,
} from "types/zotero-reader";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

/**
 * Called only on SDT demand. The Reader already coalesces concurrent requests
 * and caches a successful pack, so there is no second document cache here.
 */
export async function requestReaderSDT(
    document: CreateReaderOptions,
    options: Parameters<ParentAPI["getSDTPack"]>[0],
    isActive: () => boolean,
    showInstall: () => void,
): Promise<ReaderSDTPackResult> {
    const unavailable: ReaderSDTPackResult = {
        ok: false,
        reason: "unavailable",
    };
    const contentType =
        document.type === "pdf"
            ? "application/pdf"
            : document.type === "epub"
              ? "application/epub+zip"
              : document.type === "snapshot"
                ? "text/html"
                : undefined;
    if (!contentType || !isActive()) return unavailable;

    try {
        // A disabled Pack is installed too. This checks its files, not Obsidian's
        // enabled-plugin registry, and never opens the large resource container.
        const installation =
            await services.enhancementPack.inspectInstallation();
        if (!isActive()) return unavailable;
        if (!installation.installed) {
            showInstall();
            return unavailable;
        }

        // Read the view's retained Blob URL, not the vault file again: edits on
        // disk must not change the document underneath an already open Reader.
        // Both paths create an owned copy, safe to transfer away from the UI.
        let buf: ArrayBuffer;
        if (document.data.buf) {
            buf = new Uint8Array(document.data.buf).buffer;
        } else {
            // Native fetch is required for a local Blob URL; requestUrl handles HTTP only.
            const response = await window.fetch(document.data.url);
            if (!response.ok)
                throw new ZotFlowError(
                    ZotFlowErrorCode.FILE_OPEN_FAILED,
                    "ReaderSDT",
                    "Could not read the opened document",
                );
            buf = await response.arrayBuffer();
        }
        if (!isActive()) return unavailable;

        const bytes =
            await workerBridge.documentWorker.getStructuredDocumentText(
                Comlink.transfer(buf, [buf]),
                {
                    contentType,
                    sourceHash: document.contentMD5,
                    password: options.password ?? document.password,
                    isPriority: true,
                },
                // Comlink proxies only a top-level argument. Putting this function
                // inside the options object would cause a structured-clone error.
                Comlink.proxy((progress: number) => {
                    if (isActive()) options.onProgress?.(progress);
                }),
            );
        if (!isActive()) return unavailable;
        return { ok: true, bytes, ...sdtCompatibility.sdt };
    } catch (error) {
        if (!isActive()) return unavailable;
        services.logService.error(
            "Could not prepare structured document text",
            "ReaderSDT",
            error,
        );
        services.notificationService.notify(
            "error",
            "Could not prepare reading mode. Check ZotFlow Enhancement Pack and try again.",
        );
        return { ok: false, reason: "failed" };
    }
}
