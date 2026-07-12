import React, { useCallback, useEffect, useState } from "react";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { ObsidianIcon } from "ui/ObsidianIcon";
import { AddCslLocaleModal, AddCslStyleModal } from "ui/modals/csl-add-modal";

import type {
    Availability,
    LocaleInfo,
    StyleInfo,
    StyleUpdateReport,
} from "worker/csl";

type BadgeKind = "ready" | "resolvable" | "unavailable";

function badgeFor(a: Availability): { kind: BadgeKind; label: string } {
    switch (a.status) {
        case "ready":
            return { kind: "ready", label: "Ready" };
        case "resolvable":
            return { kind: "resolvable", label: "Resolvable" };
        case "unresolved-parent":
            return { kind: "unavailable", label: `Missing parent: ${a.parent}` };
        case "unresolved-locale":
            return { kind: "unavailable", label: `Missing locale: ${a.locale}` };
        case "missing":
            return { kind: "unavailable", label: "Missing" };
        case "invalid":
            return { kind: "unavailable", label: "Invalid" };
    }
}

function availabilityTooltip(a: Availability): string | undefined {
    return a.status === "invalid" ? a.reason : undefined;
}

const Badge: React.FC<{ availability: Availability }> = ({ availability }) => {
    const badge = badgeFor(availability);
    return (
        <span
            className={`zotflow-csl-badge zotflow-csl-badge-${badge.kind}`}
            title={availabilityTooltip(availability)}
        >
            {badge.label}
        </span>
    );
};

function fmtDate(ms: number): string {
    return new Date(ms).toLocaleDateString();
}

function updateSummary(id: string, report: StyleUpdateReport): string {
    if (report.failed.length > 0) {
        return `"${id}": update incomplete — failed: ${report.failed
            .map((f) => f.id)
            .join(", ")}`;
    }
    if (report.updated.length === 0) {
        return `"${id}" is already up to date`;
    }
    return `Updated ${report.updated.join(", ")}`;
}

/** CSL tab: manage citation styles and locales for the CSL renderer. */
export const CslStylesView: React.FC = () => {
    const [styles, setStyles] = useState<StyleInfo[]>([]);
    const [locales, setLocales] = useState<LocaleInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const [styleList, localeList] = await Promise.all([
                workerBridge.cslRender.listStyles(),
                workerBridge.cslRender.listLocales(),
            ]);
            setStyles(styleList);
            setLocales(localeList);
        } catch (e) {
            services.logService.error(
                "Failed to load CSL styles/locales",
                "CslStylesView",
                e,
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const openAddStyle = useCallback(() => {
        new AddCslStyleModal(services.app, () => void refresh()).open();
    }, [refresh]);

    const openAddLocale = useCallback(() => {
        new AddCslLocaleModal(services.app, () => void refresh()).open();
    }, [refresh]);

    const handleResolveDeps = useCallback(
        async (id: string) => {
            setBusy(true);
            try {
                const avail = await workerBridge.cslRender.resolveDeps(id);
                services.notificationService.notify(
                    avail.status === "ready" ? "success" : "warning",
                    avail.status === "ready"
                        ? `"${id}" is ready`
                        : `"${id}" still has unresolved dependencies`,
                );
                await refresh();
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleUpdateStyle = useCallback(
        async (id: string) => {
            setBusy(true);
            try {
                const report = await workerBridge.cslRender.updateStyle(id);
                services.notificationService.notify(
                    report.failed.length > 0 ? "warning" : "success",
                    updateSummary(id, report),
                );
                await refresh();
            } catch (e) {
                services.logService.error(
                    `Failed to update style ${id}`,
                    "CslStylesView",
                    e,
                );
                services.notificationService.notify(
                    "error",
                    `Failed to update "${id}".`,
                );
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleRemoveStyle = useCallback(
        async (style: StyleInfo) => {
            setBusy(true);
            try {
                await workerBridge.cslRender.removeStyle(style.id);
                services.notificationService.notify(
                    "success",
                    `Removed style "${style.id}"`,
                );
                await refresh();
            } catch (e) {
                services.logService.error(
                    `Failed to remove style ${style.id}`,
                    "CslStylesView",
                    e,
                );
                services.notificationService.notify(
                    "error",
                    `Could not remove "${style.id}".`,
                );
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleUpdateLocale = useCallback(
        async (tag: string) => {
            setBusy(true);
            try {
                const { updated } =
                    await workerBridge.cslRender.updateLocale(tag);
                services.notificationService.notify(
                    "success",
                    updated
                        ? `Locale "${tag}" updated`
                        : `Locale "${tag}" is already up to date`,
                );
                await refresh();
            } catch (e) {
                services.logService.error(
                    `Failed to update locale ${tag}`,
                    "CslStylesView",
                    e,
                );
                services.notificationService.notify(
                    "error",
                    `Failed to update locale "${tag}".`,
                );
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleRemoveLocale = useCallback(
        async (tag: string) => {
            setBusy(true);
            try {
                await workerBridge.cslRender.removeLocale(tag);
                await refresh();
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    return (
        <div className="zotflow-csl-view">
            {/* ── Styles ── */}
            <div className="zotflow-csl-section zotflow-csl-section--styles">
                <div className="zotflow-csl-section-header">
                    <span>Styles</span>
                    <button
                        className="clickable-icon"
                        aria-label="Add style"
                        onClick={openAddStyle}
                    >
                        <ObsidianIcon icon="plus" />
                    </button>
                </div>

                <div className="zotflow-csl-list">
                    {loading && (
                        <div className="zotflow-csl-empty">
                            <ObsidianIcon
                                icon="loader"
                                className="zotflow-spin"
                            />
                            <span>Loading…</span>
                        </div>
                    )}
                    {!loading && styles.length === 0 && (
                        <div className="zotflow-csl-empty">
                            <ObsidianIcon icon="info" />
                            <span>
                                No styles yet — click + and enter a style id
                                from zotero.org/styles.
                            </span>
                        </div>
                    )}
                    {styles.map((style) => (
                    <div className="zotflow-csl-row" key={style.id}>
                        <div className="zotflow-csl-row-info">
                            <div className="zotflow-csl-row-title">
                                {style.title ?? style.id}
                            </div>
                            <div
                                className="zotflow-csl-row-meta"
                                title={style.remote?.sourceUrl}
                            >
                                {[
                                    style.id,
                                    style.source,
                                    style.dependent && style.parent
                                        ? `parent: ${style.parent}`
                                        : null,
                                    style.remote
                                        ? `fetched ${fmtDate(style.remote.fetchedAt)}`
                                        : null,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </div>
                        </div>
                        <Badge availability={style.availability} />
                        {style.availability.status === "resolvable" && (
                            <button
                                disabled={busy}
                                onClick={() => void handleResolveDeps(style.id)}
                            >
                                Download dependencies
                            </button>
                        )}
                        {style.source === "remote-cache" && (
                            <button
                                className="clickable-icon"
                                aria-label={`Update ${style.id} and its dependencies`}
                                disabled={busy}
                                onClick={() => void handleUpdateStyle(style.id)}
                            >
                                <ObsidianIcon icon="refresh-cw" />
                            </button>
                        )}
                        {style.source === "folder" ? (
                            <span
                                className="zotflow-csl-muted"
                                title="Folder styles are files in your vault — delete the file to remove"
                            >
                                folder
                            </span>
                        ) : (
                            <button
                                className="clickable-icon"
                                aria-label={`Remove ${style.id}`}
                                disabled={busy}
                                onClick={() => void handleRemoveStyle(style)}
                            >
                                <ObsidianIcon icon="trash-2" />
                            </button>
                        )}
                    </div>
                    ))}
                </div>
            </div>

            {/* ── Locales ── */}
            <div className="zotflow-csl-section zotflow-csl-section--locales">
                <div className="zotflow-csl-section-header">
                    <span>Locales</span>
                    <button
                        className="clickable-icon"
                        aria-label="Add locale"
                        onClick={openAddLocale}
                    >
                        <ObsidianIcon icon="plus" />
                    </button>
                </div>

                <div className="zotflow-csl-list">
                    {locales.map((locale) => (
                    <div className="zotflow-csl-row" key={locale.tag}>
                        <div className="zotflow-csl-row-info">
                            <div className="zotflow-csl-row-title">
                                {locale.tag}
                            </div>
                            <div
                                className="zotflow-csl-row-meta"
                                title={locale.sourceUrl}
                            >
                                {locale.source === "builtin"
                                    ? "bundled"
                                    : locale.source === "folder"
                                      ? "from styles folder"
                                      : [
                                            "downloaded",
                                            locale.fetchedAt
                                                ? `fetched ${fmtDate(locale.fetchedAt)}`
                                                : null,
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                            </div>
                        </div>
                        {locale.source === "remote-cache" ? (
                            <>
                                <button
                                    className="clickable-icon"
                                    aria-label={`Update ${locale.tag}`}
                                    disabled={busy}
                                    onClick={() =>
                                        void handleUpdateLocale(locale.tag)
                                    }
                                >
                                    <ObsidianIcon icon="refresh-cw" />
                                </button>
                                <button
                                    className="clickable-icon"
                                    aria-label={`Remove ${locale.tag}`}
                                    disabled={busy}
                                    onClick={() =>
                                        void handleRemoveLocale(locale.tag)
                                    }
                                >
                                    <ObsidianIcon icon="trash-2" />
                                </button>
                            </>
                        ) : (
                            <span className="zotflow-csl-muted">
                                {locale.source === "builtin"
                                    ? "always available"
                                    : "folder"}
                            </span>
                        )}
                    </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
