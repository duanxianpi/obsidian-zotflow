import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

/** WebDAV file download service for fetching Zotero attachments from a user-configured server. */
export class WebDavService {
    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
    ) {}

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /**
     * Download a file from WebDAV.
     * @param remotePath Relative path to the file on the WebDAV server.
     * @returns The file content as an ArrayBuffer.
     */
    async downloadFile(remotePath: string): Promise<ArrayBuffer> {
        const startedAt = Date.now();
        this.parentHost.log(
            "debug",
            "WebDAV download requested.",
            "WebDavService",
            {
                remotePath,
                hasUrl: !!this.settings.webDavUrl,
                hasUser: !!this.settings.webDavUser,
                hasPassword: !!this.settings.webdavpassword,
            },
        );

        if (
            !this.settings.webDavUrl ||
            !this.settings.webDavUser ||
            !this.settings.webdavpassword
        ) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "WebDavService",
                "WebDAV credentials not configured",
            );
        }

        // Make sure the webdav url ends with a slash (Business logic preserved)
        let baseUrl = this.settings.webDavUrl;
        if (!baseUrl.endsWith("/")) {
            baseUrl += "/";
        }
        const fullUrl = baseUrl + remotePath.replace(/^\//, ""); // Ensure single slash join
        this.parentHost.log("debug", "WebDAV URL resolved.", "WebDavService", {
            baseUrl,
            fullUrl,
        });

        const credentials = btoa(
            `${this.settings.webDavUser}:${this.settings.webdavpassword}`,
        );

        try {
            const req = {
                method: "GET",
                headers: {
                    Authorization: `Basic ${credentials}`,
                },
            };

            this.parentHost.log(
                "debug",
                "WebDAV fetch dispatching.",
                "WebDavService",
                {
                    method: req.method,
                    fullUrl,
                },
            );

            const response = await fetch(fullUrl, req);
            const responseMs = Date.now() - startedAt;
            this.parentHost.log(
                "debug",
                "WebDAV fetch completed.",
                "WebDavService",
                {
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                    elapsedMs: responseMs,
                },
            );

            if (response.ok) {
                const payload = await response.arrayBuffer();
                this.parentHost.log(
                    "debug",
                    "WebDAV payload received.",
                    "WebDavService",
                    {
                        bytes: payload.byteLength,
                        elapsedMs: Date.now() - startedAt,
                    },
                );
                return payload;
            } else {
                // Map HTTP status to ZotFlowError
                if (response.status === 401 || response.status === 403) {
                    this.parentHost.log(
                        "debug",
                        "WebDAV auth rejection received.",
                        "WebDavService",
                        {
                            status: response.status,
                            fullUrl,
                        },
                    );
                    throw new ZotFlowError(
                        ZotFlowErrorCode.AUTH_INVALID,
                        "WebDavService",
                        `WebDAV Auth Failed: ${response.status}`,
                    );
                }
                if (response.status === 404) {
                    this.parentHost.log(
                        "debug",
                        "WebDAV resource not found.",
                        "WebDavService",
                        {
                            status: response.status,
                            fullUrl,
                        },
                    );
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "WebDavService",
                        `WebDAV File Not Found: ${fullUrl}`,
                    );
                }

                this.parentHost.log(
                    "debug",
                    "WebDAV returned unexpected non-success status.",
                    "WebDavService",
                    {
                        status: response.status,
                        statusText: response.statusText,
                        fullUrl,
                    },
                );

                throw new ZotFlowError(
                    ZotFlowErrorCode.NETWORK_ERROR,
                    "WebDavService",
                    `WebDAV download failed with status: ${response.status}`,
                );
            }
        } catch (e: any) {
            this.parentHost.log(
                "debug",
                "WebDAV download raised exception.",
                "WebDavService",
                {
                    remotePath,
                    fullUrl,
                    elapsedMs: Date.now() - startedAt,
                    errorMessage: e instanceof Error ? e.message : String(e),
                },
            );
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "WebDavService",
                "WebDAV download failed",
            );
        }
    }

    async verify(url: string, user: string, pass: string): Promise<boolean> {
        if (!url || !user || !pass) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "WebDavService",
                "Missing WebDAV credentials for verification",
            );
        }

        // basic auth
        const credentials = btoa(`${user}:${pass}`);

        try {
            const req = {
                method: "PROPFIND",
                headers: {
                    Authorization: `Basic ${credentials}`,
                    Depth: "0", // Only check the root resource
                },
                throw: false,
            };

            const response = await fetch(url, req);

            if (response.status >= 200 && response.status < 300) {
                return true;
            } else {
                if (response.status === 401 || response.status === 403) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.AUTH_INVALID,
                        "WebDavService",
                        "WebDAV Verification 401/403",
                    );
                }
                if (response.status === 404) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "WebDavService",
                        "WebDAV Verification 404",
                    );
                }

                throw new ZotFlowError(
                    ZotFlowErrorCode.NETWORK_ERROR,
                    "WebDavService",
                    `WebDAV verification failed with status: ${response.status}`,
                );
            }
        } catch (e: any) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "WebDavService",
                "WebDAV Verification Network Error",
            );
        }
    }
}
