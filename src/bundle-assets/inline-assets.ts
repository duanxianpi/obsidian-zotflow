import { gunzipSync } from "fflate";
import { patchPDFJSViewerHTML } from "./patch-inlined-assets";
import resourceContext, { resourceKeys } from "virtual:reader-resources";

const mimeTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".wasm": "application/wasm",
    ".mjs": "application/javascript",
    ".js": "application/javascript",
    ".json": "application/json",
    ".txt": "text/plain",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".pfb": "application/x-font-type1",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json",
    ".bcmap": "application/octet-stream",
    ".icc": "application/vnd.iccprofile",
};

/**
 * Ungzip Base64
 */
const ungzipDataSync = (base64: string): Uint8Array => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return gunzipSync(bytes);
};

/**
 * Initialize Blob URLs
 */
function initializeBlobUrls(): Record<string, string> {
    const BLOB_URL_MAP: Record<string, string> = {};
    const BLOB_BINARY_MAP: Record<string, { type: string; data: Uint8Array }> =
        {};

    const keys = resourceKeys();

    keys.forEach((key) => {
        // Get Gzip Base64
        const gzippedBase64 = resourceContext(key);

        const fileName = key.replace("./", "");
        // Calculate MIME
        const ext = fileName.slice(fileName.lastIndexOf("."));
        const type = mimeTypes[ext] || "application/octet-stream";

        // Both sides come from the same build step, so a key with no contents
        // means the two fell out of step rather than a missing file.
        if (gzippedBase64 === undefined) {
            console.error(`No bundled contents for ${fileName}`);
            return;
        }

        try {
            // Wait for unzipping
            const decompressedData = ungzipDataSync(gzippedBase64);

            // Store in Binary Map (for patcher)
            BLOB_BINARY_MAP[fileName] = { type, data: decompressedData };

            // Create Blob URL
            const blob = new Blob([decompressedData as BlobPart], { type });
            const url = URL.createObjectURL(blob);
            BLOB_URL_MAP[fileName] = url;
        } catch (e) {
            console.error(`Failed to bundle ${fileName}`, e);
        }
    });

    // Patch viewer.html
    const patchedViewerHTML = patchPDFJSViewerHTML(
        BLOB_BINARY_MAP,
        BLOB_URL_MAP,
    );

    const htmlBlob = new Blob([patchedViewerHTML], { type: "text/html" });
    const htmlUrl = URL.createObjectURL(htmlBlob);

    BLOB_URL_MAP["pdf/web/viewer.html"] = htmlUrl;
    BLOB_URL_MAP["pdf/web/viewer.html.srcdoc"] = patchedViewerHTML;

    return BLOB_URL_MAP;
}

let _cachedBlobMapPromise: Record<string, string> | null = null;

/**
 * Singleton pattern + Promise caching to prevent repeated initialization
 */
export function getBlobUrls(): Record<string, string> {
    if (_cachedBlobMapPromise) return _cachedBlobMapPromise;

    _cachedBlobMapPromise = initializeBlobUrls();

    return _cachedBlobMapPromise;
}

/**
 * Revoke all blob URLs and clear the cache.
 * Call this on plugin unload to prevent memory leaks.
 */
export function revokeBlobUrls(): void {
    if (!_cachedBlobMapPromise) return;
    for (const url of Object.values(_cachedBlobMapPromise)) {
        try {
            URL.revokeObjectURL(url);
        } catch {
            // Ignore revocation errors
        }
    }
    _cachedBlobMapPromise = null;
}
